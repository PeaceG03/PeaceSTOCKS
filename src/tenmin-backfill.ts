// Builder teaching example (scanner proving ground, piece 3: auto deeper backfill on plan upgrade).
// Missing PeaceAI edit kind: ADD_FUNCTION / new module. Pure planner only; nothing here fetches, writes or deletes.
//
// When the Massive plan probe says older history is reachable, plan two-calendar-month ranges strictly before the
// earliest stored session, newest first, never touching the calendar pair that already holds stored data (that
// pair is the Oct 2024 one-off's 2024-09-01_2024-10-31 prefix today). Writers keep their never-overwrite guards;
// a range is "resumed by verify" (a stored, verified range is skipped by the caller), so re-planning is safe.
import { addCalendarDays, pairRangeForDate } from "./tenmin-history";

export interface BackfillRange { calendarFrom: string; calendarTo: string; fetchFrom: string; fetchTo: string }
export type BackfillAction = "dispatch" | "hold" | "daily";

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
function requireDate(d: string): void {
  if (!DATE.test(d)) throw new Error("TENMIN_BACKFILL_BAD_DATE");
}

/** Last day a backfill may fetch: the day before the calendar pair that holds the earliest stored session. */
export function backfillEndDate(earliestStored: string): string {
  requireDate(earliestStored);
  return addCalendarDays(pairRangeForDate(earliestStored).calendarFrom, -1);
}

/**
 * Ranges in [reachableFloor, backfillEndDate(earliestStored)], newest first, at most maxRanges.
 * fetchFrom is clamped to reachableFloor; nothing at or after the earliest stored pair is ever planned.
 */
export function planBackfillRanges(earliestStored: string, reachableFloor: string, maxRanges = 60): BackfillRange[] {
  requireDate(reachableFloor);
  const end = backfillEndDate(earliestStored);
  const out: BackfillRange[] = [];
  let day = end;
  while (day >= reachableFloor && out.length < maxRanges) {
    const { calendarFrom, calendarTo } = pairRangeForDate(day);
    const fetchFrom = calendarFrom < reachableFloor ? reachableFloor : calendarFrom;
    out.push({ calendarFrom, calendarTo, fetchFrom, fetchTo: calendarTo });
    day = addCalendarDays(calendarFrom, -1);
  }
  return out;
}

/** Probe dates for the next deeper check: 10 calendar days ending 30 days before the backfill end. */
export function backfillProbeDates(earliestStored: string): { from: string; to: string } {
  const end = backfillEndDate(earliestStored);
  return { from: addCalendarDays(end, -40), to: addCalendarDays(end, -30) };
}

/**
 * One decision per daily scan / gap refill. hold = another Massive-key user (chain, scan, refill, one-off) is active,
 * so the backfill waits for the gate; daily = nothing older is reachable or nothing left to plan.
 */
export function decideBackfill(olderReachable: boolean | undefined, pendingRanges: number, keyBusy: boolean): BackfillAction {
  if (olderReachable !== true || pendingRanges <= 0) return "daily";
  return keyBusy ? "hold" : "dispatch";
}
