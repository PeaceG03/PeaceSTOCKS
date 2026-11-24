import type { CanonicalTenMinuteBar } from "./contracts";
import { dayFullyStored } from "./day-fully-stored";
import { incompleteNames } from "./incomplete-names";
import { intradaySessionSpec } from "./intraday";
import type { SessionCalendar } from "./scanner";
import { tenMinBarsSaved } from "./tenmin-bars-saved";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export function tenMinDayDone(hasNames: boolean, namesMissing: boolean): boolean {
  return hasNames && !namesMissing;
}

/**
 * Ten-minute bars a stock must have for one session: 39 on a normal day, 21 on a half day (from
 * the half-day calendar via intradaySessionSpec), 0 when the market is closed.
 */
export function expectedTenMinBars(sessionDate: string, calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): number {
  return intradaySessionSpec(sessionDate, calendar).expectedIntervals;
}

/** Bars the provider actually returned (a PROVIDER_MISSING placeholder is not a saved bar). */
export function presentTenMinBars(bars: readonly Pick<CanonicalTenMinuteBar, "state">[]): number {
  return bars.filter((bar) => bar.state !== "PROVIDER_MISSING").length;
}

export interface TenMinSessionDoneInput {
  sessionDate: string;
  /** Every stock chosen for the session. */
  selected: readonly string[];
  /** Saved ten-minute bar count per stock (absent = nothing saved). */
  savedBars: ReadonlyMap<string, number>;
  /** Stocks whose daily bar for the session is saved. */
  dailyBarsSaved: ReadonlySet<string>;
  calendar?: SessionCalendar;
}

/** Bars stored vs. needed, e.g. "38/39" (20/21 on a half day). Used in every day and stock status. */
export function barCount(stored: number, needed: number): string {
  return `${stored}/${needed}`;
}

/** One stock short of its bars: securityId and the bars it has (capped at the bars needed). */
export interface TenMinStockBars {
  securityId: string;
  bars: number;
}

/**
 * Pure: short stocks grouped by their count, e.g. { "38/39": 2, "0/39": 1 }, fewest bars first.
 * Logs carry this (no stock names); R2 carries the per-stock list.
 */
export function shortStockCounts(shortStocks: readonly TenMinStockBars[], needed: number): Record<string, number> {
  const byBars = new Map<number, number>();
  for (const stock of shortStocks) byBars.set(stock.bars, (byBars.get(stock.bars) ?? 0) + 1);
  return Object.fromEntries([...byBars.entries()].sort((a, b) => a[0] - b[0]).map(([bars, n]) => [barCount(bars, needed), n]));
}

export interface TenMinSessionDone {
  done: boolean;
  expectedBars: number;
  /** Ten-minute bars stored over every selected stock (each capped at expectedBars). */
  barsStored: number;
  /** selected stocks x expectedBars. */
  barsNeeded: number;
  /** Each short stock with the bars it has, in selection order. */
  shortStocks: TenMinStockBars[];
  /** Stocks short of the expected bars (or with none saved). */
  shortNames: string[];
  /** Stocks with no saved daily bar for the session. */
  missingDailyBars: string[];
}

/**
 * Done-day rule (Peace, Oct 29): a day is done only when every stock has all its ten-minute bars
 * (39, or 21 on a half day) AND its daily bars are saved. A scan report or a gap refill alone never
 * makes a day done: only saved bars count.
 */
export function tenMinSessionDone(input: TenMinSessionDoneInput): TenMinSessionDone {
  const expectedBars = expectedTenMinBars(input.sessionDate, input.calendar);
  const capped = (securityId: string) => Math.min(input.savedBars.get(securityId) ?? 0, expectedBars);
  const shortNames = incompleteNames(
    input.selected.map((securityId) => ({
      securityId,
      complete: tenMinBarsSaved(Math.min(input.savedBars.get(securityId) ?? 0, expectedBars), expectedBars),
    })),
  );
  const missingDailyBars = input.selected.filter((securityId) => !input.dailyBarsSaved.has(securityId));
  const tenMinDone = tenMinDayDone(expectedBars > 0 && input.selected.length > 0, shortNames.length > 0);
  return {
    done: dayFullyStored(tenMinDone, missingDailyBars.length === 0),
    expectedBars,
    barsStored: input.selected.reduce((sum, securityId) => sum + capped(securityId), 0),
    barsNeeded: input.selected.length * expectedBars,
    shortStocks: shortNames.map((securityId) => ({ securityId, bars: capped(securityId) })),
    shortNames,
    missingDailyBars,
  };
}
