/**
 * Costs and turnover for the research harness: an equal-weight portfolio that holds a pick list
 * from the open after it froze to the next session's open, rebalanced every session.
 *
 * Per session t: w_t = 1/n on the list's picks that have an outcome; turnover_t = sum |w_t - w_{t-1}|
 * (one-way traded fraction, both buys and sells; the first session of a range buys everything,
 * w_{-1} = 0, and the last also sells everything); cost_t = turnover_t * slippageBpsPerSide / 10^4;
 * net_t = gross_t - cost_t. Weight drift inside a session is ignored. Benchmarks (SPY and the
 * equal-weight universe) are charged no cost, which only makes them harder to beat.
 */
import type { SessionRange } from "./research-folds";

export interface HarnessSession {
  /** Session D: picks frozen before the D+1 open. */
  sessionDate: string;
  /** Names ranked on D with an open(D+1) -> open(D+2) outcome. */
  universeSize: number;
  /** Equal-weight mean outcome of those names. */
  universeMean: number;
  spy?: number;
  /** Each list's picks in rank order and their outcomes (null: no outcome, not held). */
  lists: Record<string, { ids: string[]; returns: Array<number | null> }>;
}

export interface CostConfig {
  slippageBpsPerSide: number;
}

export interface DailyResult {
  sessionDate: string;
  holdings: number;
  gross: number;
  turnover: number;
  cost: number;
  net: number;
  universe: number;
  spy?: number;
}

export const COST_CONFIG_INVALID = "COST_CONFIG_INVALID";

export function simulateList(
  sessions: readonly HarnessSession[],
  range: SessionRange,
  list: string,
  costs: CostConfig,
  topN?: number,
): DailyResult[] {
  if (!(Number.isFinite(costs.slippageBpsPerSide) && costs.slippageBpsPerSide >= 0)) throw new Error(`${COST_CONFIG_INVALID}:slippage`);
  const rate = costs.slippageBpsPerSide / 10_000;
  const out: DailyResult[] = [];
  let previous = new Map<string, number>();
  for (let i = range.start; i <= range.end; i += 1) {
    const session = sessions[i];
    if (!session) throw new Error(`HARNESS_SESSION_MISSING:${i}`);
    const picks = session.lists[list];
    const held: Array<[string, number]> = [];
    if (picks)
      for (let k = 0; k < picks.ids.length && (topN === undefined || k < topN); k += 1) {
        const r = picks.returns[k];
        if (r !== null && r !== undefined && Number.isFinite(r)) held.push([picks.ids[k]!, r]);
      }
    const weight = held.length ? 1 / held.length : 0;
    const now = new Map(held.map(([id]) => [id, weight]));
    let turnover = 0;
    for (const [id, w] of now) turnover += Math.abs(w - (previous.get(id) ?? 0));
    for (const [id, w] of previous) if (!now.has(id)) turnover += w;
    if (i === range.end) for (const w of now.values()) turnover += w; // close out at the end
    const gross = held.reduce((s, [, r]) => s + r * weight, 0);
    const cost = turnover * rate;
    out.push({
      sessionDate: session.sessionDate,
      holdings: held.length,
      gross,
      turnover,
      cost,
      net: gross - cost,
      universe: session.universeMean,
      ...(session.spy === undefined ? {} : { spy: session.spy }),
    });
    previous = now;
  }
  return out;
}
