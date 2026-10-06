/** America/New_York calendar date and ISO timestamps with numeric offset (for readiness logs). */

export function etCalendarDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * Format `now` as an America/New_York wall-clock ISO-8601 string with numeric offset
 * (e.g. 2026-10-05T22:00:00-04:00).
 */
export function etIsoWithOffset(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const g = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const local = `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
  const offsetMin = Math.round((Date.parse(`${local}Z`) - now.getTime()) / 60_000);
  const sign = offsetMin <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

/** Session D is due for collection only when the current ET calendar date is strictly after D. */
export function sessionCollectionDue(sessionDate: string, now: Date): boolean {
  return etCalendarDate(now) > sessionDate;
}

/**
 * Convert an America/New_York wall-clock time on `sessionDate` (YYYY-MM-DD) to a UTC Instant.
 * Resolves EST/EDT by iterating against Intl (handles DST).
 */
export function etWallClockToUtc(sessionDate: string, hour: number, minute: number, second = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  const targetAsIfUtc = Date.parse(`${sessionDate}T${hh}:${mm}:${ss}.000Z`);
  let guess = targetAsIfUtc + 5 * 60 * 60 * 1000; // rough EST offset seed
  for (let i = 0; i < 5; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const g = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const shownAsIfUtc = Date.parse(
      `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}.000Z`,
    );
    guess += targetAsIfUtc - shownAsIfUtc;
  }
  return new Date(guess);
}
