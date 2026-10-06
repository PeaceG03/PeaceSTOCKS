/**
 * Production buildBase for daily 10-minute picks: reads ONLY stored objects
 * (D's grouped-daily Reply Dust + ticker reference index with asOf ≤ D).
 * No Massive calls, no scan/prediction inputs. Holdings: empty (no source in repo).
 *
 * Error taxonomy (day stays UNSEALED; backlog steps past):
 * - Absent input → BASE_INPUT_MISSING (skip)
 * - Clear integrity failure from our readers (checksum/sha/length/version/decode/
 *   zstd/JSON) → CORRUPT (with key). Detected via StoreReadIntegrityError or known
 *   reader codes; walks error.cause. Everything else (R2 5xx, timeouts, unknown) →
 *   FAILED (retry). 404 stays MISSING via get() returning undefined.
 * Newest asOf ≤ D never falls back to an older index on corrupt/unverified/fail.
 */

import { securityId } from "./identity";
import type { ReplyDustStore } from "./intraday-reply-dust";
import {
  dailyReplyDustFileKey,
  dailyReplyDustManifestKey,
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
} from "./daily-reply-dust";
import {
  PICK_V1_ALLOWED_TYPES,
  type PickV1NamedSecurity,
  type PicksBaseV1,
  buildPicksBaseV1,
} from "./tenmin-daily-picks";
import { TENMIN_DAY_OBJECT_CORRUPT } from "./tenmin-day-picks";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceEntry,
  type TickerReferenceHistoryEntry,
  listTickerReferenceIndexHistory,
  loadTickerReferenceIndexFromManifest,
} from "./ticker-reference-index";

export const TENMIN_DAILY_BASE_INPUT_MISSING = "BASE_INPUT_MISSING" as const;
export const TENMIN_DAILY_BASE_INPUT_FAILED = "BASE_INPUT_FAILED" as const;
export const TENMIN_DAILY_INDEX_TICKERS = ["SPY", "QQQ"] as const;
export const TENMIN_DAILY_MASSIVE_PROVIDER = "massive-stocks" as const;

const ALLOWED = new Set<string>(PICK_V1_ALLOWED_TYPES);

export type TenMinDailyBaseMissingInput = "grouped_reply" | "ticker_index";

export class TenMinDailyBaseInputError extends Error {
  readonly code = TENMIN_DAILY_BASE_INPUT_MISSING;
  constructor(
    readonly input: TenMinDailyBaseMissingInput,
    readonly key: string,
    readonly sessionDate: string,
    detail?: string,
  ) {
    super(
      `${TENMIN_DAILY_BASE_INPUT_MISSING}:${input}:${key}${detail ? `:${detail}` : ""}`,
    );
    this.name = "TenMinDailyBaseInputError";
  }
}

/** Present but unverified / checksum / decode failure — runner maps to CORRUPT. */
export class TenMinDailyBaseCorruptError extends Error {
  constructor(
    readonly key: string,
    readonly sessionDate: string,
    detail?: string,
  ) {
    super(
      `${TENMIN_DAY_OBJECT_CORRUPT}:${key}${detail ? `:${detail}` : ""}`,
    );
    this.name = "TenMinDailyBaseCorruptError";
  }
}

/** Transient store read — runner maps to FAILED. */
export class TenMinDailyBaseFailedError extends Error {
  readonly code = TENMIN_DAILY_BASE_INPUT_FAILED;
  constructor(
    readonly key: string,
    readonly sessionDate: string,
    detail?: string,
  ) {
    super(
      `${TENMIN_DAILY_BASE_INPUT_FAILED}:${key}${detail ? `:${detail}` : ""}`,
    );
    this.name = "TenMinDailyBaseFailedError";
  }
}

/**
 * Marker for clear integrity failures raised by our own store read/decode paths.
 * Prefer throwing this (or setting `.code` to a known integrity code) over relying
 * on message text alone.
 */
export class StoreReadIntegrityError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "StoreReadIntegrityError";
    this.code = code;
  }
}

/**
 * Known integrity codes / message prefixes from daily-reply-dust, reply-dust, and
 * ticker-reference-index readers (checksum, sha, length, version, decode, zstd, shape).
 */
const STORE_READ_INTEGRITY_CODES = new Set<string>([
  "REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH",
  "REPLY_DUST_FILE_CHECKSUM_MISMATCH",
  "REPLY_DUST_REPLY_CHECKSUM_MISMATCH",
  "REPLY_DUST_HASH_MISMATCH",
  "REPLY_DUST_DICTIONARY_HASH_MISMATCH",
  "REPLY_DUST_VERSION_UNSUPPORTED",
  "REPLY_DUST_TRUNCATED",
  "REPLY_DUST_ZSTD_MAGIC",
  "REPLY_DUST_ZSTD_FAILED",
  "REPLY_DUST_VERIFY_FAILED",
  "REPLY_DUST_NEGATIVE_UVARINT",
  "REPLY_DUST_BAR_SHAPE",
  "REPLY_DUST_UNKNOWN_FIELD",
  "REPLY_DUST_T_NOT_INTEGER",
  "REPLY_DUST_KEY_TABLE_MISS",
  "REPLY_DUST_ORDER_TABLE_MISS",
  "REPLY_DUST_TRAILING_BYTES",
  "REPLY_DUST_REPLY_COUNT",
  "TICKER_REFERENCE_INDEX_FILE_MISMATCH",
  "TICKER_REFERENCE_INDEX_BODY_MISMATCH",
  "TICKER_REFERENCE_INDEX_MANIFEST_INVALID",
  "TICKER_REFERENCE_INDEX_ARCHIVE_SHA_MISMATCH",
  "TICKER_REFERENCE_INDEX_ARCHIVE_MONTH_MISMATCH",
  "TICKER_REFERENCE_INDEX_COUNT_MISMATCH",
  "TICKER_REFERENCE_INDEX_READBACK_MISMATCH",
  "TICKER_REFERENCE_INDEX_MANIFEST_READBACK_MISMATCH",
  "TICKER_REFERENCE_INDEX_ENTRY_INVALID",
  "TICKER_REFERENCE_INDEX_ORDER_INVALID",
  "TICKER_REFERENCE_INDEX_STATE_INVALID",
  "TICKER_REFERENCE_INDEX_VERIFY_FAILED",
  "TICKER_REFERENCE_DELTA_BASE_MISMATCH",
  "TICKER_REFERENCE_DELTA_INVALID",
  "TICKER_REFERENCE_DELTA_RECORD_INVALID",
  "TICKER_REFERENCE_DELTA_VERIFY_FAILED",
  "TICKER_REFERENCE_REPLY_INVALID",
  "TICKER_REFERENCE_RECORD_NOT_OBJECT",
]);

function storeReadErrorChain(error: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    if (cur instanceof Error && "cause" in cur && cur.cause !== undefined) {
      cur = cur.cause;
    } else {
      break;
    }
  }
  return out;
}

function integrityCodeFromMessage(message: string): string | undefined {
  const head = /^([A-Z][A-Z0-9_]*)/u.exec(message)?.[1];
  return head && STORE_READ_INTEGRITY_CODES.has(head) ? head : undefined;
}

/**
 * True only for clear integrity failures from our readers (checksum/sha/length/
 * version/decode/zstd/JSON). Walks `error.cause`. Unknown / R2 / network / HTTP
 * errors are not integrity failures.
 */
export function isIntegrityStoreReadError(error: unknown): boolean {
  for (const node of storeReadErrorChain(error)) {
    if (node instanceof StoreReadIntegrityError) return true;
    if (node instanceof SyntaxError) return true; // JSON.parse from our readers
    if (!(node instanceof Error)) continue;
    const coded = (node as NodeJS.ErrnoException).code;
    if (typeof coded === "string" && STORE_READ_INTEGRITY_CODES.has(coded)) return true;
    if (integrityCodeFromMessage(node.message)) return true;
  }
  return false;
}

/**
 * Store read should be retried later (FAILED). Default true: only clear integrity
 * failures are non-transient (CORRUPT). Inverted from the old R2_-prefix allowlist.
 */
export function isTransientStoreReadError(error: unknown): boolean {
  return !isIntegrityStoreReadError(error);
}

export interface TickerIndexAsOf {
  key: string;
  /** sha256 of the rebuilt full index body (manifest.bodySha256). */
  sha256: string;
  asOf: string;
  entries: TickerReferenceEntry[];
}

function historyAsOf(entry: TickerReferenceHistoryEntry): string | undefined {
  return entry.manifest?.asOf;
}

/**
 * Newest committed ticker reference index with manifest.asOf ≤ sessionDate.
 * Never uses an index dated after D.
 * Never falls back to an older index when the newest ≤ D is unverified or fails to load:
 * throws TenMinDailyBaseCorruptError / TenMinDailyBaseFailedError instead.
 * Returns undefined only when no history entry with asOf ≤ D exists at all.
 */
export async function loadTickerReferenceIndexAsOf(
  store: Pick<ReplyDustStore, "get">,
  sessionDate: string,
): Promise<TickerIndexAsOf | undefined> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");

  let history: TickerReferenceHistoryEntry[];
  try {
    history = await listTickerReferenceIndexHistory(store);
  } catch (error) {
    if (isIntegrityStoreReadError(error)) {
      throw new TenMinDailyBaseCorruptError(
        TICKER_REFERENCE_INDEX_MANIFEST_KEY,
        sessionDate,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new TenMinDailyBaseFailedError(
      TICKER_REFERENCE_INDEX_MANIFEST_KEY,
      sessionDate,
      error instanceof Error ? error.message : String(error),
    );
  }

  // Newest-first: skip asOf > D; first remaining candidate is newest ≤ D (or unverified blocker).
  for (const entry of history) {
    const asOf = historyAsOf(entry);
    if (asOf !== undefined && asOf > sessionDate) continue;

    // Candidate: first entry that is not strictly after D.
    // Unverified archives have no asOf/manifest — if we reached them after skipping newer
    // verified entries, they block the chain for ≤ D (do not walk past to older).
    if (!entry.verified || !entry.manifest || asOf === undefined) {
      throw new TenMinDailyBaseCorruptError(
        entry.key,
        sessionDate,
        "unverified",
      );
    }

    try {
      const loaded = await loadTickerReferenceIndexFromManifest(store, entry.manifest);
      if (loaded.manifest.asOf > sessionDate) {
        // Should not happen given filter above; treat as continue only if somehow inconsistent.
        continue;
      }
      return {
        key: entry.key,
        sha256: loaded.manifest.bodySha256,
        asOf: loaded.manifest.asOf,
        entries: loaded.entries,
      };
    } catch (error) {
      if (isIntegrityStoreReadError(error)) {
        throw new TenMinDailyBaseCorruptError(
          entry.key,
          sessionDate,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw new TenMinDailyBaseFailedError(
        entry.key,
        sessionDate,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return undefined;
}

/** Map Massive ticker type CS/ETF → security master assetType for securityId(). */
export function assetTypeForPickV1Type(type: string): "STOCK" | "ETF" | undefined {
  if (type === "ETF") return "ETF";
  if (type === "CS") return "STOCK";
  return undefined;
}

/**
 * Deterministic ticker→securityId and ticker→type maps from a point-in-time index.
 * Duplicate tickers: prefer active over inactive among CS/ETF rows.
 */
export function mapsFromTickerReferenceEntries(entries: readonly TickerReferenceEntry[]): {
  tickerToSecurityId: Map<string, string>;
  tickerTypes: Map<string, string>;
} {
  type Cand = { type: string; pass: "active" | "inactive" };
  const best = new Map<string, Cand>();
  for (const e of entries) {
    const ticker = typeof e.ticker === "string" ? e.ticker : undefined;
    const type = typeof e.type === "string" ? e.type : undefined;
    if (!ticker || !type || !ALLOWED.has(type)) continue;
    const prev = best.get(ticker);
    if (!prev) {
      best.set(ticker, { type, pass: e.pass });
      continue;
    }
    if (prev.pass === "inactive" && e.pass === "active") {
      best.set(ticker, { type, pass: e.pass });
    }
  }
  const tickerTypes = new Map<string, string>();
  const tickerToSecurityId = new Map<string, string>();
  const sorted = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ticker, { type }] of sorted) {
    const asset = assetTypeForPickV1Type(type);
    if (!asset) continue;
    tickerTypes.set(ticker, type);
    tickerToSecurityId.set(ticker, securityId(TENMIN_DAILY_MASSIVE_PROVIDER, ticker, asset));
  }
  return { tickerToSecurityId, tickerTypes };
}

export function indexSecuritiesFromMaps(
  tickerToSecurityId: ReadonlyMap<string, string>,
): PickV1NamedSecurity[] {
  const out: PickV1NamedSecurity[] = [];
  for (const symbol of TENMIN_DAILY_INDEX_TICKERS) {
    const sid = tickerToSecurityId.get(symbol);
    if (sid) out.push({ securityId: sid, symbol });
  }
  return out;
}

function parseGroupedResults(reply: Uint8Array): { T?: unknown }[] {
  const parsed = JSON.parse(new TextDecoder().decode(reply)) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  return parsed.results.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return {};
    const T = (row as { T?: unknown }).T;
    return T === undefined ? {} : { T };
  });
}

export interface BuildTenMinDailyPicksBaseOptions {
  store: ReplyDustStore;
  sessionDate: string;
  /** Override index load (tests). */
  loadIndexAsOf?: (sessionDate: string) => Promise<TickerIndexAsOf | undefined>;
}

/**
 * Build picks base from stored grouped-daily + ticker index as-of ≤ D.
 * Throws TenMinDailyBaseInputError / Corrupt / Failed (day stays UNSEALED).
 */
export async function buildTenMinDailyPicksBaseFromStored(
  options: BuildTenMinDailyPicksBaseOptions,
): Promise<PicksBaseV1> {
  const D = options.sessionDate;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(D)) throw new Error("INVALID_SESSION_DATE");

  const manifestKey = dailyReplyDustManifestKey(D);
  const fileKey = dailyReplyDustFileKey(D);

  let hasManifest = false;
  let hasFile = false;
  try {
    hasManifest = !!(await options.store.get(manifestKey));
    hasFile = !!(await options.store.get(fileKey));
  } catch (error) {
    if (isIntegrityStoreReadError(error)) {
      throw new TenMinDailyBaseCorruptError(
        manifestKey,
        D,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new TenMinDailyBaseFailedError(
      manifestKey,
      D,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!hasManifest && !hasFile) {
    throw new TenMinDailyBaseInputError("grouped_reply", fileKey, D, "manifest_missing");
  }

  let manifest;
  try {
    manifest = await readDailyReplyDustManifest(options.store, D);
  } catch (error) {
    if (isIntegrityStoreReadError(error)) {
      // Present but checksum / parse failure.
      throw new TenMinDailyBaseCorruptError(
        manifestKey,
        D,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new TenMinDailyBaseFailedError(
      manifestKey,
      D,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!manifest) {
    // Object bytes existed for file or we raced; treat orphan/missing sealed manifest as corrupt if file present.
    if (hasFile) {
      throw new TenMinDailyBaseCorruptError(fileKey, D, "manifest_missing_with_object");
    }
    throw new TenMinDailyBaseInputError("grouped_reply", fileKey, D, "manifest_missing");
  }

  let reply: Uint8Array;
  try {
    reply = await readDailyReplyDustReply(options.store, manifest);
  } catch (error) {
    if (isIntegrityStoreReadError(error)) {
      throw new TenMinDailyBaseCorruptError(
        fileKey,
        D,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new TenMinDailyBaseFailedError(
      fileKey,
      D,
      error instanceof Error ? error.message : String(error),
    );
  }

  const indexAsOf = options.loadIndexAsOf
    ? await options.loadIndexAsOf(D)
    : await loadTickerReferenceIndexAsOf(options.store, D);
  if (!indexAsOf) {
    throw new TenMinDailyBaseInputError(
      "ticker_index",
      TICKER_REFERENCE_INDEX_MANIFEST_KEY,
      D,
      "no_index_asof_le_D",
    );
  }

  const { tickerToSecurityId, tickerTypes } = mapsFromTickerReferenceEntries(indexAsOf.entries);
  const index = indexSecuritiesFromMaps(tickerToSecurityId);
  const holdings: PickV1NamedSecurity[] = [];
  // Full index ticker set (any type) for informational groupedWithoutIndexEntry only.
  const indexTickers = new Set<string>();
  for (const e of indexAsOf.entries) {
    if (typeof e.ticker === "string" && e.ticker) indexTickers.add(e.ticker);
  }

  return buildPicksBaseV1({
    sessionDate: D,
    index,
    holdings,
    groupedReply: {
      key: dailyReplyDustFileKey(D),
      sha256: manifest.replySha256,
      sessionDate: D,
      results: parseGroupedResults(reply),
    },
    tickerToSecurityId,
    tickerTypes,
    tickerIndex: {
      key: indexAsOf.key,
      sha256: indexAsOf.sha256,
      asOf: indexAsOf.asOf,
    },
    indexTickers,
  });
}
