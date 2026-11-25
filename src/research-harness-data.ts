/**
 * Builds the research harness's per-session table from stored daily bars, point in time.
 * Ticker-date collisions are excluded earlier, in loadResearchData / holdout-eval-cli (both sides).
 *
 * For session D (index i) it reuses the held-out eval's forward-scan rebuild: securities as a scan at
 * D knew them (ACTIVE = a bar on D, so names INACTIVE in today's master count on the days they
 * traded; eligibility from bars up to D), the scan's own bar window up to D, and split records as
 * known before the next open (split-adjust "as-known"). It runs the production rankSecurities and
 * records each list's picks and their outcomes: open(D+1) -> open(D+2), the hold the paper ledger
 * uses. A name whose split takes effect on D+2 (between the two opens) has no outcome (unadjusted
 * prices would be wrong), for picks and the universe alike.
 */
import type { CorporateAction, SecurityMasterRecord } from "./contracts";
import { EvalHistory, pointInTimeSecurities, scanInputBars, splitActionsKnownAt } from "./holdout-eval";
import { DEFAULT_SCANNER_CONFIG, rankSecurities } from "./ranking";
import type { HarnessSession } from "./research-costs";
import { resolveSpyBenchmarkId, type SessionCalendar } from "./scanner";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** open(D+1) -> open(D+2); undefined when either bar is missing or not positive. */
export function openToNextOpen(history: EvalHistory, securityId: string, i: number): number | undefined {
  const entryDate = history.sessions[i + 1];
  const exitDate = history.sessions[i + 2];
  if (!entryDate || !exitDate) return undefined;
  const entry = history.bar(securityId, entryDate);
  const exit = history.bar(securityId, exitDate);
  if (!entry || !exit || !(entry.open > 0) || !(exit.open > 0)) return undefined;
  return exit.open / entry.open - 1;
}

export interface HarnessDataOptions {
  splitActions: readonly CorporateAction[];
  calendar?: SessionCalendar;
}

export function splitDatesById(actions: readonly CorporateAction[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of actions) {
    if (a.actionType !== "SPLIT" && a.actionType !== "REVERSE_SPLIT") continue;
    let set = out.get(a.securityId);
    if (!set) out.set(a.securityId, (set = new Set()));
    set.add(a.effectiveDate);
  }
  return out;
}

export function buildHarnessSession(
  master: readonly SecurityMasterRecord[],
  history: EvalHistory,
  i: number,
  options: HarnessDataOptions,
  splitDates: ReadonlyMap<string, ReadonlySet<string>> = splitDatesById(options.splitActions),
): { session: HarnessSession; excludedBySplitAdjust: number } | undefined {
  const D = history.sessions[i]!;
  const exitDate = history.sessions[i + 2];
  if (!exitDate) return undefined;
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const securities = pointInTimeSecurities(master, history, i);
  const bars = scanInputBars(history, i, calendar);
  const spyId = resolveSpyBenchmarkId(securities);
  const benchmark = spyId ? bars.filter((bar) => bar.securityId === spyId) : [];
  const result = rankSecurities(securities, bars, benchmark, D, DEFAULT_SCANNER_CONFIG, splitActionsKnownAt(options.splitActions, D, calendar));
  const outcome = (id: string): number | undefined =>
    splitDates.get(id)?.has(exitDate) ? undefined : openToNextOpen(history, id, i);
  const universe: number[] = [];
  for (const item of result.ranked) {
    const r = outcome(item.securityId);
    if (r !== undefined) universe.push(r);
  }
  const lists: HarnessSession["lists"] = {};
  for (const set of result.predictions)
    lists[set.setType] = { ids: [...set.securityIds], returns: set.securityIds.map((id) => outcome(id) ?? null) };
  const spy = spyId ? outcome(spyId) : undefined;
  return {
    session: {
      sessionDate: D,
      universeSize: universe.length,
      universeMean: universe.length ? universe.reduce((s, v) => s + v, 0) / universe.length : 0,
      ...(spy === undefined ? {} : { spy }),
      lists,
    },
    excludedBySplitAdjust: result.excluded?.length ?? 0,
  };
}
