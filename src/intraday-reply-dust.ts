import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { CanonicalTenMinuteBar, ProviderRawReply } from "./contracts";
import { decodeDust } from "./dust";
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

/** Minimal object store the writer and reader need; MemoryObjectClient and R2ObjectClient fit. */
export interface ReplyDustStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
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

/** Local filesystem store rooted at the market root, same key layout as the object store. */
export class FileReplyDustStore implements ReplyDustStore {
  readonly root: string;
  constructor(root: string) {
    this.root = prepareSafeStoreDirectory(root, MARKET_REPLY_DUST_PATH_ERROR);
  }
  private path(key: string): string {
    return resolveSafeStoreChild(this.root, key, MARKET_REPLY_DUST_PATH_ERROR);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const target = this.path(key);
    assertSafeStoreFile(target, MARKET_REPLY_DUST_PATH_ERROR);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    const target = prepareSafeStoreFile(this.path(key), MARKET_REPLY_DUST_PATH_ERROR);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    assertSafeStoreFile(temporary, MARKET_REPLY_DUST_PATH_ERROR);
    await writeFile(temporary, body, { flag: "wx" });
    assertSafeStoreFile(target, MARKET_REPLY_DUST_PATH_ERROR);
    await rename(temporary, target);
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
): Promise<Uint8Array> {
  const encoded = encodeReplyDust(body, backend);
  let decoded: Uint8Array;
  try {
    decoded = decodeReplyDust(encoded, backend);
  } catch (error) {
    throw new Error(`REPLY_DUST_WRITE_VERIFY_FAILED:${label}:${String(error)}`);
  }
  if (!sameBytes(decoded, body)) throw new Error(`REPLY_DUST_WRITE_VERIFY_FAILED:${label}`);
  await store.put(key, encoded);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, encoded))
    throw new Error(`REPLY_DUST_STORE_READBACK_MISMATCH:${label}`);
  return encoded;
}

/**
 * Store one 10-minute reply as a Reply Dust file. Order: encode, decode back, byte-compare to the
 * reply, write, read back and compare. Throws (and the caller must not advance progress) if any
 * step fails. A raw-zstd fallback file is exact too: it is written like any other file.
 */
export async function writeReplyDustFile(
  store: ReplyDustStore,
  reply: ProviderRawReply,
  observedAt: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<ReplyDustFileEntry> {
  if (reply.dataset !== "stocks-aggregates-10m" || !reply.securityId || !reply.symbol)
    throw new Error("REPLY_DUST_NOT_A_10M_REPLY");
  if (await store.get(replyDustManifestKey(reply.sessionDate)))
    throw new Error(`REPLY_DUST_SESSION_ALREADY_SEALED:${reply.sessionDate}`);
  const key = replyDustFileKey(reply.sessionDate, reply.securityId);
  // A file already here is not yet listed in any progress marker or manifest (those are checked
  // above and by the caller), so it is a leftover from a crashed attempt and is replaced.
  const encoded = await storeVerifiedReplyDust(store, key, reply.body, reply.securityId, backend);
  return {
    securityId: reply.securityId,
    symbol: reply.symbol,
    dataset: reply.dataset,
    request: reply.request,
    fetchedAt: reply.fetchedAt,
    observedAt,
    relativePath: replyDustFileName(reply.securityId),
    byteLength: encoded.length,
    version: encoded[0]!,
    replySha256: sha256Hex(reply.body),
    replyByteLength: reply.body.length,
    fileSha256: sha256Hex(encoded),
  };
}

function manifestChecksum(manifest: Omit<ReplyDustSessionManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(manifest));
}

/** Seal a session after all its files are stored. Same content may be sealed again safely. */
export async function writeReplyDustManifest(
  store: ReplyDustStore,
  options: { provider: string; sessionDate: string; files: readonly ReplyDustFileEntry[] },
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
  const existing = await store.get(key);
  if (existing) {
    const prior = JSON.parse(new TextDecoder().decode(existing)) as ReplyDustSessionManifest;
    if (prior.checksum !== manifest.checksum) throw new Error("REPLY_DUST_IMMUTABLE_MANIFEST_CONFLICT");
    return prior;
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await store.put(key, bytes);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, bytes)) throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
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
