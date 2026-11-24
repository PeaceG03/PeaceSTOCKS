/**
 * Split adjustment for the scanner's features and ranking. Stored daily bars are UNADJUSTED
 * (Massive grouped daily), so without this a 1-for-10 reverse split reads as a 10x gain.
 *
 * A recorded SPLIT / REVERSE_SPLIT (details.split_from -> split_to) effective on E rescales every
 * bar before E: prices x (split_from / split_to), volume / the same factor (dollar volume unchanged).
 * The adjustment is used only when the prices agree with it: the adjusted move from the last close
 * before E to the first close on/after E must be within [1/1.5, 1.5]. Otherwise, or when the record has
 * no usable factor (including two different factors recorded for one date), the name is dropped for
 * that session (SPLIT_UNRECONCILED). After adjusting, any
 * session-to-session close move of 3x or more either way (no recorded split explains it, or the
 * split data is missing) also drops the name (PRICE_GAP_UNEXPLAINED), and so does a move of 1.8x or
 * more either way into any of the last 20 sessions (SPLIT_LIKE_MOVE_UNRECORDED: a split whose record
 * has not arrived yet). Nothing is guessed.
 * Only splits effective on or before the scanned session are used.
 */
import type { CanonicalDailyBar, CorporateAction } from "./contracts";

/** Chosen from the real splits (build log): 95.7% of them reconcile within it. */
export const SPLIT_RECONCILE_MAX_MOVE = 1.5;
export const UNEXPLAINED_GAP_RATIO = 3;
/**
 * Split records can arrive days after the split (1-9 days seen). Until then a 2-for-1 or 1-for-2 looks
 * like a +100% / -50% day, under the 3x rule. So a move of 1.8x or more either way into any of the
 * last 20 sessions that no recorded split explains also drops the name. Both chosen from the held-out
 * period's data (see the build log): 1.8 catches as many late splits as 1.6 or 1.7 with the fewest
 * exclusions; 20 sessions (not 10) because records also arrive 10-30 days late.
 */
export const RECENT_SPLIT_LIKE_RATIO = 1.8;
export const RECENT_SPLIT_LIKE_SESSIONS = 20;

export type SplitExclusion = "SPLIT_UNRECONCILED" | "PRICE_GAP_UNEXPLAINED" | "SPLIT_LIKE_MOVE_UNRECORDED";

export interface SplitEvent {
  effectiveDate: string;
  /** Pre-split prices are multiplied by this (split_from / split_to); NaN when not usable. */
  factor: number;
}

/** Corporate action types that can settle a held name for cash (details.cash_per_share); used by paper trading. */
export const SETTLEMENT_ACTION_TYPES: readonly string[] = ["MERGER", "CLOSURE", "DELISTING"];

export function isSplitAction(action: Pick<CorporateAction, "actionType">): boolean {
  return action.actionType === "SPLIT" || action.actionType === "REVERSE_SPLIT";
}

/** Split events by security, one per (date), from any corporate-action records; conflicting factors -> NaN. */
export function splitEventsBySecurity(actions: readonly CorporateAction[]): Map<string, SplitEvent[]> {
  // securityId -> effectiveDate -> distinct factors (NaN kept as "unusable").
  const byName = new Map<string, Map<string, Set<number>>>();
  for (const action of actions) {
    if (!isSplitAction(action)) continue;
    const from = Number(action.details?.split_from);
    const to = Number(action.details?.split_to);
    const factor = Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > 0 ? from / to : Number.NaN;
    let dates = byName.get(action.securityId);
    if (!dates) byName.set(action.securityId, (dates = new Map()));
    let factors = dates.get(action.effectiveDate);
    if (!factors) dates.set(action.effectiveDate, (factors = new Set()));
    factors.add(factor);
  }
  const out = new Map<string, SplitEvent[]>();
  for (const [securityId, dates] of byName)
    out.set(
      securityId,
      [...dates].map(([effectiveDate, factors]) => ({
        effectiveDate,
        // The same factor recorded twice is one split. Different factors on one date conflict: unusable
        // (never multiplied together), so the name is excluded as SPLIT_UNRECONCILED.
        factor: factors.size === 1 ? [...factors][0]! : Number.NaN,
      })),
    );
  return out;
}

/**
 * Adjust one security's bars (one per session, oldest first, all <= asOf) for its splits.
 * Returns the adjusted bars, or the reason the name must be left out.
 */
export function splitAdjustedBars(
  bars: readonly CanonicalDailyBar[],
  events: readonly SplitEvent[] | undefined,
  asOf: string,
): { bars: CanonicalDailyBar[] } | { excluded: SplitExclusion } {
  const multipliers = new Array<number>(bars.length).fill(1);
  const byIndex = new Map<number, number>();
  for (const event of events ?? []) {
    if (event.effectiveDate > asOf || !bars.length || event.effectiveDate <= bars[0]!.sessionDate) continue;
    const k = bars.findIndex((bar) => bar.sessionDate >= event.effectiveDate);
    if (k <= 0) continue; // the split is after the last bar we hold: nothing before it to rescale yet
    if (!Number.isFinite(event.factor)) return { excluded: "SPLIT_UNRECONCILED" };
    // Two split dates that land on the same bar (no bar between them) cannot be told apart: excluded.
    if (byIndex.has(k)) return { excluded: "SPLIT_UNRECONCILED" };
    byIndex.set(k, event.factor);
  }
  for (const [k, factor] of byIndex) {
    const before = bars[k - 1]!.close;
    const after = bars[k]!.close;
    const move = after / (before * factor);
    if (!(move >= 1 / SPLIT_RECONCILE_MAX_MOVE && move <= SPLIT_RECONCILE_MAX_MOVE)) return { excluded: "SPLIT_UNRECONCILED" };
    for (let j = 0; j < k; j += 1) multipliers[j]! *= factor;
  }
  const adjusted = bars.map((bar, j) => {
    const m = multipliers[j]!;
    return m === 1
      ? bar
      : { ...bar, open: bar.open * m, high: bar.high * m, low: bar.low * m, close: bar.close * m, volume: bar.volume / m };
  });
  for (let j = 1; j < adjusted.length; j += 1) {
    const ratio = adjusted[j]!.close / adjusted[j - 1]!.close;
    if (ratio >= UNEXPLAINED_GAP_RATIO || ratio <= 1 / UNEXPLAINED_GAP_RATIO) return { excluded: "PRICE_GAP_UNEXPLAINED" };
  }
  for (let j = Math.max(1, adjusted.length - RECENT_SPLIT_LIKE_SESSIONS); j < adjusted.length; j += 1) {
    const ratio = adjusted[j]!.close / adjusted[j - 1]!.close;
    if (ratio >= RECENT_SPLIT_LIKE_RATIO || ratio <= 1 / RECENT_SPLIT_LIKE_RATIO) return { excluded: "SPLIT_LIKE_MOVE_UNRECORDED" };
  }
  return { bars: adjusted };
}
