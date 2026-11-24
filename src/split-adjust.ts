/**
 * Split adjustment for the scanner's features and ranking. Stored daily bars are UNADJUSTED
 * (Massive grouped daily), so without this a 1-for-10 reverse split reads as a 10x gain.
 *
 * A recorded SPLIT / REVERSE_SPLIT (details.split_from -> split_to) effective on E rescales every
 * bar before E: prices x (split_from / split_to), volume / the same factor (dollar volume unchanged).
 * The adjustment is used only when the prices agree with it: the adjusted move from the last close
 * before E to the first close on/after E must be within [1/2, 2]. Otherwise, or when the record has
 * no usable factor, the name is dropped for that session (SPLIT_UNRECONCILED). After adjusting, any
 * session-to-session close move of 3x or more either way (no recorded split explains it, or the
 * split data is missing) also drops the name (PRICE_GAP_UNEXPLAINED). Nothing is guessed.
 * Only splits effective on or before the scanned session are used.
 */
import type { CanonicalDailyBar, CorporateAction } from "./contracts";

export const SPLIT_RECONCILE_MAX_MOVE = 2;
export const UNEXPLAINED_GAP_RATIO = 3;

export type SplitExclusion = "SPLIT_UNRECONCILED" | "PRICE_GAP_UNEXPLAINED";

export interface SplitEvent {
  effectiveDate: string;
  /** Pre-split prices are multiplied by this (split_from / split_to); NaN when not usable. */
  factor: number;
}

export function isSplitAction(action: Pick<CorporateAction, "actionType">): boolean {
  return action.actionType === "SPLIT" || action.actionType === "REVERSE_SPLIT";
}

/** Split events by security, one per (date, factor), from any corporate-action records. */
export function splitEventsBySecurity(actions: readonly CorporateAction[]): Map<string, SplitEvent[]> {
  const out = new Map<string, SplitEvent[]>();
  const seen = new Set<string>();
  for (const action of actions) {
    if (!isSplitAction(action)) continue;
    const from = Number(action.details?.split_from);
    const to = Number(action.details?.split_to);
    const factor = Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > 0 ? from / to : Number.NaN;
    const key = `${action.securityId}|${action.effectiveDate}|${factor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let list = out.get(action.securityId);
    if (!list) out.set(action.securityId, (list = []));
    list.push({ effectiveDate: action.effectiveDate, factor });
  }
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
    byIndex.set(k, (byIndex.get(k) ?? 1) * event.factor);
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
  return { bars: adjusted };
}
