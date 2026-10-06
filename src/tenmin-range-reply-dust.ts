import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalTenMinuteBar, TenMinuteRangeReply } from "./contracts";
import {
  type ReplyDustStore,
  sha256Hex,
  storeVerifiedReplyDust,
} from "./intraday-reply-dust";
import { TENMIN_RANGE_PAGE_CAP, massiveTenMinuteBarsFromReply } from "./massive-provider";
import type { ObjectMetadata } from "./object-store";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_FORMAT,
  type ReplyDustBackend,
  decodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";
import { REPLY_DUST_FALLBACK_WARNING, type ZstdVersionProbe, assertPinnedZstdForWriting } from "./reply-dust-pin";
import { prepareSafeStoreFile } from "./store-path";

// Two-month 10-minute range replies as Reply Dust, one exact Massive page per file:
//   permanent/tenmin-reply-dust/<from>_<to>/<base64url security id>.rdust        (page 1)
//   permanent/tenmin-reply-dust/<from>_<to>/<base64url security id>.p<N>.rdust   (page N >= 2)
//   permanent/tenmin-reply-dust/<from>_<to>/manifest.json
// A security counts as done only when every one of its pages is stored, read back, and its
// metadata HEAD-checked. The manifest is written after all files. The local progress log under
// transient/tenmin-range-progress/ only saves metadata reads; the store is the record.

export const TENMIN_RANGE_REPLY_DUST_PREFIX = "permanent/tenmin-reply-dust";
export const TENMIN_RANGE_OBJECT_SCHEMA = "tenmin-range-reply-dust-object-v1";
export const TENMIN_RANGE_MANIFEST_SCHEMA = "tenmin-range-reply-dust-manifest-v1" as const;
export const TENMIN_RANGE_PATH_ERROR = "TENMIN_RANGE_PATH_INVALID";

export interface TenMinRangeFileEntry {
  page: number;
  /** File name under the range prefix. */
  relativePath: string;
  /** Request path and query for this page (no API key). */
  request: string;
  fetchedAt: string;
  byteLength: number;
  /** Byte 0 of the file: REPLY_DUST_VERSION, or REPLY_DUST_FALLBACK_VERSION for raw-zstd. */
  version: number;
  replySha256: string;
  replyByteLength: number;
  fileSha256: string;
  /** America/New_York dates of the bars in this page, sorted. */
  sessionDates: string[];
}

export interface TenMinRangeSecurityEntry {
  securityId: string;
  /** Historical symbol the range was requested with. */
  symbol: string;
  dataset: "stocks-aggregates-10m";
  observedAt: string;
  pageCount: number;
  files: TenMinRangeFileEntry[];
  /** Union of the pages' session dates, sorted. */
  sessionDates: string[];
}

export interface TenMinRangeDayEntry {
  sessionDate: string;
  securities: Array<{ securityId: string; files: string[] }>;
}

export interface TenMinRangeManifest {
  schemaVersion: typeof TENMIN_RANGE_MANIFEST_SCHEMA;
  format: typeof REPLY_DUST_FORMAT;
  provider: string;
  rangeFrom: string;
  rangeTo: string;
  securityCount: number;
  fileCount: number;
  fallbackFileCount: number;
  securities: TenMinRangeSecurityEntry[];
  days: TenMinRangeDayEntry[];
  checksum: string;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function requireRange(from: string, to: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to) || from > to)
    throw new Error("INVALID_RANGE");
}

export function tenMinRangePrefix(from: string, to: string): string {
  requireRange(from, to);
  return `${TENMIN_RANGE_REPLY_DUST_PREFIX}/${from}_${to}`;
}

/** Same base64url security-id encoding as the one-day writer. */
export function tenMinRangeFileName(securityId: string, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("INVALID_RANGE_PAGE");
  const id = Buffer.from(securityId, "utf8").toString("base64url");
  return page === 1 ? `${id}.rdust` : `${id}.p${page}.rdust`;
}

export function tenMinRangeFileKey(from: string, to: string, securityId: string, page: number): string {
  return `${tenMinRangePrefix(from, to)}/${tenMinRangeFileName(securityId, page)}`;
}

export function tenMinRangeManifestKey(from: string, to: string): string {
  return `${tenMinRangePrefix(from, to)}/manifest.json`;
}

/** Parse a file name under the range prefix back to its security id and page. */
function parseFileName(name: string): { securityId: string; page: number } | undefined {
  const match = /^([A-Za-z0-9_-]+)(?:\.p([1-9]\d*))?\.rdust$/u.exec(name);
  if (!match) return undefined;
  const page = match[2] === undefined ? 1 : Number(match[2]);
  if (page === 1 && match[2] !== undefined) return undefined; // ".p1" is never written
  return { securityId: Buffer.from(match[1]!, "base64url").toString("utf8"), page };
}

const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** America/New_York calendar date of a bar timestamp (ms), e.g. 00:50Z on the 6th -> the 5th. */
export function easternSessionDate(timestamp: number): string {
  return easternDate.format(new Date(timestamp));
}

function parseReply(reply: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(reply)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MASSIVE_INVALID_RESPONSE");
  return parsed as Record<string, unknown>;
}

function resultRecords(reply: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(reply.results)
    ? reply.results.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

/** Sorted ET dates of every bar with a finite timestamp in one reply. */
export function replySessionDates(reply: Uint8Array): string[] {
  const dates = new Set<string>();
  for (const raw of resultRecords(parseReply(reply)))
    if (typeof raw.t === "number" && Number.isFinite(raw.t)) dates.add(easternSessionDate(raw.t));
  return [...dates].sort(byCodeUnit);
}

function fileEntry(fields: Omit<TenMinRangeFileEntry, "relativePath">, securityId: string): TenMinRangeFileEntry {
  return {
    page: fields.page,
    relativePath: tenMinRangeFileName(securityId, fields.page),
    request: fields.request,
    fetchedAt: fields.fetchedAt,
    byteLength: fields.byteLength,
    version: fields.version,
    replySha256: fields.replySha256,
    replyByteLength: fields.replyByteLength,
    fileSha256: fields.fileSha256,
    sessionDates: [...fields.sessionDates],
  };
}

function securityEntry(fields: {
  securityId: string;
  symbol: string;
  observedAt: string;
  files: TenMinRangeFileEntry[];
}): TenMinRangeSecurityEntry {
  const files = [...fields.files].sort((a, b) => a.page - b.page);
  return {
    securityId: fields.securityId,
    symbol: fields.symbol,
    dataset: "stocks-aggregates-10m",
    observedAt: fields.observedAt,
    pageCount: files.length,
    files,
    sessionDates: [...new Set(files.flatMap((file) => file.sessionDates))].sort(byCodeUnit),
  };
}

/** R2 custom metadata on each range object; enough to rebuild its entry from the store. Must fit 2 KB. */
export function tenMinRangeObjectMetadata(input: {
  provider: string;
  from: string;
  to: string;
  securityId: string;
  symbol: string;
  observedAt: string;
  pageCount: number;
  file: Pick<TenMinRangeFileEntry, "page" | "request" | "fetchedAt" | "version" | "replySha256" | "replyByteLength">;
}): ObjectMetadata {
  return {
    "rd-schema": TENMIN_RANGE_OBJECT_SCHEMA,
    "rd-provider": input.provider,
    "rd-security-id": input.securityId,
    "rd-symbol": input.symbol,
    "rd-request": input.file.request,
    "rd-fetched-at": input.file.fetchedAt,
    "rd-observed-at": input.observedAt,
    "rd-version": String(input.file.version),
    "rd-reply-length": String(input.file.replyByteLength),
    "rd-reply-sha256": input.file.replySha256,
    "rd-range-from": input.from,
    "rd-range-to": input.to,
    "rd-page": String(input.file.page),
    "rd-page-count": String(input.pageCount),
  };
}

/**
 * Store every page of one security's range reply. Per page: encode, decode back and byte-compare,
 * check metadata fits, put, read back, HEAD and compare metadata (storeVerifiedReplyDust). Throws
 * on any failure; the security is done only when this returns.
 */
export async function writeTenMinRangeSecurity(
  store: ReplyDustStore,
  pages: readonly TenMinuteRangeReply[],
  options: { provider: string; from: string; to: string; observedAt?: string; backend?: ReplyDustBackend },
): Promise<TenMinRangeSecurityEntry> {
  const { from, to, provider } = options;
  requireRange(from, to);
  const first = pages[0];
  if (!first) throw new Error("TENMIN_RANGE_NO_PAGES");
  if (pages.length > TENMIN_RANGE_PAGE_CAP)
    throw new Error(`MASSIVE_RANGE_PAGE_CAP:${first.symbol}:${from}:${to}`);
  const { securityId, symbol } = first;
  if (!securityId || !symbol) throw new Error("TENMIN_RANGE_SECURITY_REQUIRED");
  pages.forEach((page, index) => {
    if (
      page.page !== index + 1 ||
      page.securityId !== securityId ||
      page.symbol !== symbol ||
      page.rangeFrom !== from ||
      page.rangeTo !== to
    )
      throw new Error(`TENMIN_RANGE_PAGES_INCONSISTENT:${securityId}:${index + 1}`);
    if (/[?&]apikey=/iu.test(page.request)) throw new Error("TENMIN_RANGE_REQUEST_HAS_API_KEY");
  });
  const observedAt = options.observedAt ?? first.fetchedAt;
  const backend = options.backend ?? nodeReplyDustBackend;
  const files: TenMinRangeFileEntry[] = [];
  for (const page of pages) {
    const sessionDates = replySessionDates(page.body);
    const entryFor = (encoded: Uint8Array): TenMinRangeFileEntry =>
      fileEntry(
        {
          page: page.page,
          request: page.request,
          fetchedAt: page.fetchedAt,
          byteLength: encoded.length,
          version: encoded[0]!,
          replySha256: sha256Hex(page.body),
          replyByteLength: page.body.length,
          fileSha256: sha256Hex(encoded),
          sessionDates,
        },
        securityId,
      );
    const encoded = await storeVerifiedReplyDust(
      store,
      tenMinRangeFileKey(from, to, securityId, page.page),
      page.body,
      `${securityId}:p${page.page}`,
      backend,
      (bytes) =>
        tenMinRangeObjectMetadata({
          provider, from, to, securityId, symbol, observedAt, pageCount: pages.length, file: entryFor(bytes),
        }),
    );
    files.push(entryFor(encoded));
  }
  return securityEntry({ securityId, symbol, observedAt, files });
}

/** Checksum or decode failure is "not done" (redo); anything else (store, zstd missing) is thrown. */
function verifiedReply(bytes: Uint8Array, file: TenMinRangeFileEntry, backend: ReplyDustBackend): Uint8Array | undefined {
  try {
    return verifyRangeBytes(bytes, file, backend, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("REPLY_DUST_") && message !== "REPLY_DUST_ZSTD_UNAVAILABLE") return undefined;
    throw error;
  }
}

function verifyRangeBytes(
  bytes: Uint8Array,
  file: TenMinRangeFileEntry,
  backend: ReplyDustBackend,
  securityId: string,
): Uint8Array {
  if (bytes.length !== file.byteLength || bytes[0] !== file.version || sha256Hex(bytes) !== file.fileSha256)
    throw new Error(`REPLY_DUST_FILE_CHECKSUM_MISMATCH:${securityId}:p${file.page}`);
  const reply = decodeReplyDust(bytes, backend);
  if (reply.length !== file.replyByteLength || sha256Hex(reply) !== file.replySha256)
    throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${securityId}:p${file.page}`);
  return reply;
}

/**
 * Verify one security's full stored page set and return its entry, or undefined when the set is
 * incomplete or bad (a page missing from `storedPages`, missing or inconsistent metadata, wrong
 * page count, failed checksum or decode). Store errors are thrown, never treated as missing. A
 * hint (progress log) saves the HEADs; the bytes of every page are always verified.
 */
export async function verifyStoredTenMinRangeSecurity(
  store: ReplyDustStore,
  from: string,
  to: string,
  securityId: string,
  options: {
    provider: string;
    /** Pages listed under the range prefix for this security (from one list call). */
    storedPages: ReadonlySet<number>;
    hint?: TenMinRangeSecurityEntry;
    backend?: ReplyDustBackend;
  },
): Promise<TenMinRangeSecurityEntry | undefined> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const complete = (count: number) =>
    count >= 1 && count <= TENMIN_RANGE_PAGE_CAP && Array.from({ length: count }, (_, i) => i + 1).every((p) => options.storedPages.has(p));
  const hint = options.hint;
  if (hint && hint.securityId === securityId && hint.files.length === hint.pageCount && complete(hint.pageCount)) {
    let ok = true;
    for (const file of hint.files) {
      const bytes = await store.get(tenMinRangeFileKey(from, to, securityId, file.page));
      if (!bytes || !verifiedReply(bytes, file, backend)) {
        ok = false;
        break;
      }
    }
    if (ok) return securityEntry(hint);
  }
  if (!options.storedPages.has(1)) return undefined;
  let symbol: string | undefined;
  let observedAt: string | undefined;
  let pageCount = 0;
  const files: TenMinRangeFileEntry[] = [];
  for (let page = 1; page <= Math.max(pageCount, 1); page += 1) {
    const key = tenMinRangeFileKey(from, to, securityId, page);
    const head = await store.head(key);
    if (!head) return undefined;
    const m = head.metadata;
    const count = Number(m["rd-page-count"]);
    const version = Number(m["rd-version"]);
    const replyByteLength = Number(m["rd-reply-length"]);
    if (
      m["rd-schema"] !== TENMIN_RANGE_OBJECT_SCHEMA ||
      m["rd-provider"] !== options.provider ||
      m["rd-security-id"] !== securityId ||
      m["rd-range-from"] !== from ||
      m["rd-range-to"] !== to ||
      m["rd-page"] !== String(page) ||
      !m["rd-symbol"] ||
      !m["rd-request"] ||
      !m["rd-fetched-at"] ||
      !m["rd-observed-at"] ||
      !m["rd-reply-sha256"] ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(version) ||
      !Number.isSafeInteger(replyByteLength)
    )
      return undefined;
    if (page === 1) {
      if (!complete(count)) return undefined;
      pageCount = count;
      symbol = m["rd-symbol"];
      observedAt = m["rd-observed-at"];
    } else if (count !== pageCount || m["rd-symbol"] !== symbol || m["rd-observed-at"] !== observedAt) {
      return undefined;
    }
    const bytes = await store.get(key);
    if (!bytes) return undefined;
    const partial = {
      page,
      request: m["rd-request"],
      fetchedAt: m["rd-fetched-at"],
      byteLength: bytes.length,
      version,
      replySha256: m["rd-reply-sha256"],
      replyByteLength,
      fileSha256: sha256Hex(bytes),
      sessionDates: [] as string[],
    };
    const reply = verifiedReply(bytes, fileEntry(partial, securityId), backend);
    if (!reply) return undefined;
    let sessionDates: string[];
    try {
      sessionDates = replySessionDates(reply);
    } catch {
      return undefined;
    }
    files.push(fileEntry({ ...partial, sessionDates }, securityId));
  }
  return securityEntry({ securityId, symbol: symbol!, observedAt: observedAt!, files });
}

/** Security id -> stored page numbers under the range prefix (one list call). */
export async function listStoredTenMinRange(
  store: ReplyDustStore,
  from: string,
  to: string,
): Promise<Map<string, Set<number>>> {
  const prefix = `${tenMinRangePrefix(from, to)}/`;
  const output = new Map<string, Set<number>>();
  for (const key of await store.list(prefix)) {
    const name = key.slice(prefix.length);
    if (name.includes("/")) continue;
    const parsed = parseFileName(name);
    if (!parsed) continue;
    const pages = output.get(parsed.securityId) ?? new Set<number>();
    pages.add(parsed.page);
    output.set(parsed.securityId, pages);
  }
  return output;
}

function manifestChecksum(body: Omit<TenMinRangeManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(body));
}

/** Build the manifest (deterministic: securities by id, days by date, files by page). */
export function buildTenMinRangeManifest(options: {
  provider: string;
  from: string;
  to: string;
  securities: readonly TenMinRangeSecurityEntry[];
}): TenMinRangeManifest {
  requireRange(options.from, options.to);
  const securities = options.securities.map(securityEntry).sort((a, b) => byCodeUnit(a.securityId, b.securityId));
  if (new Set(securities.map((s) => s.securityId)).size !== securities.length)
    throw new Error("REPLY_DUST_DUPLICATE_SECURITY");
  const byDay = new Map<string, Array<{ securityId: string; files: string[] }>>();
  for (const security of securities)
    for (const sessionDate of security.sessionDates) {
      const list = byDay.get(sessionDate) ?? [];
      list.push({
        securityId: security.securityId,
        files: security.files.filter((file) => file.sessionDates.includes(sessionDate)).map((file) => file.relativePath),
      });
      byDay.set(sessionDate, list);
    }
  const days = [...byDay.keys()].sort(byCodeUnit).map((sessionDate) => ({ sessionDate, securities: byDay.get(sessionDate)! }));
  const files = securities.flatMap((security) => security.files);
  const body: Omit<TenMinRangeManifest, "checksum"> = {
    schemaVersion: TENMIN_RANGE_MANIFEST_SCHEMA,
    format: REPLY_DUST_FORMAT,
    provider: options.provider,
    rangeFrom: options.from,
    rangeTo: options.to,
    securityCount: securities.length,
    fileCount: files.length,
    fallbackFileCount: files.filter((file) => file.version === REPLY_DUST_FALLBACK_VERSION).length,
    securities,
    days,
  };
  return { ...body, checksum: manifestChecksum(body) };
}

export function tenMinRangeManifestBytes(manifest: TenMinRangeManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Write the range manifest after its files; verified by HEAD size and checksum metadata. */
export async function writeTenMinRangeManifest(store: ReplyDustStore, manifest: TenMinRangeManifest): Promise<void> {
  const key = tenMinRangeManifestKey(manifest.rangeFrom, manifest.rangeTo);
  const bytes = tenMinRangeManifestBytes(manifest);
  await store.put(key, bytes, { "rd-manifest-checksum": manifest.checksum });
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata["rd-manifest-checksum"] !== manifest.checksum)
    throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
}

export async function readTenMinRangeManifest(
  store: ReplyDustStore,
  from: string,
  to: string,
): Promise<TenMinRangeManifest | undefined> {
  const bytes = await store.get(tenMinRangeManifestKey(from, to));
  if (!bytes) return undefined;
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as TenMinRangeManifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== TENMIN_RANGE_MANIFEST_SCHEMA ||
    manifest.rangeFrom !== from ||
    manifest.rangeTo !== to ||
    manifestChecksum(body) !== checksum
  )
    throw new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH");
  return manifest;
}

// Local progress log: one JSON line per security, appended only after all its pages are verified.
export function tenMinRangeProgressPath(root: string, from: string, to: string): string {
  requireRange(from, to);
  return join(root, "transient", "tenmin-range-progress", `${from}_${to}.jsonl`);
}

export async function loadTenMinRangeProgress(root: string, from: string, to: string): Promise<TenMinRangeSecurityEntry[]> {
  const target = prepareSafeStoreFile(tenMinRangeProgressPath(root, from, to), TENMIN_RANGE_PATH_ERROR);
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: TenMinRangeSecurityEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as TenMinRangeSecurityEntry);
    } catch {
      // torn final line from a crash mid-append
    }
  }
  return entries;
}

async function appendTenMinRangeProgress(root: string, from: string, to: string, entry: TenMinRangeSecurityEntry): Promise<void> {
  const target = prepareSafeStoreFile(tenMinRangeProgressPath(root, from, to), TENMIN_RANGE_PATH_ERROR);
  await appendFile(target, `\n${JSON.stringify(entry)}\n`, "utf8");
}

export interface TenMinRangeWriteResult {
  manifest: TenMinRangeManifest;
  /** True when the range was already sealed: nothing was fetched or written. */
  alreadySealed: boolean;
  securitiesWritten: string[];
  securitiesResumed: string[];
  filesWritten: number;
  /** Files written as the raw-zstd fallback (0x81) this run: stored, a warning, never a failure. */
  fallbackFiles: number;
  zstdVersion: string;
  warnings?: string[];
}

/**
 * Write one range for a set of securities and seal it with its manifest. Resume comes from the
 * store: the range prefix is listed once and each listed security's full page set verified (the
 * progress log saves the HEADs); an incomplete or bad set is fetched and written again. Store
 * errors are thrown, never treated as missing.
 */
export async function writeTenMinRangeReplyDust(options: {
  store: ReplyDustStore;
  /** Local market root for the transient progress log. */
  root: string;
  provider: string;
  from: string;
  to: string;
  securities: ReadonlyArray<{ securityId: string; symbol: string }>;
  fetchPages: (security: { securityId: string; symbol: string }, from: string, to: string) => Promise<TenMinuteRangeReply[]>;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
}): Promise<TenMinRangeWriteResult> {
  const { store, root, provider, from, to } = options;
  requireRange(from, to);
  const zstdVersion = assertPinnedZstdForWriting(options.zstdVersionProbe);
  const existing = await readTenMinRangeManifest(store, from, to);
  if (existing)
    return {
      manifest: existing, alreadySealed: true, securitiesWritten: [], securitiesResumed: [], filesWritten: 0, fallbackFiles: 0, zstdVersion,
    };
  const backend = options.backend ?? nodeReplyDustBackend;
  const hints = new Map((await loadTenMinRangeProgress(root, from, to)).map((entry) => [entry.securityId, entry]));
  const stored = await listStoredTenMinRange(store, from, to);
  const done = new Map<string, TenMinRangeSecurityEntry>();
  const securitiesWritten: string[] = [];
  const securitiesResumed: string[] = [];
  let filesWritten = 0;
  let fallbackFiles = 0;
  for (const security of options.securities) {
    if (done.has(security.securityId)) throw new Error("REPLY_DUST_DUPLICATE_SECURITY");
    const storedPages = stored.get(security.securityId);
    if (storedPages) {
      const hint = hints.get(security.securityId);
      const verified = await verifyStoredTenMinRangeSecurity(store, from, to, security.securityId, {
        provider, storedPages, backend, ...(hint ? { hint } : {}),
      });
      if (verified) {
        done.set(security.securityId, verified);
        securitiesResumed.push(security.securityId);
        continue;
      }
    }
    const pages = await options.fetchPages(security, from, to);
    const entry = await writeTenMinRangeSecurity(store, pages, { provider, from, to, backend });
    filesWritten += entry.files.length;
    fallbackFiles += entry.files.filter((file) => file.version === REPLY_DUST_FALLBACK_VERSION).length;
    await appendTenMinRangeProgress(root, from, to, entry);
    done.set(security.securityId, entry);
    securitiesWritten.push(security.securityId);
  }
  const manifest = buildTenMinRangeManifest({ provider, from, to, securities: [...done.values()] });
  await writeTenMinRangeManifest(store, manifest);
  await rm(tenMinRangeProgressPath(root, from, to), { force: true });
  return {
    manifest,
    alreadySealed: false,
    securitiesWritten,
    securitiesResumed,
    filesWritten,
    fallbackFiles,
    zstdVersion,
    ...(fallbackFiles > 0 ? { warnings: [`${REPLY_DUST_FALLBACK_WARNING}:${fallbackFiles}`] } : {}),
  };
}

export interface TenMinRangeVerifiedPage {
  page: number;
  file: TenMinRangeFileEntry;
  reply: Uint8Array;
}

function requireManifest(manifest: TenMinRangeManifest | undefined): TenMinRangeManifest {
  if (!manifest) throw Object.assign(new Error("REPLY_DUST_MANIFEST_MISSING"), { code: "ENOENT" });
  return manifest;
}

async function readSecurityPages(
  store: ReplyDustStore,
  manifest: TenMinRangeManifest,
  security: TenMinRangeSecurityEntry,
  backend: ReplyDustBackend,
): Promise<TenMinRangeVerifiedPage[]> {
  const output: TenMinRangeVerifiedPage[] = [];
  for (const file of security.files) {
    const bytes = await store.get(`${tenMinRangePrefix(manifest.rangeFrom, manifest.rangeTo)}/${file.relativePath}`);
    if (!bytes) throw new Error(`REPLY_DUST_FILE_MISSING:${security.securityId}:p${file.page}`);
    output.push({ page: file.page, file, reply: verifyRangeBytes(bytes, file, backend, security.securityId) });
  }
  return output;
}

/** Every page of one security's range reply, verified against the manifest; [] if not listed. */
export async function readRangeReplies(
  store: ReplyDustStore,
  from: string,
  to: string,
  securityId: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<TenMinRangeVerifiedPage[]> {
  const manifest = requireManifest(await readTenMinRangeManifest(store, from, to));
  const security = manifest.securities.find((entry) => entry.securityId === securityId);
  return security ? readSecurityPages(store, manifest, security, backend) : [];
}

/**
 * Canonical 10-minute bars for one security's session from its range reply: the bars of that ET
 * date (across all pages, in page order) go through the same normalizer the one-day path uses.
 * retrievalId comes from the request_id of the first page with bars on the day (else page 1).
 * [] if the security is not listed; a listed security with no bars that day gets the normalizer's
 * explicit missing intervals, exactly as an empty one-day reply would.
 */
export async function readRangeSecurityDay(
  store: ReplyDustStore,
  from: string,
  to: string,
  securityId: string,
  sessionDate: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<CanonicalTenMinuteBar[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  if (sessionDate < from || sessionDate > to) throw new Error(`TENMIN_RANGE_DATE_OUTSIDE:${sessionDate}`);
  const manifest = requireManifest(await readTenMinRangeManifest(store, from, to));
  const security = manifest.securities.find((entry) => entry.securityId === securityId);
  if (!security) return [];
  const pages = await readSecurityPages(store, manifest, security, backend);
  const results: Array<Record<string, unknown>> = [];
  let requestId: unknown;
  for (const { reply } of pages) {
    const parsed = parseReply(reply);
    const dayBars = resultRecords(parsed).filter(
      (raw) => typeof raw.t === "number" && Number.isFinite(raw.t) && easternSessionDate(raw.t) === sessionDate,
    );
    if (dayBars.length && requestId === undefined) requestId = parsed.request_id;
    results.push(...dayBars);
  }
  if (requestId === undefined && pages[0]) requestId = parseReply(pages[0].reply).request_id;
  return massiveTenMinuteBarsFromReply({
    provider: manifest.provider,
    sessionDate,
    securityId,
    symbol: security.symbol,
    reply: { results, ...(requestId === undefined ? {} : { request_id: requestId }) },
    observedAt: security.observedAt,
  });
}
