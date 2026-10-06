import type { ScannerRunReport, SessionRecord } from "./contracts";
import { etCalendarDate } from "./et-time";
import type { MarketsScanner, SessionCalendar } from "./scanner";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export interface CollectionScheduleOptions {
  calendar?: SessionCalendar;
  /** @deprecated Ignored: collection is due on ET D+1, not close+delay on D. Kept for call-site compat. */
  completionDelayMinutes?: number;
  now?: Date;
}
export interface CollectionDueResult {
  due: boolean;
  session: SessionRecord;
  reason: "BEFORE_CLOSE" | "WAITING_FOR_DATA" | "CLOSED" | "READY";
}

function addEtDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Session D is due for collection only when the current America/New_York calendar date is
 * strictly after D. The host's natural target is therefore yesterday's ET session (when it was
 * a trading day). Same-ET-day runs are not due (scanner also returns NOT_DUE).
 */
export function collectionDue(options: CollectionScheduleOptions = {}): CollectionDueResult {
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const now = options.now ?? new Date();
  const etToday = etCalendarDate(now);
  const targetDate = addEtDays(etToday, -1);
  const session = calendar.getSession(targetDate);
  if (session.kind === "CLOSED" || session.kind === "HOLIDAY")
    return { due: false, session, reason: "CLOSED" };
  // Target is always a prior ET day, so it is due.
  return { due: true, session, reason: "READY" };
}

/** One idempotent invocation; a governed host owns cadence and missed-session recovery. */
export async function runDueCollection(
  scanner: MarketsScanner,
  options: CollectionScheduleOptions = {},
): Promise<ScannerRunReport | undefined> {
  const due = collectionDue(options);
  return due.due ? scanner.run(due.session.sessionDate) : undefined;
}
