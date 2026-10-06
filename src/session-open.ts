/**
 * Trading-session open helpers shared by the host (S2 run-start gate) and scanner (S4 freeze-time gate).
 * Kept out of host.ts so scanner can import without a cycle.
 */

import type { SessionKind } from "./contracts";
import { etWallClockToUtc } from "./et-time";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Minimal calendar surface used for open checks (avoids importing SessionCalendar from scanner). */
export interface EligibleSessionCalendar {
  getSession(sessionDate: string): { kind: SessionKind };
}

function dateValue(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_SESSION_DATE");
  return date;
}

function addDays(value: string, days: number): string {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eligible(kind: SessionKind): boolean {
  return kind === "NORMAL" || kind === "HALF_DAY";
}

/** Previous NORMAL/HALF_DAY session strictly before `sessionDate` (walks back up to 14 calendar days). */
export function previousEligibleSession(
  sessionDate: string,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string | undefined {
  for (let i = 1; i <= 14; i++) {
    const candidate = addDays(sessionDate, -i);
    if (eligible(calendar.getSession(candidate).kind)) return candidate;
  }
  return undefined;
}

/** Next NORMAL/HALF_DAY session strictly after `sessionDate` (walks forward up to 14 calendar days). */
export function nextEligibleSession(
  sessionDate: string,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string | undefined {
  for (let i = 1; i <= 14; i++) {
    const candidate = addDays(sessionDate, i);
    if (eligible(calendar.getSession(candidate).kind)) return candidate;
  }
  return undefined;
}

/**
 * Next session's regular open (09:30 America/New_York). Half days still open at 09:30.
 * Returns undefined when no eligible session is found within the walk window.
 */
export function nextSessionOpen(
  sessionDate: string,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
): { nextSessionDate: string; nextSessionOpen: Date } | undefined {
  const nextSessionDate = nextEligibleSession(sessionDate, calendar);
  if (!nextSessionDate) return undefined;
  return { nextSessionDate, nextSessionOpen: etWallClockToUtc(nextSessionDate, 9, 30) };
}

/**
 * True when `now` is strictly before the next trading session's 09:30 ET open after `dueSessionDate`.
 * Used by the host as an early gate (S2) and by the scanner at freeze time (S4; authoritative).
 */
export function forwardFreezeAllowed(
  dueSessionDate: string,
  now: Date,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
): boolean {
  const next = nextSessionOpen(dueSessionDate, calendar);
  if (!next) return true;
  return now.getTime() < next.nextSessionOpen.getTime();
}

/** One minute before the next session's 09:30 ET open (for tests / freeze-safe clocks). */
export function beforeNextSessionOpen(
  sessionDate: string,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
  skewMs = 60_000,
): Date {
  const next = nextSessionOpen(sessionDate, calendar);
  if (!next) return new Date(`${sessionDate}T20:00:00.000Z`);
  return new Date(next.nextSessionOpen.getTime() - skewMs);
}
