/**
 * Read-only loader for the newest committed ticker reference index with asOf <= a session date,
 * plus the store-read error taxonomy (integrity -> CORRUPT, everything else -> FAILED).
 * Moved out of the removed daily-picks code; reads stored objects only, never Massive.
 * Never uses an index dated after D, and never falls back to an older index when the newest <= D
 * is unverified or fails to load.
 */

import type { ReplyDustStore } from "./intraday-reply-dust";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceEntry,
  type TickerReferenceHistoryEntry,
  listTickerReferenceIndexHistory,
  loadTickerReferenceIndexFromManifest,
} from "./ticker-reference-index";

export const TICKER_INDEX_AS_OF_CORRUPT = "TICKER_INDEX_AS_OF_CORRUPT" as const;
export const TICKER_INDEX_AS_OF_FAILED = "TICKER_INDEX_AS_OF_FAILED" as const;

/** Present but unverified / checksum / decode failure — runner maps to CORRUPT. */
export class TickerIndexAsOfCorruptError extends Error {
  constructor(
    readonly key: string,
    readonly sessionDate: string,
    detail?: string,
  ) {
    super(
      `${TICKER_INDEX_AS_OF_CORRUPT}:${key}${detail ? `:${detail}` : ""}`,
    );
    this.name = "TickerIndexAsOfCorruptError";
  }
}

/** Transient store read — runner maps to FAILED. */
export class TickerIndexAsOfFailedError extends Error {
  readonly code = TICKER_INDEX_AS_OF_FAILED;
  constructor(
    readonly key: string,
    readonly sessionDate: string,
    detail?: string,
  ) {
    super(
      `${TICKER_INDEX_AS_OF_FAILED}:${key}${detail ? `:${detail}` : ""}`,
    );
    this.name = "TickerIndexAsOfFailedError";
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
  "REPLY_DUST_FILE_MISSING",
  "TICKER_REFERENCE_INDEX_FILE_MISMATCH",
  "TICKER_REFERENCE_INDEX_ARCHIVE_MISSING",
  "TICKER_REFERENCE_INDEX_HISTORY_LOOP",
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
  "TICKER_REFERENCE_DELTA_UNKNOWN_RECORD",
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
 * throws TickerIndexAsOfCorruptError / TickerIndexAsOfFailedError instead.
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
      throw new TickerIndexAsOfCorruptError(
        TICKER_REFERENCE_INDEX_MANIFEST_KEY,
        sessionDate,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new TickerIndexAsOfFailedError(
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
      throw new TickerIndexAsOfCorruptError(
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
        throw new TickerIndexAsOfCorruptError(
          entry.key,
          sessionDate,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw new TickerIndexAsOfFailedError(
        entry.key,
        sessionDate,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return undefined;
}
