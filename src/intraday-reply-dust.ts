import { createHash } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import type { CanonicalTenMinuteBar, ProviderRawReply } from "./contracts";
import { decodeDust } from "./dust";
import { type ObjectHead, type ObjectMetadata, assertObjectMetadata } from "./object-store";
import { massiveTenMinuteBarsFromReply } from "./massive-provider";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_FORMAT,
  REPLY_DUST_VERSION,
  type ReplyDustBackend,
  decodeReplyDust,
  encodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";
import { assertSafeStoreFile, prepareSafeStoreDirectory, prepareSafeStoreFile, resolveSafeStoreChild } from "./store-path";

// 10-minute Reply Dust files: one exact Massive 10-minute reply per security per session, kept
// under their own path so the older deflated canonical .dust files are never touched:
//   permanent/intraday-reply-dust/YYYY-MM-DD/<base64url security id>.rdust
//   permanent/intraday-reply-dust/YYYY-MM-DD/manifest.json
// The manifest is written only after every file of the session is stored and read back.

export const INTRADAY_REPLY_DUST_PREFIX = "permanent/intraday-reply-dust";
export const INTRADAY_REPLY_DUST_MANIFEST_SCHEMA = "intraday-reply-dust-manifest-v1" as const;
export const MARKET_REPLY_DUST_PATH_ERROR = "MARKET_REPLY_DUST_PATH_INVALID";

/** Object store the writer and reader need; MemoryObjectClient and R2ObjectClient fit. */
export interface ReplyDustStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void>;
  head(key: string): Promise<ObjectHead | undefined>;
  list(prefix: string): Promise<string[]>;
}

export interface ReplyDustFileEntry {
  securityId: string;
  symbol: string;
  dataset: "stocks-aggregates-10m";
  /** Request path and query (no API key). */
  request: string;
  fetchedAt: string;
  /** observedAt the provider stamped on the canonical bars built from this reply. */
  observedAt: string;
  relativePath: string;
  byteLength: number;
  /** Byte 0 of the file: REPLY_DUST_VERSION, or REPLY_DUST_FALLBACK_VERSION for raw-zstd. */
  version: number;
  /** sha256 hex of the exact raw reply bytes. */
  replySha256: string;
  replyByteLength: number;
  /** sha256 hex of the stored file bytes. */
  fileSha256: string;
}

export interface ReplyDustSessionManifest {
  schemaVersion: typeof INTRADAY_REPLY_DUST_MANIFEST_SCHEMA;
  format: typeof REPLY_DUST_FORMAT;
  provider: string;
  sessionDate: string;
  fileCount: number;
  fallbackFileCount: number;
  files: ReplyDustFileEntry[];
  checksum: string;
}

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sessionPrefix(sessionDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  return `${INTRADAY_REPLY_DUST_PREFIX}/${sessionDate}`;
}

export function replyDustFileName(securityId: string): string {
  return `${Buffer.from(securityId, "utf8").toString("base64url")}.rdust`;
}
export function replyDustFileKey(sessionDate: string, securityId: string): string {
  return `${sessionPrefix(sessionDate)}/${replyDustFileName(securityId)}`;
}
export function replyDustManifestKey(sessionDate: string): string {
  return `${sessionPrefix(sessionDate)}/manifest.json`;
}

const SIDECAR = ".meta.json";

/**
 * Local filesystem store rooted at the market root, same key layout as the object store. Object
 * metadata lives in a "<file>.meta.json" sidecar, written before the file itself.
 */
export class FileReplyDustStore implements ReplyDustStore {
  readonly root: string;
  constructor(root: string) {
    this.root = prepareSafeStoreDirectory(root, MARKET_REPLY_DUST_PATH_ERROR);
  }
  private path(key: string): string {
    if (key.endsWith(SIDECAR) || key.includes(".tmp-")) throw new Error(MARKET_REPLY_DUST_PATH_ERROR);
    return resolveSafeStoreChild(this.root, key, MARKET_REPLY_DUST_PATH_ERROR);
  }
  private async readOptional(target: string): Promise<Buffer | undefined> {
    assertSafeStoreFile(target, MARKET_REPLY_DUST_PATH_ERROR);
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async writeAtomic(target: string, body: Uint8Array): Promise<void> {
    const prepared = prepareSafeStoreFile(target, MARKET_REPLY_DUST_PATH_ERROR);
    const temporary = `${prepared}.tmp-${process.pid}-${Date.now()}`;
    assertSafeStoreFile(temporary, MARKET_REPLY_DUST_PATH_ERROR);
    await writeFile(temporary, body, { flag: "wx" });
    assertSafeStoreFile(prepared, MARKET_REPLY_DUST_PATH_ERROR);
    await rename(temporary, prepared);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const found = await this.readOptional(this.path(key));
    return found ? new Uint8Array(found) : undefined;
  }
  async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}): Promise<void> {
    assertObjectMetadata(metadata);
    const target = this.path(key);
    await this.writeAtomic(`${target}${SIDECAR}`, new TextEncoder().encode(JSON.stringify(metadata)));
    await this.writeAtomic(target, body);
  }
  async head(key: string): Promise<ObjectHead | undefined> {
    const target = this.path(key);
    assertSafeStoreFile(target, MARKET_REPLY_DUST_PATH_ERROR);
    let size: number;
    try {
      size = (await stat(target)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const sidecar = await this.readOptional(`${target}${SIDECAR}`);
    return { size, metadata: sidecar ? (JSON.parse(sidecar.toString("utf8")) as ObjectMetadata) : {} };
  }
  async list(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf("/");
    const directoryKey = slash < 0 ? "" : prefix.slice(0, slash);
    const output: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const directory = relative
        ? resolveSafeStoreChild(this.root, relative, MARKET_REPLY_DUST_PATH_ERROR)
        : this.root;
      let names: import("node:fs").Dirent[];
      try {
        names = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of names) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(key);
        else if (entry.isFile() && !key.endsWith(SIDECAR) && !key.includes(".tmp-") && key.startsWith(prefix))
          output.push(key);
      }
    };
    await walk(directoryKey);
    return output.sort();
  }
}

/**
 * Encode a reply, decode it back, byte-compare to the reply, put it, read it back and compare.
 * Throws before the put if the decoded bytes differ. Returns the stored bytes.
 */
export async function storeVerifiedReplyDust(
  store: ReplyDustStore,
  key: string,
  body: Uint8Array,
  label: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
  metadataFor?: (encoded: Uint8Array) => ObjectMetadata,
): Promise<Uint8Array> {
  const encoded = encodeReplyDust(body, backend);
  const metadata = metadataFor ? metadataFor(encoded) : {};
  assertObjectMetadata(metadata);
  let decoded: Uint8Array;
  try {
    decoded = decodeReplyDust(encoded, backend);
  } catch (error) {
    throw new Error(`REPLY_DUST_WRITE_VERIFY_FAILED:${label}:${String(error)}`);
  }
  if (!sameBytes(decoded, body)) throw new Error(`REPLY_DUST_WRITE_VERIFY_FAILED:${label}`);
  await store.put(key, encoded, metadata);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, encoded))
    throw new Error(`REPLY_DUST_STORE_READBACK_MISMATCH:${label}`);
  if (metadataFor) {
    const head = await store.head(key);
    if (!head || JSON.stringify(sortedMetadata(head.metadata)) !== JSON.stringify(sortedMetadata(metadata)))
      throw new Error(`REPLY_DUST_METADATA_READBACK_MISMATCH:${label}`);
  }
  return encoded;
}

const sortedMetadata = (metadata: ObjectMetadata): Array<[string, string]> =>
  Object.entries(metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export const INTRADAY_REPLY_DUST_OBJECT_SCHEMA = "intraday-reply-dust-object-v1";

/** The single place a manifest entry is built, so entries rebuilt from metadata match exactly. */
function fileEntry(fields: Omit<ReplyDustFileEntry, "relativePath" | "dataset">): ReplyDustFileEntry {
  return {
    securityId: fields.securityId,
    symbol: fields.symbol,
    dataset: "stocks-aggregates-10m",
    request: fields.request,
    fetchedAt: fields.fetchedAt,
    observedAt: fields.observedAt,
    relativePath: replyDustFileName(fields.securityId),
    byteLength: fields.byteLength,
    version: fields.version,
    replySha256: fields.replySha256,
    replyByteLength: fields.replyByteLength,
    fileSha256: fields.fileSha256,
  };
}

/**
 * Object metadata carried by each .rdust object, enough to rebuild its manifest entry from the
 * store alone (file length and sha256 come from the object itself). Must fit 2 KB.
 */
export function replyDustObjectMetadata(
  provider: string,
  sessionDate: string,
  entry: ReplyDustFileEntry,
): ObjectMetadata {
  return {
    "rd-schema": INTRADAY_REPLY_DUST_OBJECT_SCHEMA,
    "rd-provider": provider,
    "rd-session-date": sessionDate,
    "rd-security-id": entry.securityId,
    "rd-symbol": entry.symbol,
    "rd-request": entry.request,
    "rd-fetched-at": entry.fetchedAt,
    "rd-observed-at": entry.observedAt,
    "rd-version": String(entry.version),
    "rd-reply-sha256": entry.replySha256,
    "rd-reply-length": String(entry.replyByteLength),
  };
}

/**
 * Store one 10-minute reply as a Reply Dust file with its object metadata. Order: encode, decode
 * back, byte-compare to the reply, check metadata fits, write, read back bytes and metadata.
 * Throws (and the caller must not advance progress) if any step fails. A raw-zstd fallback file
 * is exact too: it is written like any other file. The caller checks once per session that the
 * session is not already sealed (one manifest read per session, not per file).
 */
export async function writeReplyDustFile(
  store: ReplyDustStore,
  reply: ProviderRawReply,
  options: { provider: string; observedAt: string },
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<ReplyDustFileEntry> {
  if (reply.dataset !== "stocks-aggregates-10m" || !reply.securityId || !reply.symbol)
    throw new Error("REPLY_DUST_NOT_A_10M_REPLY");
  const { securityId, symbol } = reply;
  const key = replyDustFileKey(reply.sessionDate, securityId);
  const entryFor = (encoded: Uint8Array): ReplyDustFileEntry =>
    fileEntry({
      securityId,
      symbol,
      request: reply.request,
      fetchedAt: reply.fetchedAt,
      observedAt: options.observedAt,
      byteLength: encoded.length,
      version: encoded[0]!,
      replySha256: sha256Hex(reply.body),
      replyByteLength: reply.body.length,
      fileSha256: sha256Hex(encoded),
    });
  // A file already here is not listed in the sealed manifest (the caller checked), so it is a
  // leftover that failed verification on resume, and is replaced.
  const encoded = await storeVerifiedReplyDust(store, key, reply.body, securityId, backend, (bytes) =>
    replyDustObjectMetadata(options.provider, reply.sessionDate, entryFor(bytes)),
  );
  return entryFor(encoded);
}

/**
 * Verify a stored .rdust object and return its entry and exact reply, or undefined if it is
 * missing, has no or wrong metadata, fails to decode, or its hashes disagree. A hint (from the
 * local progress log or the manifest) saves the metadata read; the file is always verified.
 */
export async function verifyStoredReplyDust(
  store: ReplyDustStore,
  sessionDate: string,
  securityId: string,
  options: { provider: string; hint?: ReplyDustFileEntry; backend?: ReplyDustBackend },
): Promise<{ entry: ReplyDustFileEntry; reply: Uint8Array } | undefined> {
  const backend = options.backend ?? nodeReplyDustBackend;
  try {
    let expected = options.hint;
    if (!expected) {
      const head = await store.head(replyDustFileKey(sessionDate, securityId));
      if (!head) return undefined;
      const m = head.metadata;
      if (
        m["rd-schema"] !== INTRADAY_REPLY_DUST_OBJECT_SCHEMA ||
        m["rd-provider"] !== options.provider ||
        m["rd-session-date"] !== sessionDate ||
        m["rd-security-id"] !== securityId
      )
        return undefined;
      const bytes = await store.get(replyDustFileKey(sessionDate, securityId));
      if (!bytes) return undefined;
      const replyByteLength = Number(m["rd-reply-length"]);
      const version = Number(m["rd-version"]);
      if (!m["rd-symbol"] || !m["rd-request"] || !m["rd-fetched-at"] || !m["rd-observed-at"]) return undefined;
      if (!Number.isSafeInteger(replyByteLength) || !Number.isSafeInteger(version)) return undefined;
      expected = fileEntry({
        securityId,
        symbol: m["rd-symbol"],
        request: m["rd-request"],
        fetchedAt: m["rd-fetched-at"],
        observedAt: m["rd-observed-at"],
        byteLength: bytes.length,
        version,
        replySha256: m["rd-reply-sha256"] ?? "",
        replyByteLength,
        fileSha256: sha256Hex(bytes),
      });
      return { entry: expected, reply: verifyBytes(bytes, expected, backend) };
    }
    if (expected.securityId !== securityId) return undefined;
    const bytes = await store.get(replyDustFileKey(sessionDate, securityId));
    if (!bytes) return undefined;
    return { entry: expected, reply: verifyBytes(bytes, expected, backend) };
  } catch {
    return undefined;
  }
}

function verifyBytes(bytes: Uint8Array, entry: ReplyDustFileEntry, backend: ReplyDustBackend): Uint8Array {
  if (bytes.length !== entry.byteLength || bytes[0] !== entry.version || sha256Hex(bytes) !== entry.fileSha256)
    throw new Error(`REPLY_DUST_FILE_CHECKSUM_MISMATCH:${entry.securityId}`);
  const reply = decodeReplyDust(bytes, backend);
  if (reply.length !== entry.replyByteLength || sha256Hex(reply) !== entry.replySha256)
    throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${entry.securityId}`);
  return reply;
}

/** Security ids that have a .rdust object stored for the session (one list call). */
export async function listStoredReplyDust(store: ReplyDustStore, sessionDate: string): Promise<Set<string>> {
  const prefix = `${sessionPrefix(sessionDate)}/`;
  const ids = new Set<string>();
  for (const key of await store.list(prefix)) {
    const name = key.slice(prefix.length);
    if (!name.endsWith(".rdust") || name.includes("/")) continue;
    ids.add(Buffer.from(name.slice(0, -".rdust".length), "base64url").toString("utf8"));
  }
  return ids;
}

function manifestChecksum(manifest: Omit<ReplyDustSessionManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(manifest));
}

/** Seal a session after all its files are stored. Same content may be sealed again safely. */
export async function writeReplyDustManifest(
  store: ReplyDustStore,
  options: {
    provider: string;
    sessionDate: string;
    files: readonly ReplyDustFileEntry[];
    /** The existing manifest the caller already read this session (undefined = none). */
    existing?: ReplyDustSessionManifest | undefined;
  },
): Promise<ReplyDustSessionManifest> {
  const files = [...options.files].sort((a, b) => a.securityId.localeCompare(b.securityId));
  if (new Set(files.map((file) => file.securityId)).size !== files.length)
    throw new Error("REPLY_DUST_DUPLICATE_SECURITY");
  const body: Omit<ReplyDustSessionManifest, "checksum"> = {
    schemaVersion: INTRADAY_REPLY_DUST_MANIFEST_SCHEMA,
    format: REPLY_DUST_FORMAT,
    provider: options.provider,
    sessionDate: options.sessionDate,
    fileCount: files.length,
    fallbackFileCount: files.filter((file) => file.version === REPLY_DUST_FALLBACK_VERSION).length,
    files,
  };
  const manifest: ReplyDustSessionManifest = { ...body, checksum: manifestChecksum(body) };
  const key = replyDustManifestKey(options.sessionDate);
  // The caller read the manifest once at the start of the session; no second read here.
  if ("existing" in options) {
    if (options.existing) {
      if (options.existing.checksum !== manifest.checksum)
        throw new Error("REPLY_DUST_IMMUTABLE_MANIFEST_CONFLICT");
      return options.existing;
    }
  } else {
    const prior = await readReplyDustManifest(store, options.sessionDate);
    if (prior) {
      if (prior.checksum !== manifest.checksum) throw new Error("REPLY_DUST_IMMUTABLE_MANIFEST_CONFLICT");
      return prior;
    }
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const metadata = { "rd-manifest-checksum": manifest.checksum };
  await store.put(key, bytes, metadata);
  // Verify the write by size and checksum metadata (a HEAD), not a second full read.
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata["rd-manifest-checksum"] !== manifest.checksum)
    throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
  return manifest;
}

export async function readReplyDustManifest(
  store: ReplyDustStore,
  sessionDate: string,
): Promise<ReplyDustSessionManifest | undefined> {
  const bytes = await store.get(replyDustManifestKey(sessionDate));
  if (!bytes) return undefined;
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ReplyDustSessionManifest;
  const { checksum, ...body } = manifest;
  if (manifest.schemaVersion !== INTRADAY_REPLY_DUST_MANIFEST_SCHEMA || manifestChecksum(body) !== checksum)
    throw new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH");
  return manifest;
}

/** Read one stored file back to the exact raw reply bytes, checked against its manifest entry. */
export async function readReplyDustReply(
  store: ReplyDustStore,
  sessionDate: string,
  entry: ReplyDustFileEntry,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<Uint8Array> {
  const bytes = await store.get(`${sessionPrefix(sessionDate)}/${replyDustFileName(entry.securityId)}`);
  if (!bytes) throw new Error(`REPLY_DUST_FILE_MISSING:${entry.securityId}`);
  if (bytes.length !== entry.byteLength || bytes[0] !== entry.version || sha256Hex(bytes) !== entry.fileSha256)
    throw new Error(`REPLY_DUST_FILE_CHECKSUM_MISMATCH:${entry.securityId}`);
  const reply = decodeReplyDust(bytes, backend);
  if (reply.length !== entry.replyByteLength || sha256Hex(reply) !== entry.replySha256)
    throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${entry.securityId}`);
  return reply;
}

/** Rebuild canonical bars from a raw reply with the same normalizer the live fetch uses. */
export function canonicalBarsFromReply(
  provider: string,
  sessionDate: string,
  entry: Pick<ReplyDustFileEntry, "securityId" | "symbol" | "observedAt">,
  reply: Uint8Array,
): CanonicalTenMinuteBar[] {
  const parsed = JSON.parse(new TextDecoder().decode(reply)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("MASSIVE_INVALID_RESPONSE");
  return massiveTenMinuteBarsFromReply({
    provider,
    sessionDate,
    securityId: entry.securityId,
    symbol: entry.symbol,
    reply: parsed as Record<string, unknown>,
    observedAt: entry.observedAt,
  });
}

/**
 * Decode any stored 10-minute file by its leading bytes: Reply Dust v1 (1) or its raw-zstd
 * fallback (0x81) go through decodeReplyDust and the normalizer (needs the manifest entry); an
 * old deflated canonical .dust file ("DUSTV1") goes through decodeDust as before.
 */
export function decodeTenMinuteFile(
  bytes: Uint8Array,
  context?: { provider: string; sessionDate: string; entry: ReplyDustFileEntry },
  backend: ReplyDustBackend = nodeReplyDustBackend,
): CanonicalTenMinuteBar[] {
  const version = bytes[0];
  if (version === REPLY_DUST_VERSION || version === REPLY_DUST_FALLBACK_VERSION) {
    if (!context) throw new Error("REPLY_DUST_MANIFEST_ENTRY_REQUIRED");
    const reply = decodeReplyDust(bytes, backend);
    if (sha256Hex(reply) !== context.entry.replySha256)
      throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${context.entry.securityId}`);
    return canonicalBarsFromReply(context.provider, context.sessionDate, context.entry, reply);
  }
  return decodeDust(bytes).records;
}

/** Canonical bars for one security's session from its Reply Dust file, or [] if none is listed. */
export async function readReplyDustSecurityDay(
  store: ReplyDustStore,
  sessionDate: string,
  securityId: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<CanonicalTenMinuteBar[]> {
  const manifest = await readReplyDustManifest(store, sessionDate);
  if (!manifest) throw Object.assign(new Error("REPLY_DUST_MANIFEST_MISSING"), { code: "ENOENT" });
  const entry = manifest.files.find((file) => file.securityId === securityId);
  if (!entry) return [];
  const reply = await readReplyDustReply(store, sessionDate, entry, backend);
  return canonicalBarsFromReply(manifest.provider, sessionDate, entry, reply);
}
