import type { SessionKind, SessionRecord } from "./contracts";
import type { SessionCalendar } from "./scanner";

function dateUtc(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_SESSION_DATE");
  return new Date(`${date}T00:00:00Z`);
}
const format = (date: Date) => date.toISOString().slice(0, 10);
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCDate(1 + ((weekday - date.getUTCDay() + 7) % 7) + (n - 1) * 7);
  return format(date);
}
function lastWeekday(year: number, month: number, weekday: number): string {
  const date = new Date(Date.UTC(year, month, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
  return format(date);
}
function observedFixed(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) date.setUTCDate(day - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(day + 1);
  return format(date);
}
function easterSunday(year: number): Date {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function nyseClosedDates(year: number): Set<string> {
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  return new Set([
    observedFixed(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    format(goodFriday),
    lastWeekday(year, 5, 1),
    ...(year >= 2022 ? [observedFixed(year, 6, 19)] : []),
    observedFixed(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixed(year, 12, 25),
  ]);
}
function nyseHalfDayDates(year: number): Set<string> {
  const thanksgiving = dateUtc(nthWeekday(year, 11, 4, 4));
  thanksgiving.setUTCDate(thanksgiving.getUTCDate() + 1);
  const halfDays = [format(thanksgiving)];
  for (const candidateText of [`${year}-12-24`, `${year}-07-03`]) {
    const candidate = dateUtc(candidateText);
    if (candidate.getUTCDay() >= 1 && candidate.getUTCDay() <= 5) halfDays.push(candidateText);
  }
  return new Set(halfDays);
}

/** NYSE-aware calendar with regular holidays and common scheduled early closes. */
export const US_EQUITY_MARKET_CALENDAR: SessionCalendar = {
  getSession(sessionDate: string): SessionRecord {
    const date = dateUtc(sessionDate),
      weekday = date.getUTCDay();
    const kind: SessionKind =
      weekday === 0 || weekday === 6 || nyseClosedDates(date.getUTCFullYear()).has(sessionDate)
        ? "CLOSED"
        : nyseHalfDayDates(date.getUTCFullYear()).has(sessionDate)
          ? "HALF_DAY"
          : "NORMAL";
    return {
      sessionDate,
      kind,
      market: "US_EQUITIES",
      ...(kind === "HALF_DAY"
        ? { closeTime: "13:00 America/New_York" }
        : kind === "NORMAL"
          ? { closeTime: "16:00 America/New_York" }
          : {}),
      source: "nyse-calendar-rules-v1",
    };
  },
};
