// Ten-minute range compact entries (Phase 1 "manifest v2"): binary locator records for stored
// fetches, plus a small JSON pointer manifest. Fat JSON manifests
// (schema tenmin-range-reply-dust-manifest-v2) remain the writer output until a later commit;
// this module is encoder/decoder + reader only.
//
// Layout:
//   permanent/tenmin-reply-dust/<calFrom>_<calTo>/
//     manifest.json                         — fat (today) OR compact pointer (this schema)
//     entries-<sha256hex>.bin.zst            — sha256 of the *uncompressed* body (TRI pattern)
//     <b64(securityId)>.<b64(symbol)>.<from>_<to>[.pN].rdust
//     <b64(securityId)>.<b64(symbol)>.<from>_<to>.c<sha256hex>.rdust   — hashed copy
//
// Entries object name uses sha256 of the uncompressed binary body. Stored bytes are raw zstd
// (no dictionary), same as ticker-reference-index parts.

import {
  TENMIN_AGED_OUT,
  TENMIN_DELISTED_COVERAGE_MISSING,
  type TenMinDelistedCoverage,
  type TenMinRangeGapEntry,
  type TenMinRangeManifest,
  type TenMinRangeSecurityEntry,
  type TenMinRangeTickerFetch,
  type TenMinSecurityLink,
  tenMinRangeDelistedCoverage,
  tenMinRangeFileKey,
  tenMinRangeFileName,
  tenMinRangeManifestKey,
  tenMinRangePrefix,
} from "./tenmin-range-reply-dust";
import { GROUPED_DAILY_MISSING } from "./tenmin-grouped-daily";
import { type ReplyDustStore, sameBytes, sha256Hex } from "./intraday-reply-dust";
import type { ObjectMetadata } from "./object-store";
import { type ReplyDustBackend, nodeReplyDustBackend } from "./reply-dust";
import { TENMIN_RANGE_PAGE_CAP } from "./massive-provider";

/** Fat JSON manifest still written by the range writer (historical schema id). Architect "v1". */
export const TENMIN_RANGE_MANIFEST_FAT_SCHEMA = "tenmin-range-reply-dust-manifest-v2" as const;
/** Compact pointer manifest (entries object). Architect Phase-1 "manifest v2". */
export const TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA = "tenmin-range-reply-dust-manifest-compact-v2" as const;
/** Binary entries body schema (header schemaVersion field). */
export const TENMIN_RANGE_ENTRIES_SCHEMA_VERSION = 1 as const;
/** Frozen object-key derivation rule. Unknown keyRule => refuse (do not guess). */
export const TENMIN_RANGE_KEY_RULE = 1 as const;

export const TENMIN_RANGE_ENTRIES_MAGIC = new Uint8Array([0x54, 0x4d, 0x45, 0x01]); // "TME\x01"
export const TENMIN_RANGE_ENTRIES_FIELD_ORDER = 3 as const; // securityId,symbol,from,to,pageNumber,pageCount,sha256,byteLength,status[+OTHER],copy
export const TENMIN_RANGE_ENTRIES_BYTE_ORDER_LE = 1 as const;

export const TENMIN_MANIFEST_V2_ENTRIES_FALLBACK = "TENMIN_MANIFEST_V2_ENTRIES_FALLBACK" as const;
/** Reader: a fetch's pages 1..pageCount are incomplete in entries or fallback listing. */
export const TENMIN_MANIFEST_V2_PAGE_MISSING = "TENMIN_MANIFEST_V2_PAGE_MISSING" as const;

/** Successful stored fetch (not a gap). Part of the frozen status code table. */
export const TENMIN_RANGE_STATUS_STORED = "STORED" as const;
/** Same string as tenmin-range-reply-dust / tenmin-history gap writers. */
export const TENMIN_NO_HISTORICAL_SYMBOL = "NO_HISTORICAL_SYMBOL" as const;
export const TENMIN_NO_DAILY_BAR_STATUS = "NO_DAILY_BAR" as const;
/** Fallback when tenMinRangeGapReason cannot extract a leading error code. */
export const TENMIN_RANGE_FETCH_FAILED = "TENMIN_RANGE_FETCH_FAILED" as const;
/**
 * Reserved wire code for any reason not in the fixed table. The record carries the exact
 * reason string (UTF-8 length-prefixed) so dynamic reasons (MASSIVE_HTTP_404,
 * SYMBOL_PARTIAL:MASSIVE_HTTP_429, …) round-trip byte-exact. Drop no information.
 */
export const TENMIN_RANGE_STATUS_OTHER = "OTHER" as const;

/**
 * Frozen status/gap reason → u16 code. Fixed codes cover every literal reason the writers
 * emit today; OTHER (7) carries an arbitrary exact reason string on the wire.
 * Encode of any well-formed reason never throws (unknown → OTHER + string).
 * Decode of an unknown numeric code throws.
 */
export const TENMIN_RANGE_STATUS_CODES = {
  [TENMIN_RANGE_STATUS_STORED]: 1,
  [GROUPED_DAILY_MISSING]: 2,
  [TENMIN_AGED_OUT]: 3,
  [TENMIN_NO_HISTORICAL_SYMBOL]: 4,
  [TENMIN_NO_DAILY_BAR_STATUS]: 5,
  [TENMIN_RANGE_FETCH_FAILED]: 6,
  [TENMIN_RANGE_STATUS_OTHER]: 7,
} as const;

/** Fixed reasons that encode as a code alone (no detail string). Excludes OTHER. */
export const TENMIN_RANGE_STATUS_FIXED = {
  [TENMIN_RANGE_STATUS_STORED]: 1,
  [GROUPED_DAILY_MISSING]: 2,
  [TENMIN_AGED_OUT]: 3,
  [TENMIN_NO_HISTORICAL_SYMBOL]: 4,
  [TENMIN_NO_DAILY_BAR_STATUS]: 5,
  [TENMIN_RANGE_FETCH_FAILED]: 6,
} as const;

export type TenMinRangeStatusFixedReason = keyof typeof TENMIN_RANGE_STATUS_FIXED;

const STATUS_BY_CODE: ReadonlyMap<number, string> = new Map(
  (Object.entries(TENMIN_RANGE_STATUS_CODES) as Array<[string, number]>).map(
    ([reason, code]) => [code, reason],
  ),
);

export interface TenMinRangeEntryRecord {
  securityId: string;
  symbol: string;
  fetchFrom: string;
  fetchTo: string;
  /** 1-based page index for this object (one record per page). */
  pageNumber: number;
  /** Total pages in this fetch (same on every page record of the fetch). */
  pageCount: number;
  /** Full reply sha256 (64 hex) of *this page's* stored object. */
  replySha256: string;
  /** Stored .rdust file byte length for this page. */
  byteLength: number;
  /**
   * Exact status/gap reason string (never dropped). Fixed reasons use a compact wire code;
   * anything else uses OTHER + this string on the wire.
   */
  status: string;
  /**
   * 0 / undefined = canonical first copy (key via keyRule).
   * Otherwise the copy identity sha256 (64 hex) used in the hashed-copy object key.
   */
  copySha256?: string;
}

export interface TenMinRangeEntriesBody {
  schemaVersion: typeof TENMIN_RANGE_ENTRIES_SCHEMA_VERSION;
  records: TenMinRangeEntryRecord[];
}

export interface TenMinRangeCompactManifest {
  schemaVersion: typeof TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA;
  format: "REPLY_DUST_V1_ZSTD19_DICT4K";
  provider: string;
  rangeFrom: string;
  rangeTo: string;
  keyRule: typeof TENMIN_RANGE_KEY_RULE;
  securityCount: number;
  fileCount: number;
  fallbackFileCount: number;
  gaps: Array<{
    securityId: string;
    symbol: string;
    reason: string;
    at: string;
    fetchFrom?: string;
    fetchTo?: string;
  }>;
  securityLink?: "PROVISIONAL";
  securityLinkSource?: string;
  delistedCoverage?: "MISSING" | "COMPLETE";
  /** Object key of the entries blob under the range prefix (or absolute permanent/... key). */
  entriesKey: string;
  /** sha256 hex of the *uncompressed* entries body (TRI pattern). */
  entriesSha256: string;
  /** Compressed (.bin.zst) byte length. */
  entriesByteLength: number;
  checksum: string;
}

const EPOCH = Date.UTC(1970, 0, 1);

function requireDate(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) throw new Error("INVALID_RANGE");
}

export function daysSinceEpoch(iso: string): number {
  requireDate(iso);
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error("INVALID_RANGE");
  return Math.round((ms - EPOCH) / 86_400_000);
}

export function dateFromDaysSinceEpoch(days: number): string {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error("INVALID_RANGE");
  return new Date(EPOCH + days * 86_400_000).toISOString().slice(0, 10);
}

/** Wire code for a reason. Unknown / dynamic reasons map to OTHER (never throws). */
export function statusCodeOf(reason: string): number {
  const fixed = (TENMIN_RANGE_STATUS_FIXED as Record<string, number>)[reason];
  if (fixed !== undefined) return fixed;
  return TENMIN_RANGE_STATUS_CODES[TENMIN_RANGE_STATUS_OTHER];
}

export function isOtherStatusCode(code: number): boolean {
  return code === TENMIN_RANGE_STATUS_CODES[TENMIN_RANGE_STATUS_OTHER];
}

/**
 * Map a wire status code back to a reason string.
 * For OTHER, `otherDetail` is required and is returned as the exact reason.
 * Unknown numeric codes throw.
 */
export function statusReasonOf(code: number, otherDetail?: string): string {
  if (isOtherStatusCode(code)) {
    if (otherDetail === undefined)
      throw new Error("TENMIN_RANGE_STATUS_OTHER_DETAIL_REQUIRED");
    return otherDetail;
  }
  const reason = STATUS_BY_CODE.get(code);
  if (!reason || reason === TENMIN_RANGE_STATUS_OTHER)
    throw new Error(`TENMIN_RANGE_STATUS_UNKNOWN_CODE:${code}`);
  return reason;
}

/**
 * Hashed-copy object name (keyRule 1): strip `.rdust` from the canonical page name, append
 * `.c` + full copy sha256 hex + `.rdust`.
 *   page 1 → `<base>.c<sha>.rdust`
 *   page N → `<base>.pN.c<sha>.rdust`
 */
export function tenMinRangeHashedCopyFileName(
  securityId: string,
  symbol: string,
  fetchFrom: string,
  fetchTo: string,
  copySha256: string,
  page: number = 1,
): string {
  if (!/^[0-9a-f]{64}$/u.test(copySha256)) throw new Error("INVALID_COPY_SHA256");
  requireDate(fetchFrom);
  requireDate(fetchTo);
  const base = tenMinRangeFileName(securityId, symbol, fetchFrom, fetchTo, page).replace(/\.rdust$/u, "");
  return `${base}.c${copySha256}.rdust`;
}

export function tenMinRangeHashedCopyFileKey(
  calendarFrom: string,
  calendarTo: string,
  securityId: string,
  symbol: string,
  fetchFrom: string,
  fetchTo: string,
  copySha256: string,
  page: number = 1,
): string {
  return `${tenMinRangePrefix(calendarFrom, calendarTo)}/${tenMinRangeHashedCopyFileName(securityId, symbol, fetchFrom, fetchTo, copySha256, page)}`;
}

/** Resolve object key for one entries page record under keyRule 1. */
export function resolveTenMinRangeEntryKey(
  calendarFrom: string,
  calendarTo: string,
  record: TenMinRangeEntryRecord,
  keyRule: number = TENMIN_RANGE_KEY_RULE,
): string {
  if (keyRule !== TENMIN_RANGE_KEY_RULE)
    throw new Error(`TENMIN_RANGE_KEY_RULE_UNKNOWN:${keyRule}`);
  const page = record.pageNumber;
  if (record.copySha256)
    return tenMinRangeHashedCopyFileKey(
      calendarFrom,
      calendarTo,
      record.securityId,
      record.symbol,
      record.fetchFrom,
      record.fetchTo,
      record.copySha256,
      page,
    );
  return tenMinRangeFileKey(
    calendarFrom,
    calendarTo,
    record.securityId,
    record.symbol,
    record.fetchFrom,
    record.fetchTo,
    page,
  );
}

export function tenMinRangeEntriesObjectKey(calendarFrom: string, calendarTo: string, bodySha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(bodySha256)) throw new Error("INVALID_ENTRIES_SHA256");
  return `${tenMinRangePrefix(calendarFrom, calendarTo)}/entries-${bodySha256}.bin.zst`;
}

/** Deterministic order: securityId, symbol, fetchFrom, fetchTo, copySha256, pageNumber. */
function compareRecords(a: TenMinRangeEntryRecord, b: TenMinRangeEntryRecord): number {
  if (a.securityId < b.securityId) return -1;
  if (a.securityId > b.securityId) return 1;
  if (a.symbol < b.symbol) return -1;
  if (a.symbol > b.symbol) return 1;
  if (a.fetchFrom < b.fetchFrom) return -1;
  if (a.fetchFrom > b.fetchFrom) return 1;
  if (a.fetchTo < b.fetchTo) return -1;
  if (a.fetchTo > b.fetchTo) return 1;
  const ac = a.copySha256 ?? "";
  const bc = b.copySha256 ?? "";
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  return a.pageNumber - b.pageNumber;
}

function fetchGroupKey(r: TenMinRangeEntryRecord): string {
  return `${r.securityId}\0${r.symbol}\0${r.fetchFrom}\0${r.fetchTo}\0${r.copySha256 ?? ""}`;
}

/**
 * Every fetch group must have pages 1..pageCount exactly once with a consistent pageCount.
 * Returns TENMIN_MANIFEST_V2_PAGE_MISSING:… strings for each hole (never silent).
 */
export function validateTenMinRangeEntriesPages(records: readonly TenMinRangeEntryRecord[]): string[] {
  const groups = new Map<string, TenMinRangeEntryRecord[]>();
  for (const r of records) {
    const list = groups.get(fetchGroupKey(r)) ?? [];
    list.push(r);
    groups.set(fetchGroupKey(r), list);
  }
  const missing: string[] = [];
  for (const [, pages] of groups) {
    const head = pages[0]!;
    const tag = `${head.securityId}:${head.symbol}:${head.fetchFrom}_${head.fetchTo}`;
    const pageCount = head.pageCount;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > TENMIN_RANGE_PAGE_CAP) {
      missing.push(`${TENMIN_MANIFEST_V2_PAGE_MISSING}:${tag}:badPageCount=${pageCount}`);
      continue;
    }
    if (pages.some((p) => p.pageCount !== pageCount)) {
      missing.push(`${TENMIN_MANIFEST_V2_PAGE_MISSING}:${tag}:inconsistentPageCount`);
    }
    // Count pageNumbers — a Set would hide two records for the same page with different sha.
    const pageCounts = new Map<number, number>();
    for (const p of pages) {
      pageCounts.set(p.pageNumber, (pageCounts.get(p.pageNumber) ?? 0) + 1);
    }
    for (const [n, count] of pageCounts) {
      if (count > 1) missing.push(`${TENMIN_MANIFEST_V2_PAGE_MISSING}:${tag}:dupPage=${n}`);
    }
    for (let n = 1; n <= pageCount; n++) {
      if (!pageCounts.has(n))
        missing.push(`${TENMIN_MANIFEST_V2_PAGE_MISSING}:${tag}:page=${n}`);
    }
    for (const p of pages) {
      if (!Number.isSafeInteger(p.pageNumber) || p.pageNumber < 1 || p.pageNumber > pageCount)
        missing.push(`${TENMIN_MANIFEST_V2_PAGE_MISSING}:${tag}:badPageNumber=${p.pageNumber}`);
    }
  }
  return missing;
}

/** Encoder refuses duplicate pageNumber within the same fetch+copy group. */
export const TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE = "TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE" as const;

export function assertNoDuplicateTenMinRangeEntryPages(records: readonly TenMinRangeEntryRecord[]): void {
  const dup = validateTenMinRangeEntriesPages(records).find((h) => h.includes(":dupPage="));
  if (dup) throw new Error(`${TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE}:${dup}`);
}

/** Sort records into the deterministic encode order (mutates a copy). */
export function sortTenMinRangeEntries(records: readonly TenMinRangeEntryRecord[]): TenMinRangeEntryRecord[] {
  return [...records].sort(compareRecords);
}

function writeU16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}
function writeU32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value, true);
  return offset + 4;
}
function writeBytes(buf: Uint8Array, offset: number, bytes: Uint8Array): number {
  buf.set(bytes, offset);
  return offset + bytes.length;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new Error("INVALID_SHA256_HEX");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Encode the uncompressed entries body (deterministic). Does not compress.
 * Header: magic(4) | schemaVersion u16 | recordCount u32 | fieldOrder u16 | byteOrder u8.
 */
export function encodeTenMinRangeEntriesBody(records: readonly TenMinRangeEntryRecord[]): Uint8Array {
  assertNoDuplicateTenMinRangeEntryPages(records);
  const sorted = sortTenMinRangeEntries(records);
  const parts: Uint8Array[] = [];
  for (const r of sorted) {
    if (typeof r.status !== "string") throw new Error("TENMIN_RANGE_STATUS_NOT_STRING");
    if (r.copySha256 !== undefined && !/^[0-9a-f]{64}$/u.test(r.copySha256))
      throw new Error("INVALID_COPY_SHA256");
    const sid = utf8(r.securityId);
    const sym = utf8(r.symbol);
    const statusCode = statusCodeOf(r.status);
    const otherDetail = isOtherStatusCode(statusCode) ? utf8(r.status) : undefined;
    if (sid.length > 0xffff || sym.length > 0xffff || (otherDetail && otherDetail.length > 0xffff))
      throw new Error("TENMIN_RANGE_ENTRIES_STRING_TOO_LONG");
    if (!Number.isSafeInteger(r.pageNumber) || r.pageNumber < 1 || r.pageNumber > TENMIN_RANGE_PAGE_CAP)
      throw new Error(`TENMIN_RANGE_ENTRIES_BAD_PAGE:${r.pageNumber}`);
    if (!Number.isSafeInteger(r.pageCount) || r.pageCount < 1 || r.pageCount > TENMIN_RANGE_PAGE_CAP)
      throw new Error(`TENMIN_RANGE_ENTRIES_BAD_PAGE_COUNT:${r.pageCount}`);
    if (r.pageNumber > r.pageCount) throw new Error(`TENMIN_RANGE_ENTRIES_PAGE_GT_COUNT:${r.pageNumber}>${r.pageCount}`);
    const reply = hexToBytes(r.replySha256);
    const copyFlag = r.copySha256 ? 1 : 0;
    const copyBytes = r.copySha256 ? hexToBytes(r.copySha256) : undefined;
    const size =
      2 +
      sid.length +
      2 +
      sym.length +
      4 +
      4 +
      2 +
      2 +
      32 +
      4 +
      2 +
      (otherDetail ? 2 + otherDetail.length : 0) +
      1 +
      (copyBytes ? 32 : 0);
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    let o = 0;
    o = writeU16(view, o, sid.length);
    o = writeBytes(buf, o, sid);
    o = writeU16(view, o, sym.length);
    o = writeBytes(buf, o, sym);
    o = writeU32(view, o, daysSinceEpoch(r.fetchFrom));
    o = writeU32(view, o, daysSinceEpoch(r.fetchTo));
    o = writeU16(view, o, r.pageNumber);
    o = writeU16(view, o, r.pageCount);
    o = writeBytes(buf, o, reply);
    o = writeU32(view, o, r.byteLength >>> 0);
    o = writeU16(view, o, statusCode);
    if (otherDetail) {
      o = writeU16(view, o, otherDetail.length);
      o = writeBytes(buf, o, otherDetail);
    }
    buf[o++] = copyFlag;
    if (copyBytes) o = writeBytes(buf, o, copyBytes);
    parts.push(buf);
  }
  const recordsBytes = parts.reduce((n, p) => n + p.length, 0);
  const headerLen = 4 + 2 + 4 + 2 + 1;
  const out = new Uint8Array(headerLen + recordsBytes);
  out.set(TENMIN_RANGE_ENTRIES_MAGIC, 0);
  const view = new DataView(out.buffer);
  let o = 4;
  o = writeU16(view, o, TENMIN_RANGE_ENTRIES_SCHEMA_VERSION);
  o = writeU32(view, o, sorted.length);
  o = writeU16(view, o, TENMIN_RANGE_ENTRIES_FIELD_ORDER);
  out[o++] = TENMIN_RANGE_ENTRIES_BYTE_ORDER_LE;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

export function decodeTenMinRangeEntriesBody(body: Uint8Array): TenMinRangeEntriesBody {
  if (body.length < 13) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
  for (let i = 0; i < 4; i++)
    if (body[i] !== TENMIN_RANGE_ENTRIES_MAGIC[i]) throw new Error("TENMIN_RANGE_ENTRIES_BAD_MAGIC");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let o = 4;
  const schemaVersion = view.getUint16(o, true);
  o += 2;
  if (schemaVersion !== TENMIN_RANGE_ENTRIES_SCHEMA_VERSION)
    throw new Error(`TENMIN_RANGE_ENTRIES_SCHEMA:${schemaVersion}`);
  const recordCount = view.getUint32(o, true);
  o += 4;
  const fieldOrder = view.getUint16(o, true);
  o += 2;
  if (fieldOrder !== TENMIN_RANGE_ENTRIES_FIELD_ORDER)
    throw new Error(`TENMIN_RANGE_ENTRIES_FIELD_ORDER:${fieldOrder}`);
  const byteOrder = body[o++];
  if (byteOrder !== TENMIN_RANGE_ENTRIES_BYTE_ORDER_LE)
    throw new Error(`TENMIN_RANGE_ENTRIES_BYTE_ORDER:${byteOrder}`);
  const records: TenMinRangeEntryRecord[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < recordCount; i++) {
    if (o + 2 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
    const sidLen = view.getUint16(o, true);
    o += 2;
    if (o + sidLen + 2 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
    const securityId = decoder.decode(body.subarray(o, o + sidLen));
    o += sidLen;
    const symLen = view.getUint16(o, true);
    o += 2;
    if (o + symLen + 4 + 4 + 2 + 2 + 32 + 4 + 2 + 1 > body.length)
      throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
    const symbol = decoder.decode(body.subarray(o, o + symLen));
    o += symLen;
    const fetchFrom = dateFromDaysSinceEpoch(view.getUint32(o, true));
    o += 4;
    const fetchTo = dateFromDaysSinceEpoch(view.getUint32(o, true));
    o += 4;
    const pageNumber = view.getUint16(o, true);
    o += 2;
    const pageCount = view.getUint16(o, true);
    o += 2;
    const replySha256 = bytesToHex(body.subarray(o, o + 32));
    o += 32;
    const byteLength = view.getUint32(o, true);
    o += 4;
    if (o + 2 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
    const statusCode = view.getUint16(o, true);
    o += 2;
    let status: string;
    if (isOtherStatusCode(statusCode)) {
      if (o + 2 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
      const detailLen = view.getUint16(o, true);
      o += 2;
      if (o + detailLen + 1 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
      status = statusReasonOf(statusCode, decoder.decode(body.subarray(o, o + detailLen)));
      o += detailLen;
    } else {
      status = statusReasonOf(statusCode);
    }
    if (o + 1 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
    const copyFlag = body[o++]!;
    let copySha256: string | undefined;
    if (copyFlag === 1) {
      if (o + 32 > body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRUNCATED");
      copySha256 = bytesToHex(body.subarray(o, o + 32));
      o += 32;
    } else if (copyFlag !== 0) throw new Error(`TENMIN_RANGE_ENTRIES_COPY_FLAG:${copyFlag}`);
    records.push({
      securityId,
      symbol,
      fetchFrom,
      fetchTo,
      pageNumber,
      pageCount,
      replySha256,
      byteLength,
      status,
      ...(copySha256 ? { copySha256 } : {}),
    });
  }
  if (o !== body.length) throw new Error("TENMIN_RANGE_ENTRIES_TRAILING_BYTES");
  if (records.length !== recordCount) throw new Error("TENMIN_RANGE_ENTRIES_COUNT_MISMATCH");
  return { schemaVersion: TENMIN_RANGE_ENTRIES_SCHEMA_VERSION, records };
}

export function compressTenMinRangeEntries(
  body: Uint8Array,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): { bodySha256: string; compressed: Uint8Array } {
  const bodySha256 = sha256Hex(body);
  const compressed = backend.compress(body, null);
  const roundTrip = backend.decompress(compressed, null);
  if (!sameBytes(roundTrip, body)) throw new Error("TENMIN_RANGE_ENTRIES_ZSTD_VERIFY_FAILED");
  return { bodySha256, compressed };
}

export function decompressTenMinRangeEntries(
  compressed: Uint8Array,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Uint8Array {
  return backend.decompress(compressed, null);
}

function compactManifestChecksum(body: Omit<TenMinRangeCompactManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(body));
}

/** Pure builder for the compact pointer JSON (writer wiring is a later commit). */
export function buildTenMinRangeCompactManifest(input: {
  provider: string;
  rangeFrom: string;
  rangeTo: string;
  records: readonly TenMinRangeEntryRecord[];
  entriesSha256: string;
  entriesByteLength: number;
  gaps?: TenMinRangeCompactManifest["gaps"];
  securityLink?: { status: "PROVISIONAL"; source: string };
  delistedCoverage?: "MISSING" | "COMPLETE";
  fallbackFileCount?: number;
}): TenMinRangeCompactManifest {
  requireDate(input.rangeFrom);
  requireDate(input.rangeTo);
  if (input.rangeFrom > input.rangeTo) throw new Error("INVALID_RANGE");
  const sorted = sortTenMinRangeEntries(input.records);
  const entriesKey = tenMinRangeEntriesObjectKey(input.rangeFrom, input.rangeTo, input.entriesSha256);
  const body: Omit<TenMinRangeCompactManifest, "checksum"> = {
    schemaVersion: TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA,
    format: "REPLY_DUST_V1_ZSTD19_DICT4K",
    provider: input.provider,
    rangeFrom: input.rangeFrom,
    rangeTo: input.rangeTo,
    keyRule: TENMIN_RANGE_KEY_RULE,
    securityCount: new Set(sorted.map((r) => r.securityId)).size,
    fileCount: sorted.length,
    fallbackFileCount: input.fallbackFileCount ?? 0,
    gaps: input.gaps ?? [],
    ...(input.securityLink
      ? { securityLink: input.securityLink.status, securityLinkSource: input.securityLink.source }
      : {}),
    ...(input.delistedCoverage ? { delistedCoverage: input.delistedCoverage } : {}),
    entriesKey,
    entriesSha256: input.entriesSha256,
    entriesByteLength: input.entriesByteLength,
  };
  return { ...body, checksum: compactManifestChecksum(body) };
}

export function parseTenMinRangeCompactManifest(bytes: Uint8Array): TenMinRangeCompactManifest {
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as TenMinRangeCompactManifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA ||
    compactManifestChecksum(body) !== checksum
  )
    throw new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH");
  if (manifest.keyRule !== TENMIN_RANGE_KEY_RULE)
    throw new Error(`TENMIN_RANGE_KEY_RULE_UNKNOWN:${manifest.keyRule}`);
  return manifest;
}

export interface TenMinRangeEntriesLoadResult {
  manifest: TenMinRangeCompactManifest;
  records: TenMinRangeEntryRecord[];
  /** Absolute object keys in the same order as records. */
  keys: string[];
  warnings: string[];
  /** True when records came from listing + rd-* metadata instead of the entries object. */
  usedFallback: boolean;
}

/**
 * Load compact-manifest entries. Verifies sha256 of uncompressed body + compressed length +
 * header recordCount. On missing/corrupt entries object: READ-ONLY rebuild from range folder
 * listing + rd-* metadata, warn, never write.
 */
export async function loadTenMinRangeEntries(
  store: ReplyDustStore,
  rangeFrom: string,
  rangeTo: string,
  options: { backend?: ReplyDustBackend; manifestBytes?: Uint8Array } = {},
): Promise<TenMinRangeEntriesLoadResult> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const raw =
    options.manifestBytes ?? (await store.get(tenMinRangeManifestKey(rangeFrom, rangeTo)));
  if (!raw) throw Object.assign(new Error("REPLY_DUST_MANIFEST_MISSING"), { code: "ENOENT" });
  const manifest = parseTenMinRangeCompactManifest(raw);
  if (manifest.rangeFrom !== rangeFrom || manifest.rangeTo !== rangeTo)
    throw new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH");

  try {
    const compressed = await store.get(manifest.entriesKey);
    if (!compressed) throw new Error("ENTRIES_MISSING");
    if (compressed.length !== manifest.entriesByteLength)
      throw new Error(`ENTRIES_LENGTH:${compressed.length}!=${manifest.entriesByteLength}`);
    const body = decompressTenMinRangeEntries(compressed, backend);
    if (sha256Hex(body) !== manifest.entriesSha256) throw new Error("ENTRIES_SHA256_MISMATCH");
    const decoded = decodeTenMinRangeEntriesBody(body);
    const headerCount = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(6, true);
    if (decoded.records.length !== headerCount)
      throw new Error("TENMIN_RANGE_ENTRIES_COUNT_MISMATCH");
    const pageHoles = validateTenMinRangeEntriesPages(decoded.records);
    if (pageHoles.length) throw new Error(pageHoles[0]!);
    const keys = decoded.records.map((r) =>
      resolveTenMinRangeEntryKey(rangeFrom, rangeTo, r, manifest.keyRule),
    );
    return { manifest, records: decoded.records, keys, warnings: [], usedFallback: false };
  } catch (error) {
    const rebuilt = await rebuildTenMinRangeEntriesFromStore(store, rangeFrom, rangeTo, {
      expectedFileCount: manifest.fileCount,
    });
    const warnings = [
      `${TENMIN_MANIFEST_V2_ENTRIES_FALLBACK}:${rangeFrom}_${rangeTo}:${String(error).slice(0, 120)}`,
      ...rebuilt.warnings,
      ...validateTenMinRangeEntriesPages(rebuilt.records),
    ];
    return {
      manifest,
      records: rebuilt.records,
      keys: rebuilt.keys,
      warnings,
      usedFallback: true,
    };
  }
}

/** READ-ONLY: rebuild entry records from every .rdust in the range folder + rd-* metadata. Never writes. */
export async function rebuildTenMinRangeEntriesFromStore(
  store: ReplyDustStore,
  rangeFrom: string,
  rangeTo: string,
  options: { expectedFileCount?: number } = {},
): Promise<{ records: TenMinRangeEntryRecord[]; keys: string[]; warnings: string[] }> {
  const prefix = `${tenMinRangePrefix(rangeFrom, rangeTo)}/`;
  const listed = await store.list(prefix);
  const records: TenMinRangeEntryRecord[] = [];
  let skippedNoMetadata = 0;
  for (const key of listed) {
    if (!key.endsWith(".rdust")) continue;
    const name = key.slice(prefix.length);
    const hashed = /\.c([0-9a-f]{64})\.rdust$/u.exec(name);
    const head = await store.head(key);
    if (!head) continue;
    const m = head.metadata ?? {};
    const securityId = m["rd-security-id"];
    const symbol = m["rd-symbol"];
    const fetchFrom = m["rd-fetch-from"];
    const fetchTo = m["rd-fetch-to"];
    const replySha256 = m["rd-reply-sha256"];
    const pageRaw = m["rd-page"];
    const pageCountRaw = m["rd-page-count"];
    if (!securityId || !symbol || !fetchFrom || !fetchTo || !replySha256 || !pageRaw) {
      skippedNoMetadata += 1;
      continue;
    }
    const pageNumber = Number(pageRaw);
    const pageCount = pageCountRaw !== undefined ? Number(pageCountRaw) : 1;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      skippedNoMetadata += 1;
      continue;
    }
    const copySha256 = hashed?.[1];
    records.push({
      securityId,
      symbol,
      fetchFrom,
      fetchTo,
      pageNumber,
      pageCount: Number.isSafeInteger(pageCount) && pageCount >= 1 ? pageCount : 1,
      replySha256,
      byteLength: head.size,
      status: TENMIN_RANGE_STATUS_STORED,
      ...(copySha256 ? { copySha256 } : {}),
    });
  }
  const sorted = sortTenMinRangeEntries(records);
  const warnings: string[] = [];
  if (skippedNoMetadata > 0)
    warnings.push(`${TENMIN_MANIFEST_V2_ENTRIES_FALLBACK}:skippedNoMetadata=${skippedNoMetadata}`);
  if (
    options.expectedFileCount !== undefined &&
    Number.isSafeInteger(options.expectedFileCount) &&
    sorted.length < options.expectedFileCount
  ) {
    warnings.push(
      `${TENMIN_MANIFEST_V2_ENTRIES_FALLBACK}:fallbackShortfall=${options.expectedFileCount}-${sorted.length}`,
    );
  }
  return {
    records: sorted,
    keys: sorted.map((r) => resolveTenMinRangeEntryKey(rangeFrom, rangeTo, r)),
    warnings,
  };
}


const ZERO_REPLY_SHA256 = "0".repeat(64);

/** Build per-page STORED records + one record per gap (exact status; no object → zero sha / 0 length). */
export function buildTenMinRangeEntryRecordsFromState(input: {
  from: string;
  to: string;
  doneFetches: ReadonlyMap<string, { securityId: string; fetch: TenMinRangeTickerFetch }>;
  gaps: readonly TenMinRangeGapEntry[];
}): TenMinRangeEntryRecord[] {
  const records: TenMinRangeEntryRecord[] = [];
  for (const { securityId, fetch } of input.doneFetches.values()) {
    for (const file of fetch.files) {
      records.push({
        securityId,
        symbol: fetch.symbol,
        fetchFrom: fetch.fetchFrom,
        fetchTo: fetch.fetchTo,
        pageNumber: file.page,
        pageCount: fetch.pageCount,
        replySha256: file.replySha256,
        byteLength: file.byteLength,
        status: TENMIN_RANGE_STATUS_STORED,
      });
    }
  }
  for (const gap of input.gaps) {
    records.push({
      securityId: gap.securityId,
      symbol: gap.symbol,
      fetchFrom: gap.fetchFrom ?? input.from,
      fetchTo: gap.fetchTo ?? input.to,
      pageNumber: 1,
      pageCount: 1,
      replySha256: ZERO_REPLY_SHA256,
      byteLength: 0,
      status: gap.reason,
    });
  }
  return sortTenMinRangeEntries(records);
}

/**
 * Hydrate a fat-compatible TenMinRangeManifest view from a compact pointer + entries records
 * so resume/reopen/skip-sealed consumers keep working unchanged.
 */
export function hydrateTenMinRangeManifestFromCompact(
  compact: TenMinRangeCompactManifest,
  records: readonly TenMinRangeEntryRecord[],
): TenMinRangeManifest {
  const byFetch = new Map<string, TenMinRangeEntryRecord[]>();
  for (const r of records) {
    if (r.status !== TENMIN_RANGE_STATUS_STORED) continue;
    const key = `${r.securityId}\0${r.symbol}\0${r.fetchFrom}\0${r.fetchTo}\0${r.copySha256 ?? ""}`;
    const list = byFetch.get(key) ?? [];
    list.push(r);
    byFetch.set(key, list);
  }
  const bySecurity = new Map<string, TenMinRangeTickerFetch[]>();
  for (const [, pages] of byFetch) {
    const first = pages[0]!;
    const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
    const files = ordered.map((p) => {
      const objectKey = resolveTenMinRangeEntryKey(compact.rangeFrom, compact.rangeTo, p);
      return {
        page: p.pageNumber,
        relativePath: objectKey.slice(objectKey.lastIndexOf("/") + 1),
        request: "",
        fetchedAt: "",
        byteLength: p.byteLength,
        version: 1,
        replySha256: p.replySha256,
        replyByteLength: 0,
        fileSha256: "",
        sessionDates: [] as string[],
      };
    });
    const fetch: TenMinRangeTickerFetch = {
      symbol: first.symbol,
      fetchFrom: first.fetchFrom,
      fetchTo: first.fetchTo,
      observedAt: "",
      pageCount: first.pageCount,
      files,
      sessionDates: [],
    };
    const list = bySecurity.get(first.securityId) ?? [];
    list.push(fetch);
    bySecurity.set(first.securityId, list);
  }
  const securities: TenMinRangeSecurityEntry[] = [...bySecurity.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([securityId, fetches]) => ({
      securityId,
      dataset: "stocks-aggregates-10m" as const,
      ...(compact.securityLink ? { securityLink: compact.securityLink } : {}),
      fetches,
      sessionDates: [],
    }));
  const gaps = compact.gaps.map((g) => ({ ...g }));
  return {
    schemaVersion: TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA,
    format: compact.format,
    provider: compact.provider,
    rangeFrom: compact.rangeFrom,
    rangeTo: compact.rangeTo,
    securityCount: securities.length,
    fileCount: securities.reduce((n, s) => n + s.fetches.reduce((m, f) => m + f.files.length, 0), 0),
    fallbackFileCount: compact.fallbackFileCount,
    securities,
    days: [],
    gaps,
    ...(compact.securityLink
      ? { securityLink: compact.securityLink, securityLinkSource: compact.securityLinkSource }
      : {}),
    delistedCoverage: tenMinRangeDelistedCoverage({
      delistedCoverage: compact.delistedCoverage ?? TENMIN_DELISTED_COVERAGE_MISSING,
      gaps,
    }),
    checksum: compact.checksum,
  };
}

export const TENMIN_RANGE_ENTRIES_CONFLICT = "TENMIN_RANGE_ENTRIES_CONFLICT" as const;

/**
 * Verified write of entries-<sha>.bin.zst: compress → if key exists with identical bytes reuse;
 * different bytes → conflict (never overwrite); else put → readback → decompress+decode compare
 * → HEAD metadata compare.
 */
export async function writeTenMinRangeEntriesObjectVerified(
  store: ReplyDustStore,
  calendarFrom: string,
  calendarTo: string,
  records: readonly TenMinRangeEntryRecord[],
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<{ bodySha256: string; compressed: Uint8Array; key: string; reused: boolean }> {
  const body = encodeTenMinRangeEntriesBody(records);
  const holes = validateTenMinRangeEntriesPages(records.filter((r) => r.status === TENMIN_RANGE_STATUS_STORED));
  if (holes.length) throw new Error(holes[0]!);
  const { bodySha256, compressed } = compressTenMinRangeEntries(body, backend);
  const key = tenMinRangeEntriesObjectKey(calendarFrom, calendarTo, bodySha256);
  const metadata: ObjectMetadata = {
    "rd-entries-schema": String(TENMIN_RANGE_ENTRIES_SCHEMA_VERSION),
    "rd-entries-sha256": bodySha256,
    "rd-entries-byte-length": String(compressed.length),
  };
  const existing = await store.get(key);
  if (existing) {
    if (!sameBytes(existing, compressed))
      throw new Error(`${TENMIN_RANGE_ENTRIES_CONFLICT}:${key}`);
    return { bodySha256, compressed, key, reused: true };
  }
  await store.put(key, compressed, metadata);
  const readback = await store.get(key);
  if (!readback || !sameBytes(readback, compressed))
    throw new Error(`TENMIN_RANGE_ENTRIES_READBACK_MISMATCH:${key}`);
  const decodedBody = decompressTenMinRangeEntries(readback, backend);
  if (!sameBytes(decodedBody, body)) throw new Error(`TENMIN_RANGE_ENTRIES_DECODE_MISMATCH:${key}`);
  const round = decodeTenMinRangeEntriesBody(decodedBody);
  if (JSON.stringify(round.records) !== JSON.stringify(sortTenMinRangeEntries(records)))
    throw new Error(`TENMIN_RANGE_ENTRIES_ROUNDTRIP_MISMATCH:${key}`);
  const head = await store.head(key);
  if (
    !head ||
    head.size !== compressed.length ||
    head.metadata["rd-entries-sha256"] !== bodySha256 ||
    head.metadata["rd-entries-byte-length"] !== String(compressed.length)
  )
    throw new Error(`TENMIN_RANGE_ENTRIES_METADATA_MISMATCH:${key}`);
  return { bodySha256, compressed, key, reused: false };
}

/** Verified write of compact pointer manifest.json (LAST at seal). */
export async function writeTenMinRangeCompactManifestVerified(
  store: ReplyDustStore,
  manifest: TenMinRangeCompactManifest,
): Promise<void> {
  const key = tenMinRangeManifestKey(manifest.rangeFrom, manifest.rangeTo);
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const metadata: ObjectMetadata = { "rd-manifest-checksum": manifest.checksum };
  await store.put(key, bytes, metadata);
  const readback = await store.get(key);
  if (!readback || !sameBytes(readback, bytes))
    throw new Error(`REPLY_DUST_MANIFEST_READBACK_MISMATCH:${key}`);
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata["rd-manifest-checksum"] !== manifest.checksum)
    throw new Error(`REPLY_DUST_MANIFEST_READBACK_MISMATCH:${key}`);
  // Parse+checksum verify
  parseTenMinRangeCompactManifest(readback);
}

/**
 * Seal a range as compact v2: entries object first (immutable), then manifest.json last.
 * On any failure the caller must leave the range unsealed (do not delete prior objects).
 */
export async function sealTenMinRangeCompactV2(options: {
  store: ReplyDustStore;
  provider: string;
  from: string;
  to: string;
  doneFetches: ReadonlyMap<string, { securityId: string; fetch: TenMinRangeTickerFetch }>;
  gaps: readonly TenMinRangeGapEntry[];
  securityLink?: { status: TenMinSecurityLink; source: string };
  delistedCoverage: TenMinDelistedCoverage;
  fallbackFileCount?: number;
  backend?: ReplyDustBackend;
}): Promise<{ manifest: TenMinRangeManifest; entriesKey: string; entriesSha256: string; entriesByteLength: number; reusedEntries: boolean }> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const records = buildTenMinRangeEntryRecordsFromState({
    from: options.from,
    to: options.to,
    doneFetches: options.doneFetches,
    gaps: options.gaps,
  });
  const written = await writeTenMinRangeEntriesObjectVerified(
    options.store,
    options.from,
    options.to,
    records,
    backend,
  );
  const compact = buildTenMinRangeCompactManifest({
    provider: options.provider,
    rangeFrom: options.from,
    rangeTo: options.to,
    records,
    entriesSha256: written.bodySha256,
    entriesByteLength: written.compressed.length,
    gaps: options.gaps.map((g) => ({
      securityId: g.securityId,
      symbol: g.symbol,
      reason: g.reason,
      at: g.at,
      ...(g.fetchFrom ? { fetchFrom: g.fetchFrom } : {}),
      ...(g.fetchTo ? { fetchTo: g.fetchTo } : {}),
    })),
    ...(options.securityLink ? { securityLink: options.securityLink } : {}),
    delistedCoverage: options.delistedCoverage,
    fallbackFileCount: options.fallbackFileCount ?? 0,
  });
  await writeTenMinRangeCompactManifestVerified(options.store, compact);
  return {
    manifest: hydrateTenMinRangeManifestFromCompact(compact, records),
    entriesKey: written.key,
    entriesSha256: written.bodySha256,
    entriesByteLength: written.compressed.length,
    reusedEntries: written.reused,
  };
}
