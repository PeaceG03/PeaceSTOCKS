import type { CanonicalDailyBar, ProviderRawReply } from "./contracts";
import {
  type ReplyDustStore,
  sameBytes,
  sha256Hex,
  storeVerifiedReplyDust,
} from "./intraday-reply-dust";
import { massiveGroupedDailyBarsFromReply } from "./massive-provider";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_FORMAT,
  REPLY_DUST_VERSION,
  type ReplyDustBackend,
  decodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";

// Grouped-daily Reply Dust: the whole-market grouped daily reply (every ticker Massive returned,
// untouched) stored once per session day under its own prefix, same shape as the 10-minute layout:
//   permanent/daily-reply-dust/YYYY-MM-DD/grouped-daily.rdust
//   permanent/daily-reply-dust/YYYY-MM-DD/manifest.json
// The manifest is written only after the file is stored and read back; it seals the day.

export const DAILY_REPLY_DUST_PREFIX = "permanent/daily-reply-dust";
export const DAILY_REPLY_DUST_MANIFEST_SCHEMA = "daily-reply-dust-manifest-v1" as const;
export const DAILY_REPLY_DUST_FILE_NAME = "grouped-daily.rdust";
export const DAILY_REPLY_DUST_OBJECT_SCHEMA = "daily-reply-dust-object-v1";

export interface DailyReplyDustManifest {
  schemaVersion: typeof DAILY_REPLY_DUST_MANIFEST_SCHEMA;
  format: typeof REPLY_DUST_FORMAT;
  provider: string;
  sessionDate: string;
  dataset: "stocks-grouped-daily";
  relativePath: typeof DAILY_REPLY_DUST_FILE_NAME;
  /** Request path and query (no API key). */
  request: string;
  fetchedAt: string;
  /** observedAt the provider stamped on the canonical bars built from this reply. */
  observedAt: string;
  /** request_id of the reply (or the provider's grouped-<date> stand-in). */
  retrievalId: string;
  /** Byte 0 of the file: REPLY_DUST_VERSION, or REPLY_DUST_FALLBACK_VERSION for raw-zstd. */
  version: number;
  byteLength: number;
  fileSha256: string;
  replySha256: string;
  replyByteLength: number;
  checksum: string;
}

function dayPrefix(sessionDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  return `${DAILY_REPLY_DUST_PREFIX}/${sessionDate}`;
}
export function dailyReplyDustFileKey(sessionDate: string): string {
  return `${dayPrefix(sessionDate)}/${DAILY_REPLY_DUST_FILE_NAME}`;
}
export function dailyReplyDustManifestKey(sessionDate: string): string {
  return `${dayPrefix(sessionDate)}/manifest.json`;
}

const checksumOf = (body: Omit<DailyReplyDustManifest, "checksum">): string =>
  sha256Hex(JSON.stringify(body));

function parseReply(reply: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(reply)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("MASSIVE_INVALID_RESPONSE");
  return parsed as Record<string, unknown>;
}

/** Rebuild canonical daily bars from a raw grouped reply with getDailyBars' own normalizer. */
export function dailyBarsFromReply(input: {
  provider: string;
  sessionDate: string;
  observedAt: string;
  reply: Uint8Array;
  /** symbol -> security id, as getDailyBars builds it (see groupedDailySymbolIndex). */
  bySymbol: ReadonlyMap<string, string>;
}): CanonicalDailyBar[] {
  return massiveGroupedDailyBarsFromReply({
    provider: input.provider,
    sessionDate: input.sessionDate,
    reply: parseReply(input.reply),
    observedAt: input.observedAt,
    bySymbol: input.bySymbol,
  });
}

/**
 * Store one grouped-daily reply: encode, decode back, byte-compare, put, read back and compare,
 * then write and read back the day's manifest. A raw-zstd fallback file is stored like any other.
 */
export async function writeDailyReplyDust(
  store: ReplyDustStore,
  reply: ProviderRawReply,
  options: { provider: string; observedAt: string },
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<DailyReplyDustManifest> {
  if (reply.dataset !== "stocks-grouped-daily") throw new Error("REPLY_DUST_NOT_A_GROUPED_DAILY_REPLY");
  const manifestKey = dailyReplyDustManifestKey(reply.sessionDate);
  if (await store.get(manifestKey))
    throw new Error(`REPLY_DUST_SESSION_ALREADY_SEALED:${reply.sessionDate}`);
  const requestId = parseReply(reply.body).request_id;
  const retrievalId =
    typeof requestId === "string" && requestId.length > 0 ? requestId : `grouped-${reply.sessionDate}`;
  const replySha256 = sha256Hex(reply.body);
  // A file here without a manifest is a leftover from a crashed attempt and is replaced.
  const encoded = await storeVerifiedReplyDust(
    store,
    dailyReplyDustFileKey(reply.sessionDate),
    reply.body,
    `grouped-daily:${reply.sessionDate}`,
    backend,
    (bytes) => ({
      "rd-schema": DAILY_REPLY_DUST_OBJECT_SCHEMA,
      "rd-provider": options.provider,
      "rd-session-date": reply.sessionDate,
      "rd-dataset": "stocks-grouped-daily",
      "rd-request": reply.request,
      "rd-fetched-at": reply.fetchedAt,
      "rd-observed-at": options.observedAt,
      "rd-retrieval-id": retrievalId,
      "rd-version": String(bytes[0]),
      "rd-reply-sha256": replySha256,
      "rd-reply-length": String(reply.body.length),
    }),
  );
  const body: Omit<DailyReplyDustManifest, "checksum"> = {
    schemaVersion: DAILY_REPLY_DUST_MANIFEST_SCHEMA,
    format: REPLY_DUST_FORMAT,
    provider: options.provider,
    sessionDate: reply.sessionDate,
    dataset: "stocks-grouped-daily",
    relativePath: DAILY_REPLY_DUST_FILE_NAME,
    request: reply.request,
    fetchedAt: reply.fetchedAt,
    observedAt: options.observedAt,
    retrievalId,
    version: encoded[0]!,
    byteLength: encoded.length,
    fileSha256: sha256Hex(encoded),
    replySha256,
    replyByteLength: reply.body.length,
  };
  const manifest: DailyReplyDustManifest = { ...body, checksum: checksumOf(body) };
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await store.put(manifestKey, bytes);
  const stored = await store.get(manifestKey);
  if (!stored || !sameBytes(stored, bytes)) throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
  return manifest;
}

export async function readDailyReplyDustManifest(
  store: ReplyDustStore,
  sessionDate: string,
): Promise<DailyReplyDustManifest | undefined> {
  const bytes = await store.get(dailyReplyDustManifestKey(sessionDate));
  if (!bytes) return undefined;
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as DailyReplyDustManifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== DAILY_REPLY_DUST_MANIFEST_SCHEMA ||
    manifest.sessionDate !== sessionDate ||
    checksumOf(body) !== checksum
  )
    throw new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH");
  return manifest;
}

/** The exact raw grouped reply for a sealed day, checked against its manifest. */
export async function readDailyReplyDustReply(
  store: ReplyDustStore,
  manifest: DailyReplyDustManifest,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<Uint8Array> {
  const bytes = await store.get(dailyReplyDustFileKey(manifest.sessionDate));
  if (!bytes) throw new Error(`REPLY_DUST_FILE_MISSING:grouped-daily:${manifest.sessionDate}`);
  if (
    bytes.length !== manifest.byteLength ||
    bytes[0] !== manifest.version ||
    sha256Hex(bytes) !== manifest.fileSha256
  )
    throw new Error(`REPLY_DUST_FILE_CHECKSUM_MISMATCH:grouped-daily:${manifest.sessionDate}`);
  // decodeReplyDust picks the decoder from the version byte (1 or the 0x81 fallback).
  if (bytes[0] !== REPLY_DUST_VERSION && bytes[0] !== REPLY_DUST_FALLBACK_VERSION)
    throw new Error(`REPLY_DUST_VERSION_UNSUPPORTED:${bytes[0]}`);
  const reply = decodeReplyDust(bytes, backend);
  if (reply.length !== manifest.replyByteLength || sha256Hex(reply) !== manifest.replySha256)
    throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:grouped-daily:${manifest.sessionDate}`);
  return reply;
}

/** Canonical daily bars for a sealed day, for the securities in bySymbol. */
export async function readDailyReplyDustBars(
  store: ReplyDustStore,
  sessionDate: string,
  bySymbol: ReadonlyMap<string, string>,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<CanonicalDailyBar[]> {
  const manifest = await readDailyReplyDustManifest(store, sessionDate);
  if (!manifest) throw Object.assign(new Error("REPLY_DUST_MANIFEST_MISSING"), { code: "ENOENT" });
  const reply = await readDailyReplyDustReply(store, manifest, backend);
  return dailyBarsFromReply({
    provider: manifest.provider,
    sessionDate,
    observedAt: manifest.observedAt,
    reply,
    bySymbol,
  });
}
