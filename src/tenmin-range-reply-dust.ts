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

// Two-month 10-minute range replies as Reply Dust. Folder identity is the fixed calendar pair
// (e.g. 2024-11-01_2024-12-31) so a later window clamp still resumes the same folder. Each
// (security, ticker, fetch-span) has its own file set:
//   permanent/tenmin-reply-dust/<calFrom>_<calTo>/
//     <b64url(securityId)>.<b64url(symbol)>.<fetchFrom>_<fetchTo>.rdust
//     <b64url(securityId)>.<b64url(symbol)>.<fetchFrom>_<fetchTo>.p<N>.rdust
//     manifest.json

export const TENMIN_RANGE_REPLY_DUST_PREFIX = "permanent/tenmin-reply-dust";
export const TENMIN_RANGE_OBJECT_SCHEMA = "tenmin-range-reply-dust-object-v2";
export const TENMIN_RANGE_MANIFEST_SCHEMA = "tenmin-range-reply-dust-manifest-v2" as const;
export const TENMIN_RANGE_PATH_ERROR = "TENMIN_RANGE_PATH_INVALID";
export const TENMIN_RANGE_OUTAGE_STREAK = 5;
export const TENMIN_RANGE_OUTAGE_STOP = "MASSIVE_OUTAGE";
/**
 * A range manifest sealed with 0 securities is never "complete, no data": readers refuse it, and
 * the writer treats it as not sealed (and never seals one itself).
 */
export const TENMIN_UNIVERSE_EMPTY = "TENMIN_UNIVERSE_EMPTY";

/**
 * Range-level gap (securityId and symbol empty, fetchFrom/fetchTo = the dropped calendar days)
 * for days of an unsealed range that left the history window. Never retried, never blocks sealing.
 */
export const TENMIN_AGED_OUT = "AGED_OUT";

export function isEmptyTenMinRangeManifest(manifest: TenMinRangeManifest): boolean {
  return manifest.securityCount === 0 || manifest.securities.length === 0;
}

export interface TenMinRangeFileEntry {
  page: number;
  relativePath: string;
  request: string;
  fetchedAt: string;
  byteLength: number;
  version: number;
  replySha256: string;
  replyByteLength: number;
  fileSha256: string;
  sessionDates: string[];
}

/** One Massive range request for one ticker over its own sub-span. */
export interface TenMinRangeTickerFetch {
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  observedAt: string;
  pageCount: number;
  files: TenMinRangeFileEntry[];
  sessionDates: string[];
}

/** securityId -> ticker link quality. PROVISIONAL: taken from today's master, not point-in-time. */
export type TenMinSecurityLink = "PROVISIONAL";

export interface TenMinRangeSecurityEntry {
  securityId: string;
  dataset: "stocks-aggregates-10m";
  /** Present when the run planned from a provisional master link. */
  securityLink?: TenMinSecurityLink;
  fetches: TenMinRangeTickerFetch[];
  sessionDates: string[];
}

export interface TenMinRangeDayEntry {
  sessionDate: string;
  securities: Array<{ securityId: string; files: string[] }>;
}

export interface TenMinRangeGapEntry {
  securityId: string;
  symbol: string;
  reason: string;
  at: string;
  fetchFrom?: string;
  fetchTo?: string;
}

export interface TenMinRangeManifest {
  schemaVersion: typeof TENMIN_RANGE_MANIFEST_SCHEMA;
  format: typeof REPLY_DUST_FORMAT;
  provider: string;
  /** Calendar folder identity (stable across window clamps). */
  rangeFrom: string;
  rangeTo: string;
  securityCount: number;
  fileCount: number;
  fallbackFileCount: number;
  securities: TenMinRangeSecurityEntry[];
  days: TenMinRangeDayEntry[];
  gaps: TenMinRangeGapEntry[];
  /** Present when the run planned from a provisional master link (see rd-link). */
  securityLink?: TenMinSecurityLink;
  securityLinkSource?: string;
  checksum: string;
}

/** Planned Massive fetch unit: one ticker over one sub-span. */
export interface TenMinRangePlannedFetch {
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function requireRange(from: string, to: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to) || from > to)
    throw new Error("INVALID_RANGE");
}

export function tenMinRangePrefix(calendarFrom: string, calendarTo: string): string {
  requireRange(calendarFrom, calendarTo);
  return `${TENMIN_RANGE_REPLY_DUST_PREFIX}/${calendarFrom}_${calendarTo}`;
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const unb64 = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

/** Filesystem/URL-safe name for one page of a (security, ticker, sub-span) fetch. */
export function tenMinRangeFileName(
  securityId: string,
  symbol: string,
  fetchFrom: string,
  fetchTo: string,
  page: number,
): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("INVALID_RANGE_PAGE");
  requireRange(fetchFrom, fetchTo);
  const base = `${b64(securityId)}.${b64(symbol)}.${fetchFrom}_${fetchTo}`;
  return page === 1 ? `${base}.rdust` : `${base}.p${page}.rdust`;
}

export function tenMinRangeFileKey(
  calendarFrom: string,
  calendarTo: string,
  securityId: string,
  symbol: string,
  fetchFrom: string,
  fetchTo: string,
  page: number,
): string {
  return `${tenMinRangePrefix(calendarFrom, calendarTo)}/${tenMinRangeFileName(securityId, symbol, fetchFrom, fetchTo, page)}`;
}

export function tenMinRangeManifestKey(calendarFrom: string, calendarTo: string): string {
  return `${tenMinRangePrefix(calendarFrom, calendarTo)}/manifest.json`;
}

export function fetchIdentityKey(fetch: {
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
}): string {
  return `${fetch.securityId}\0${fetch.symbol}\0${fetch.fetchFrom}\0${fetch.fetchTo}`;
}

export function parseFetchIdentityKey(
  key: string,
): { securityId: string; symbol: string; fetchFrom: string; fetchTo: string } | undefined {
  const parts = key.split("\0");
  if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) return undefined;
  return { securityId: parts[0], symbol: parts[1], fetchFrom: parts[2], fetchTo: parts[3] };
}

/** One stored fetch identity under a security, with its page set. */
export interface StoredTenMinRangeFetchRef {
  key: string;
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  pages: Set<number>;
}

/** Group listStoredTenMinRange output by securityId (one pass). */
export function groupStoredFetchesBySecurity(
  stored: Map<string, Set<number>>,
): Map<string, StoredTenMinRangeFetchRef[]> {
  const bySecurity = new Map<string, StoredTenMinRangeFetchRef[]>();
  for (const [key, pages] of stored) {
    const parsed = parseFetchIdentityKey(key);
    if (!parsed) continue;
    const list = bySecurity.get(parsed.securityId) ?? [];
    list.push({ key, ...parsed, pages });
    bySecurity.set(parsed.securityId, list);
  }
  for (const list of bySecurity.values())
    list.sort(
      (a, b) =>
        (a.fetchFrom < b.fetchFrom ? -1 : a.fetchFrom > b.fetchFrom ? 1 : 0) ||
        (a.fetchTo < b.fetchTo ? -1 : a.fetchTo > b.fetchTo ? 1 : 0) ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
  return bySecurity;
}

/**
 * Stored fetches that can satisfy a planned fetch on resume: same security, ticker, fetchTo, and
 * stored.fetchFrom <= planned.fetchFrom (window clamp moved forward). Earliest fetchFrom first.
 */
export function compatibleStoredFetches(
  refs: readonly StoredTenMinRangeFetchRef[],
  planned: TenMinRangePlannedFetch,
): StoredTenMinRangeFetchRef[] {
  return refs
    .filter(
      (ref) =>
        ref.symbol === planned.symbol &&
        ref.fetchTo === planned.fetchTo &&
        ref.fetchFrom <= planned.fetchFrom &&
        ref.pages.has(1),
    )
    .sort((a, b) => (a.fetchFrom < b.fetchFrom ? -1 : a.fetchFrom > b.fetchFrom ? 1 : 0));
}

interface ParsedFileName {
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  page: number;
}

function parseFileName(name: string): ParsedFileName | undefined {
  const match =
    /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:\.p([1-9]\d*))?\.rdust$/u.exec(
      name,
    );
  if (!match) return undefined;
  const page = match[5] === undefined ? 1 : Number(match[5]);
  if (page === 1 && match[5] !== undefined) return undefined;
  return {
    securityId: unb64(match[1]!),
    symbol: unb64(match[2]!),
    fetchFrom: match[3]!,
    fetchTo: match[4]!,
    page,
  };
}

const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

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

export function replySessionDates(reply: Uint8Array): string[] {
  const dates = new Set<string>();
  for (const raw of resultRecords(parseReply(reply)))
    if (typeof raw.t === "number" && Number.isFinite(raw.t)) dates.add(easternSessionDate(raw.t));
  return [...dates].sort(byCodeUnit);
}

function fileEntry(
  fields: Omit<TenMinRangeFileEntry, "relativePath">,
  securityId: string,
  symbol: string,
  fetchFrom: string,
  fetchTo: string,
): TenMinRangeFileEntry {
  return {
    page: fields.page,
    relativePath: tenMinRangeFileName(securityId, symbol, fetchFrom, fetchTo, fields.page),
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

function tickerFetch(fields: {
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  observedAt: string;
  files: TenMinRangeFileEntry[];
}): TenMinRangeTickerFetch {
  const files = [...fields.files].sort((a, b) => a.page - b.page);
  return {
    symbol: fields.symbol,
    fetchFrom: fields.fetchFrom,
    fetchTo: fields.fetchTo,
    observedAt: fields.observedAt,
    pageCount: files.length,
    files,
    sessionDates: [...new Set(files.flatMap((file) => file.sessionDates))].sort(byCodeUnit),
  };
}

function securityEntry(fields: {
  securityId: string;
  fetches: TenMinRangeTickerFetch[];
  securityLink?: TenMinSecurityLink;
}): TenMinRangeSecurityEntry {
  const fetches = fields.fetches
    .map((f) => tickerFetch(f))
    .sort(
      (a, b) =>
        byCodeUnit(a.fetchFrom, b.fetchFrom) ||
        byCodeUnit(a.fetchTo, b.fetchTo) ||
        byCodeUnit(a.symbol, b.symbol),
    );
  return {
    securityId: fields.securityId,
    dataset: "stocks-aggregates-10m",
    ...(fields.securityLink ? { securityLink: fields.securityLink } : {}),
    fetches,
    sessionDates: [...new Set(fetches.flatMap((f) => f.sessionDates))].sort(byCodeUnit),
  };
}

export function tenMinRangeObjectMetadata(input: {
  provider: string;
  calendarFrom: string;
  calendarTo: string;
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  observedAt: string;
  pageCount: number;
  file: Pick<TenMinRangeFileEntry, "page" | "request" | "fetchedAt" | "version" | "replySha256" | "replyByteLength">;
  /** rd-link, e.g. provisional-master-2026-10-05. Optional: readers accept objects without it. */
  link?: string;
}): ObjectMetadata {
  if (input.link !== undefined && !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(input.link))
    throw new Error("TENMIN_RANGE_LINK_INVALID");
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
    "rd-range-from": input.calendarFrom,
    "rd-range-to": input.calendarTo,
    "rd-fetch-from": input.fetchFrom,
    "rd-fetch-to": input.fetchTo,
    "rd-page": String(input.file.page),
    "rd-page-count": String(input.pageCount),
    ...(input.link !== undefined ? { "rd-link": input.link } : {}),
  };
}

export async function writeTenMinRangeFetch(
  store: ReplyDustStore,
  pages: readonly TenMinuteRangeReply[],
  options: {
    provider: string;
    calendarFrom: string;
    calendarTo: string;
    fetchFrom: string;
    fetchTo: string;
    observedAt?: string;
    backend?: ReplyDustBackend;
    link?: string;
  },
): Promise<{ securityId: string; fetch: TenMinRangeTickerFetch }> {
  const { calendarFrom, calendarTo, fetchFrom, fetchTo, provider } = options;
  requireRange(calendarFrom, calendarTo);
  requireRange(fetchFrom, fetchTo);
  const first = pages[0];
  if (!first) throw new Error("TENMIN_RANGE_NO_PAGES");
  if (pages.length > TENMIN_RANGE_PAGE_CAP)
    throw new Error(`MASSIVE_RANGE_PAGE_CAP:${first.symbol}:${fetchFrom}:${fetchTo}`);
  const { securityId, symbol } = first;
  if (!securityId || !symbol) throw new Error("TENMIN_RANGE_SECURITY_REQUIRED");
  pages.forEach((page, index) => {
    if (
      page.page !== index + 1 ||
      page.securityId !== securityId ||
      page.symbol !== symbol ||
      page.rangeFrom !== fetchFrom ||
      page.rangeTo !== fetchTo
    )
      throw new Error(`TENMIN_RANGE_PAGES_INCONSISTENT:${securityId}:${symbol}:${index + 1}`);
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
        symbol,
        fetchFrom,
        fetchTo,
      );
    const encoded = await storeVerifiedReplyDust(
      store,
      tenMinRangeFileKey(calendarFrom, calendarTo, securityId, symbol, fetchFrom, fetchTo, page.page),
      page.body,
      `${securityId}:${symbol}:p${page.page}`,
      backend,
      (bytes) =>
        tenMinRangeObjectMetadata({
          provider,
          calendarFrom,
          calendarTo,
          securityId,
          symbol,
          fetchFrom,
          fetchTo,
          observedAt,
          pageCount: pages.length,
          file: entryFor(bytes),
          ...(options.link !== undefined ? { link: options.link } : {}),
        }),
    );
    files.push(entryFor(encoded));
  }
  return { securityId, fetch: tickerFetch({ symbol, fetchFrom, fetchTo, observedAt, files }) };
}

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
  label: string,
): Uint8Array {
  if (bytes.length !== file.byteLength || bytes[0] !== file.version || sha256Hex(bytes) !== file.fileSha256)
    throw new Error(`REPLY_DUST_FILE_CHECKSUM_MISMATCH:${label}:p${file.page}`);
  const reply = decodeReplyDust(bytes, backend);
  if (reply.length !== file.replyByteLength || sha256Hex(reply) !== file.replySha256)
    throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${label}:p${file.page}`);
  return reply;
}

export async function verifyStoredTenMinRangeFetch(
  store: ReplyDustStore,
  calendarFrom: string,
  calendarTo: string,
  planned: TenMinRangePlannedFetch,
  options: {
    provider: string;
    storedPages: ReadonlySet<number>;
    hint?: TenMinRangeTickerFetch;
    backend?: ReplyDustBackend;
  },
): Promise<TenMinRangeTickerFetch | undefined> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const { securityId, symbol, fetchFrom, fetchTo } = planned;
  const complete = (count: number) =>
    count >= 1 &&
    count <= TENMIN_RANGE_PAGE_CAP &&
    Array.from({ length: count }, (_, i) => i + 1).every((p) => options.storedPages.has(p));
  const hint = options.hint;
  if (
    hint &&
    hint.symbol === symbol &&
    hint.fetchFrom === fetchFrom &&
    hint.fetchTo === fetchTo &&
    hint.files.length === hint.pageCount &&
    complete(hint.pageCount)
  ) {
    let ok = true;
    for (const file of hint.files) {
      const bytes = await store.get(
        tenMinRangeFileKey(calendarFrom, calendarTo, securityId, symbol, fetchFrom, fetchTo, file.page),
      );
      if (!bytes || !verifiedReply(bytes, file, backend)) {
        ok = false;
        break;
      }
    }
    if (ok) return tickerFetch(hint);
  }
  if (!options.storedPages.has(1)) return undefined;
  let observedAt: string | undefined;
  let pageCount = 0;
  const files: TenMinRangeFileEntry[] = [];
  for (let page = 1; page <= Math.max(pageCount, 1); page += 1) {
    const key = tenMinRangeFileKey(calendarFrom, calendarTo, securityId, symbol, fetchFrom, fetchTo, page);
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
      m["rd-symbol"] !== symbol ||
      m["rd-range-from"] !== calendarFrom ||
      m["rd-range-to"] !== calendarTo ||
      m["rd-fetch-from"] !== fetchFrom ||
      m["rd-fetch-to"] !== fetchTo ||
      m["rd-page"] !== String(page) ||
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
      observedAt = m["rd-observed-at"];
    } else if (count !== pageCount || m["rd-observed-at"] !== observedAt) {
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
    const reply = verifiedReply(bytes, fileEntry(partial, securityId, symbol, fetchFrom, fetchTo), backend);
    if (!reply) return undefined;
    let sessionDates: string[];
    try {
      sessionDates = replySessionDates(reply);
    } catch {
      return undefined;
    }
    files.push(fileEntry({ ...partial, sessionDates }, securityId, symbol, fetchFrom, fetchTo));
  }
  return tickerFetch({ symbol, fetchFrom, fetchTo, observedAt: observedAt!, files });
}

/** fetchIdentityKey -> stored page numbers under the calendar range prefix. */
export async function listStoredTenMinRange(
  store: ReplyDustStore,
  calendarFrom: string,
  calendarTo: string,
): Promise<Map<string, Set<number>>> {
  const prefix = `${tenMinRangePrefix(calendarFrom, calendarTo)}/`;
  const output = new Map<string, Set<number>>();
  for (const key of await store.list(prefix)) {
    const name = key.slice(prefix.length);
    if (name.includes("/")) continue;
    const parsed = parseFileName(name);
    if (!parsed) continue;
    const id = fetchIdentityKey(parsed);
    const pages = output.get(id) ?? new Set<number>();
    pages.add(parsed.page);
    output.set(id, pages);
  }
  return output;
}

function manifestChecksum(body: Omit<TenMinRangeManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(body));
}

function gapEntry(fields: TenMinRangeGapEntry): TenMinRangeGapEntry {
  return {
    securityId: fields.securityId,
    symbol: fields.symbol,
    reason: fields.reason,
    at: fields.at,
    ...(fields.fetchFrom ? { fetchFrom: fields.fetchFrom } : {}),
    ...(fields.fetchTo ? { fetchTo: fields.fetchTo } : {}),
  };
}

function gapKey(gap: TenMinRangeGapEntry): string {
  return `${gap.securityId}\0${gap.symbol}\0${gap.fetchFrom ?? ""}\0${gap.fetchTo ?? ""}\0${gap.reason}`;
}

export function buildTenMinRangeManifest(options: {
  provider: string;
  from: string;
  to: string;
  securities: readonly TenMinRangeSecurityEntry[];
  gaps?: readonly TenMinRangeGapEntry[];
  securityLink?: { status: TenMinSecurityLink; source: string };
}): TenMinRangeManifest {
  requireRange(options.from, options.to);
  const link = options.securityLink;
  const securities = options.securities
    .map((s) => securityEntry({ ...s, ...(link ? { securityLink: link.status } : {}) })).sort((a, b) => byCodeUnit(a.securityId, b.securityId));
  if (new Set(securities.map((s) => s.securityId)).size !== securities.length)
    throw new Error("REPLY_DUST_DUPLICATE_SECURITY");
  const gaps = (options.gaps ?? [])
    .map(gapEntry)
    .sort(
      (a, b) =>
        byCodeUnit(a.securityId, b.securityId) ||
        byCodeUnit(a.symbol, b.symbol) ||
        byCodeUnit(a.fetchFrom ?? "", b.fetchFrom ?? "") ||
        byCodeUnit(a.reason, b.reason),
    );
  if (new Set(gaps.map(gapKey)).size !== gaps.length) throw new Error("REPLY_DUST_DUPLICATE_GAP");
  const byDay = new Map<string, Array<{ securityId: string; files: string[] }>>();
  for (const security of securities)
    for (const fetch of security.fetches)
      for (const sessionDate of fetch.sessionDates) {
        const list = byDay.get(sessionDate) ?? [];
        const existing = list.find((item) => item.securityId === security.securityId);
        const paths = fetch.files
          .filter((file) => file.sessionDates.includes(sessionDate))
          .map((file) => file.relativePath);
        if (existing) existing.files.push(...paths);
        else list.push({ securityId: security.securityId, files: paths });
        byDay.set(sessionDate, list);
      }
  for (const list of byDay.values()) {
    list.sort((a, b) => byCodeUnit(a.securityId, b.securityId));
    for (const item of list) item.files.sort(byCodeUnit);
  }
  const days = [...byDay.keys()].sort(byCodeUnit).map((sessionDate) => ({
    sessionDate,
    securities: byDay.get(sessionDate)!,
  }));
  const files = securities.flatMap((s) => s.fetches.flatMap((f) => f.files));
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
    gaps,
    ...(link ? { securityLink: link.status, securityLinkSource: link.source } : {}),
  };
  return { ...body, checksum: manifestChecksum(body) };
}

export function tenMinRangeManifestBytes(manifest: TenMinRangeManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export async function writeTenMinRangeManifest(store: ReplyDustStore, manifest: TenMinRangeManifest): Promise<void> {
  const key = tenMinRangeManifestKey(manifest.rangeFrom, manifest.rangeTo);
  const bytes = tenMinRangeManifestBytes(manifest);
  await store.put(key, bytes, { "rd-manifest-checksum": manifest.checksum });
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata["rd-manifest-checksum"] !== manifest.checksum)
    throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
}

/**
 * Read and verify a sealed range manifest. A manifest sealed with 0 securities throws
 * TENMIN_UNIVERSE_EMPTY unless allowEmpty is set (only the writer does that, to replace it).
 */
export async function readTenMinRangeManifest(
  store: ReplyDustStore,
  from: string,
  to: string,
  options: { allowEmpty?: boolean } = {},
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
  if (isEmptyTenMinRangeManifest(manifest) && options.allowEmpty !== true)
    throw new Error(`${TENMIN_UNIVERSE_EMPTY}:${from}_${to}:sealed-manifest-has-0-securities`);
  return manifest;
}

export interface TenMinRangeProgressEntry {
  securityId: string;
  fetch: TenMinRangeTickerFetch;
}

export function tenMinRangeProgressPath(root: string, from: string, to: string): string {
  requireRange(from, to);
  return join(root, "transient", "tenmin-range-progress", `${from}_${to}.jsonl`);
}

export async function loadTenMinRangeProgress(
  root: string,
  from: string,
  to: string,
): Promise<TenMinRangeProgressEntry[]> {
  const target = prepareSafeStoreFile(tenMinRangeProgressPath(root, from, to), TENMIN_RANGE_PATH_ERROR);
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: TenMinRangeProgressEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as TenMinRangeProgressEntry);
    } catch {
      // torn final line
    }
  }
  return entries;
}

async function appendTenMinRangeProgress(
  root: string,
  from: string,
  to: string,
  entry: TenMinRangeProgressEntry,
): Promise<void> {
  const target = prepareSafeStoreFile(tenMinRangeProgressPath(root, from, to), TENMIN_RANGE_PATH_ERROR);
  await appendFile(target, `\n${JSON.stringify(entry)}\n`, "utf8");
}

export interface TenMinRangeWriteResult {
  manifest: TenMinRangeManifest | undefined;
  alreadySealed: boolean;
  sealed: boolean;
  securitiesWritten: string[];
  securitiesResumed: string[];
  fetchesWritten: number;
  fetchesResumed: number;
  gaps: TenMinRangeGapEntry[];
  filesWritten: number;
  fallbackFiles: number;
  zstdVersion: string;
  massiveRequests: number;
  yieldedForScan?: string;
  outageStop?: string;
  warnings?: string[];
}

export function isTenMinRangeAbortError(message: string): boolean {
  return (
    message.includes("MASSIVE_CREDENTIAL_REJECTED") ||
    message.includes("MASSIVE_API_KEY") ||
    message.startsWith("MASSIVE_HTTP_401") ||
    message.startsWith("MASSIVE_HTTP_403") ||
    message.startsWith("MASSIVE_HTTP_429") ||
    message === "OBJECT_STORE_REQUIRED" ||
    message.startsWith("R2_") ||
    message.startsWith("REPLY_DUST_ZSTD")
  );
}

/** Transient Massive failures that count toward the outage streak (after provider retries). */
export function isTenMinRangeOutageError(message: string): boolean {
  return (
    message.startsWith("MASSIVE_NETWORK") ||
    /^MASSIVE_HTTP_5\d\d\b/u.test(message)
  );
}

export function tenMinRangeGapReason(message: string): string {
  const match = /^([A-Z][A-Z0-9_]+)/u.exec(message);
  return match?.[1] ?? "TENMIN_RANGE_FETCH_FAILED";
}

function groupSecurities(
  doneFetches: Map<string, { securityId: string; fetch: TenMinRangeTickerFetch }>,
): TenMinRangeSecurityEntry[] {
  const bySecurity = new Map<string, TenMinRangeTickerFetch[]>();
  for (const { securityId, fetch } of doneFetches.values()) {
    const list = bySecurity.get(securityId) ?? [];
    list.push(fetch);
    bySecurity.set(securityId, list);
  }
  return [...bySecurity.entries()].map(([securityId, fetches]) => securityEntry({ securityId, fetches }));
}

/**
 * Write one calendar range. Work units are planned (security, ticker, sub-span) fetches.
 * Folder keys use calendar from/to; each file's metadata carries the actual fetch span.
 */
export async function writeTenMinRangeReplyDust(options: {
  store: ReplyDustStore;
  root: string;
  provider: string;
  /** Calendar folder identity (stable). */
  from: string;
  to: string;
  /** Planned ticker fetches (may be multiple per security). */
  fetches: readonly TenMinRangePlannedFetch[];
  initialGaps?: readonly TenMinRangeGapEntry[];
  reopen?: boolean;
  /**
   * The securityId -> ticker link is provisional (today's master): every written object gets
   * rd-link = source, and the manifest marks every security entry securityLink: PROVISIONAL.
   */
  securityLink?: { status: TenMinSecurityLink; source: string };
  shouldYield?: () => Promise<string | undefined>;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
  now?: () => string;
  fetchPages: (
    security: { securityId: string; symbol: string },
    fetchFrom: string,
    fetchTo: string,
  ) => Promise<TenMinuteRangeReply[]>;
}): Promise<TenMinRangeWriteResult> {
  const { store, root, provider, from, to } = options;
  requireRange(from, to);
  const zstdVersion = assertPinnedZstdForWriting(options.zstdVersionProbe);
  const stamp = options.now ?? (() => new Date().toISOString());
  // An earlier manifest sealed with 0 securities is not a seal: plan the range from scratch and
  // replace it.
  const previous = await readTenMinRangeManifest(store, from, to, { allowEmpty: true });
  const existing = previous && !isEmptyTenMinRangeManifest(previous) ? previous : undefined;
  const reopen = options.reopen === true;
  if (existing && !reopen)
    return {
      manifest: existing,
      alreadySealed: true,
      sealed: true,
      securitiesWritten: [],
      securitiesResumed: [],
      fetchesWritten: 0,
      fetchesResumed: 0,
      gaps: [...(existing.gaps ?? [])],
      filesWritten: 0,
      fallbackFiles: 0,
      zstdVersion,
      massiveRequests: 0,
    };

  const backend = options.backend ?? nodeReplyDustBackend;
  const warnings: string[] = [];
  const gaps = new Map<string, TenMinRangeGapEntry>();
  for (const gap of options.initialGaps ?? []) gaps.set(gapKey(gap), gapEntry(gap));

  const doneFetches = new Map<string, { securityId: string; fetch: TenMinRangeTickerFetch }>();
  let work = [...options.fetches];

  if (existing && reopen) {
    for (const security of existing.securities)
      for (const fetch of security.fetches)
        doneFetches.set(fetchIdentityKey({ securityId: security.securityId, ...fetch }), {
          securityId: security.securityId,
          fetch: tickerFetch(fetch),
        });
    for (const gap of existing.gaps ?? []) gaps.set(gapKey(gap), gapEntry(gap));
    const plannedKeys = new Set(options.fetches.map(fetchIdentityKey));
    const wanted = new Set<string>();
    for (const gap of existing.gaps ?? []) {
      if (gap.fetchFrom && gap.fetchTo && gap.symbol) {
        const key = fetchIdentityKey({
          securityId: gap.securityId,
          symbol: gap.symbol,
          fetchFrom: gap.fetchFrom,
          fetchTo: gap.fetchTo,
        });
        wanted.add(key);
      } else if (!gap.symbol) {
        // NO_HISTORICAL_SYMBOL — keep unless a planned fetch now exists for this security.
        if (![...plannedKeys].some((k) => k.startsWith(`${gap.securityId}\0`)))
          gaps.set(gapKey(gap), gapEntry(gap));
      }
    }
    for (const fetch of options.fetches) {
      const key = fetchIdentityKey(fetch);
      if (!doneFetches.has(key)) wanted.add(key);
    }
    const byKey = new Map(options.fetches.map((f) => [fetchIdentityKey(f), f]));
    for (const gap of existing.gaps ?? []) {
      if (!gap.fetchFrom || !gap.fetchTo || !gap.symbol) continue;
      const key = fetchIdentityKey({
        securityId: gap.securityId,
        symbol: gap.symbol,
        fetchFrom: gap.fetchFrom,
        fetchTo: gap.fetchTo,
      });
      if (!byKey.has(key))
        byKey.set(key, {
          securityId: gap.securityId,
          symbol: gap.symbol,
          fetchFrom: gap.fetchFrom,
          fetchTo: gap.fetchTo,
        });
    }
    work = [...wanted]
      .sort(byCodeUnit)
      .map((key) => byKey.get(key))
      .filter((f): f is TenMinRangePlannedFetch => !!f);
    for (const fetch of work) {
      for (const [key, gap] of [...gaps.entries()]) {
        if (
          gap.securityId === fetch.securityId &&
          gap.symbol === fetch.symbol &&
          gap.fetchFrom === fetch.fetchFrom &&
          gap.fetchTo === fetch.fetchTo
        )
          gaps.delete(key);
      }
    }
  }

  // One AGED_OUT record per range: the newest span (from this run's plan) replaces older ones.
  const agedOutKeys = new Set(
    (options.initialGaps ?? []).filter((gap) => gap.reason === TENMIN_AGED_OUT).map(gapKey),
  );
  if (agedOutKeys.size)
    for (const [key, gap] of [...gaps.entries()])
      if (gap.reason === TENMIN_AGED_OUT && !agedOutKeys.has(key)) gaps.delete(key);

  const hints = new Map(
    (await loadTenMinRangeProgress(root, from, to)).map((entry) => [
      fetchIdentityKey({ securityId: entry.securityId, ...entry.fetch }),
      entry,
    ]),
  );
  const stored = await listStoredTenMinRange(store, from, to);
  const storedBySecurity = groupStoredFetchesBySecurity(stored);
  const securitiesWritten = new Set<string>();
  const securitiesResumed = new Set<string>();
  let fetchesWritten = 0;
  let fetchesResumed = 0;
  let filesWritten = 0;
  let fallbackFiles = 0;
  let massiveRequests = 0;
  let yieldedForScan: string | undefined;
  let outageStop: string | undefined;
  let outageStreak = 0;
  const outageKeys: string[] = [];

  const clearOutageStreakGaps = (): void => {
    for (const key of outageKeys) gaps.delete(key);
    outageKeys.length = 0;
  };

  for (const planned of work) {
    if (options.shouldYield) {
      const reason = await options.shouldYield();
      if (reason) {
        yieldedForScan = reason;
        break;
      }
    }
    if (!planned.symbol) {
      const gap = {
        securityId: planned.securityId,
        symbol: "",
        reason: "NO_HISTORICAL_SYMBOL",
        at: stamp(),
      };
      gaps.set(gapKey(gap), gap);
      continue;
    }

    const idKey = fetchIdentityKey(planned);
    const securityRefs = storedBySecurity.get(planned.securityId) ?? [];
    const candidates = compatibleStoredFetches(securityRefs, planned);
    let resumed = false;
    for (const candidate of candidates) {
      const hintEntry = hints.get(candidate.key);
      const hint =
        hintEntry?.fetch ??
        existing?.securities
          .find((s) => s.securityId === planned.securityId)
          ?.fetches.find(
            (f) =>
              f.symbol === candidate.symbol &&
              f.fetchFrom === candidate.fetchFrom &&
              f.fetchTo === candidate.fetchTo,
          );
      const verified = await verifyStoredTenMinRangeFetch(
        store,
        from,
        to,
        {
          securityId: planned.securityId,
          symbol: candidate.symbol,
          fetchFrom: candidate.fetchFrom,
          fetchTo: candidate.fetchTo,
        },
        {
          provider,
          storedPages: candidate.pages,
          backend,
          ...(hint ? { hint } : {}),
        },
      );
      if (verified) {
        // Keep the REAL stored span in the manifest (may start before today's planned fetchFrom).
        doneFetches.set(candidate.key, { securityId: planned.securityId, fetch: verified });
        fetchesResumed += 1;
        securitiesResumed.add(planned.securityId);
        outageStreak = 0;
        clearOutageStreakGaps();
        resumed = true;
        break;
      }
    }
    if (resumed) continue;

    // Different ticker leftovers for this security (not a compatible earlier-from span): warn once.
    const plannedSymbols = new Set(
      options.fetches.filter((f) => f.securityId === planned.securityId).map((f) => f.symbol),
    );
    for (const ref of securityRefs) {
      if (ref.symbol === planned.symbol) continue;
      if (plannedSymbols.has(ref.symbol)) continue;
      if (!ref.pages.has(1)) continue;
      warnings.push(
        `TENMIN_RANGE_SYMBOL_CHANGED:${planned.securityId}:${ref.symbol}:${planned.symbol}`,
      );
    }

    try {
      massiveRequests += 1;
      const pages = await options.fetchPages(
        { securityId: planned.securityId, symbol: planned.symbol },
        planned.fetchFrom,
        planned.fetchTo,
      );
      const { fetch } = await writeTenMinRangeFetch(store, pages, {
        provider,
        calendarFrom: from,
        calendarTo: to,
        fetchFrom: planned.fetchFrom,
        fetchTo: planned.fetchTo,
        backend,
        ...(options.securityLink ? { link: options.securityLink.source } : {}),
      });
      filesWritten += fetch.files.length;
      fallbackFiles += fetch.files.filter((file) => file.version === REPLY_DUST_FALLBACK_VERSION).length;
      await appendTenMinRangeProgress(root, from, to, { securityId: planned.securityId, fetch });
      doneFetches.set(idKey, { securityId: planned.securityId, fetch });
      fetchesWritten += 1;
      securitiesWritten.add(planned.securityId);
      outageStreak = 0;
      clearOutageStreakGaps();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTenMinRangeAbortError(message)) throw error;
      if (
        message.startsWith("R2_") ||
        message.startsWith("STORE_") ||
        message === "STORE_DOWN" ||
        message.startsWith("REPLY_DUST_") ||
        message.startsWith("OBJECT_STORE")
      )
        throw error;

      if (isTenMinRangeOutageError(message)) {
        outageStreak += 1;
        if (outageStreak >= TENMIN_RANGE_OUTAGE_STREAK) {
          clearOutageStreakGaps();
          outageStop = `${TENMIN_RANGE_OUTAGE_STOP}:${message}`;
          break;
        }
        // Do not record as a durable gap yet; streak failures are retried next run.
        continue;
      }

      outageStreak = 0;
      clearOutageStreakGaps();
      const siblings = options.fetches.filter((f) => f.securityId === planned.securityId);
      const reason =
        siblings.length > 1
          ? `SYMBOL_PARTIAL:${tenMinRangeGapReason(message)}`
          : tenMinRangeGapReason(message);
      const gap: TenMinRangeGapEntry = {
        securityId: planned.securityId,
        symbol: planned.symbol,
        reason,
        at: stamp(),
        fetchFrom: planned.fetchFrom,
        fetchTo: planned.fetchTo,
      };
      gaps.set(gapKey(gap), gap);
    }
  }

  if (yieldedForScan || outageStop) {
    return {
      manifest: existing,
      alreadySealed: false,
      sealed: false,
      securitiesWritten: [...securitiesWritten],
      securitiesResumed: [...securitiesResumed],
      fetchesWritten,
      fetchesResumed,
      gaps: [...gaps.values()].sort(
        (a, b) => byCodeUnit(a.securityId, b.securityId) || byCodeUnit(a.symbol, b.symbol),
      ),
      filesWritten,
      fallbackFiles,
      zstdVersion,
      massiveRequests,
      ...(yieldedForScan ? { yieldedForScan } : {}),
      ...(outageStop ? { outageStop } : {}),
      ...(warnings.length || fallbackFiles > 0
        ? {
            warnings: [
              ...warnings,
              ...(fallbackFiles > 0 ? [`${REPLY_DUST_FALLBACK_WARNING}:${fallbackFiles}`] : []),
            ],
          }
        : {}),
    };
  }

  const manifest = buildTenMinRangeManifest({
    provider,
    from,
    to,
    securities: groupSecurities(doneFetches),
    gaps: [...gaps.values()],
    ...(options.securityLink ? { securityLink: options.securityLink } : {}),
  });
  if (isEmptyTenMinRangeManifest(manifest))
    throw new Error(
      `${TENMIN_UNIVERSE_EMPTY}:${from}_${to}:planned=${options.fetches.length}:gaps=${manifest.gaps.length}`,
    );
  await writeTenMinRangeManifest(store, manifest);
  await rm(tenMinRangeProgressPath(root, from, to), { force: true });
  return {
    manifest,
    alreadySealed: false,
    sealed: true,
    securitiesWritten: [...securitiesWritten],
    securitiesResumed: [...securitiesResumed],
    fetchesWritten,
    fetchesResumed,
    gaps: [...manifest.gaps],
    filesWritten,
    fallbackFiles,
    zstdVersion,
    massiveRequests,
    ...(warnings.length || fallbackFiles > 0
      ? {
          warnings: [
            ...warnings,
            ...(fallbackFiles > 0 ? [`${REPLY_DUST_FALLBACK_WARNING}:${fallbackFiles}`] : []),
          ],
        }
      : {}),
  };
}

export interface TenMinRangeVerifiedPage {
  page: number;
  file: TenMinRangeFileEntry;
  reply: Uint8Array;
  fetch: TenMinRangeTickerFetch;
}

function requireManifest(manifest: TenMinRangeManifest | undefined): TenMinRangeManifest {
  if (!manifest) throw Object.assign(new Error("REPLY_DUST_MANIFEST_MISSING"), { code: "ENOENT" });
  return manifest;
}

async function readFetchPages(
  store: ReplyDustStore,
  manifest: TenMinRangeManifest,
  securityId: string,
  fetch: TenMinRangeTickerFetch,
  backend: ReplyDustBackend,
): Promise<TenMinRangeVerifiedPage[]> {
  const output: TenMinRangeVerifiedPage[] = [];
  for (const file of fetch.files) {
    const bytes = await store.get(
      `${tenMinRangePrefix(manifest.rangeFrom, manifest.rangeTo)}/${file.relativePath}`,
    );
    if (!bytes) throw new Error(`REPLY_DUST_FILE_MISSING:${securityId}:${fetch.symbol}:p${file.page}`);
    output.push({
      page: file.page,
      file,
      reply: verifyRangeBytes(bytes, file, backend, `${securityId}:${fetch.symbol}`),
      fetch,
    });
  }
  return output;
}

export async function readRangeReplies(
  store: ReplyDustStore,
  from: string,
  to: string,
  securityId: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<TenMinRangeVerifiedPage[]> {
  const manifest = requireManifest(await readTenMinRangeManifest(store, from, to));
  const security = manifest.securities.find((entry) => entry.securityId === securityId);
  if (!security) return [];
  const output: TenMinRangeVerifiedPage[] = [];
  for (const fetch of security.fetches)
    output.push(...(await readFetchPages(store, manifest, securityId, fetch, backend)));
  return output;
}

/**
 * Canonical 10-minute bars for one security's session: merge bars across that security's ticker
 * fetches for the day. Sub-spans do not overlap, so at most one fetch contributes bars per day.
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
  const contributors = security.fetches.filter((f) => f.sessionDates.includes(sessionDate));
  if (contributors.length > 1)
    throw new Error(`TENMIN_RANGE_OVERLAPPING_FETCHES:${securityId}:${sessionDate}`);
  const fetch = contributors[0] ?? security.fetches.find(
    (f) => sessionDate >= f.fetchFrom && sessionDate <= f.fetchTo,
  );
  if (!fetch) {
    // Listed security with no fetch covering the day: empty-day bars via first fetch's symbol if any.
    const any = security.fetches[0];
    if (!any) return [];
    return massiveTenMinuteBarsFromReply({
      provider: manifest.provider,
      sessionDate,
      securityId,
      symbol: any.symbol,
      reply: { results: [] },
      observedAt: any.observedAt,
    });
  }
  const pages = await readFetchPages(store, manifest, securityId, fetch, backend);
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
    symbol: fetch.symbol,
    reply: { results, ...(requestId === undefined ? {} : { request_id: requestId }) },
    observedAt: fetch.observedAt,
  });
}
