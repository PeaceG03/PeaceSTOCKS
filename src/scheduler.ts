import type { ScannerRunReport, SessionRecord } from "./contracts";
import type { MarketsScanner, SessionCalendar } from "./scanner";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export interface CollectionScheduleOptions {
  calendar?: SessionCalendar;
  completionDelayMinutes?: number;
  now?: Date;
}
export interface CollectionDueResult {
  due: boolean;
  session: SessionRecord;
  reason: "BEFORE_CLOSE" | "WAITING_FOR_DATA" | "CLOSED" | "READY";
}
function nyTime(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}
/** Returns a deterministic due/not-due decision for a scheduler-owned invocation. */
export function collectionDue(options: CollectionScheduleOptions = {}): CollectionDueResult {
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const delay = options.completionDelayMinutes ?? 30;
  if (delay < 0 || delay > 24 * 60) throw new Error("INVALID_COLLECTION_DELAY");
  const local = nyTime(options.now ?? new Date()),
    session = calendar.getSession(local.date);
  if (session.kind === "CLOSED" || session.kind === "HOLIDAY")
    return { due: false, session, reason: "CLOSED" };
  const close = session.kind === "HALF_DAY" ? 13 * 60 : 16 * 60;
  if (local.minutes < close) return { due: false, session, reason: "BEFORE_CLOSE" };
  if (local.minutes < close + delay) return { due: false, session, reason: "WAITING_FOR_DATA" };
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
