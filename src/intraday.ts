import type {
  CanonicalDailyBar,
  CanonicalTenMinuteBar,
  IntradaySessionSpec,
  MassiveAggregateBar,
  SourceProvenance,
} from "./contracts";
import { INTRADAY_SCHEMA_VERSION } from "./contracts";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";
import type { SessionCalendar } from "./scanner";

const OPEN_MINUTES = 9 * 60 + 30;
const PRICE_SCALE = 100_000_000;
const VOLUME_SCALE = 1_000_000;
const scaledPrice = (value: number): number => Math.round(value * PRICE_SCALE) / PRICE_SCALE;
const scaledVolume = (value: number): number => Math.round(value * VOLUME_SCALE) / VOLUME_SCALE;
const scaledCount = (value: number): number => Math.round(value);
const NORMAL_CLOSE_MINUTES = 16 * 60;
const HALF_DAY_CLOSE_MINUTES = 13 * 60;

function dateOnly(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("INVALID_SESSION_DATE");
}

function easternParts(timestamp: number): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

export function intradaySessionSpec(
  sessionDate: string,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): IntradaySessionSpec {
  dateOnly(sessionDate);
  const session = calendar.getSession(sessionDate);
  const closeMinutes = session.kind === "HALF_DAY" ? HALF_DAY_CLOSE_MINUTES : NORMAL_CLOSE_MINUTES;
  return {
    sessionDate,
    kind: session.kind,
    intervalMinutes: 10,
    expectedIntervals:
      session.kind === "NORMAL" || session.kind === "HALF_DAY"
        ? (closeMinutes - OPEN_MINUTES) / 10
        : 0,
    openMinutesEastern: OPEN_MINUTES,
    closeMinutesEastern: closeMinutes,
    source: "us-equity-regular-session-v1",
  };
}

export interface IntradayNormalizationInput {
  sessionDate: string;
  securityId: string;
  symbol: string;
  aggregates: readonly MassiveAggregateBar[];
  provenance: SourceProvenance;
  observedAt: string;
  ingestedAt?: string;
  session?: IntradaySessionSpec;
  corporateActionIds?: readonly string[];
}

function missingBar(
  input: IntradayNormalizationInput,
  intervalIndex: number,
  state: CanonicalTenMinuteBar["state"] = "PROVIDER_MISSING",
): CanonicalTenMinuteBar {
  return {
    securityId: input.securityId,
    sessionDate: input.sessionDate,
    intervalIndex,
    state,
    observedAt: input.observedAt,
    ingestedAt: input.ingestedAt ?? input.observedAt,
    dataQuality:
      state === "PROVIDER_MISSING" ? "PARTIAL_RUN" : state === "HALTED" ? "HALTED" : "SUSPECT",
    corporateActionIds: [...(input.corporateActionIds ?? [])],
    flags: [`INTRADAY_${state}`],
    schemaVersion: INTRADAY_SCHEMA_VERSION,
    revision: 1,
    provenance: input.provenance,
  };
}

function validNumber(value: number): boolean {
  return Number.isFinite(value);
}

/** Converts provider aggregates into exactly one explicit state per expected interval. */
export function normalizeMassiveTenMinuteBars(
  input: IntradayNormalizationInput,
): CanonicalTenMinuteBar[] {
  const session = input.session ?? intradaySessionSpec(input.sessionDate);
  if (session.sessionDate !== input.sessionDate) throw new Error("SESSION_SPEC_MISMATCH");
  if (session.expectedIntervals === 0) return [];
  const byIndex = new Map<number, MassiveAggregateBar>();
  for (const aggregate of input.aggregates) {
    if (
      aggregate.symbol !== input.symbol ||
      !Number.isFinite(aggregate.timestamp) ||
      !validNumber(aggregate.open) ||
      !validNumber(aggregate.high) ||
      !validNumber(aggregate.low) ||
      !validNumber(aggregate.close) ||
      !validNumber(aggregate.volume) ||
      aggregate.volume < 0
    )
      continue;
    const local = easternParts(aggregate.timestamp);
    if (local.date !== input.sessionDate) continue;
    const offset = local.minutes - OPEN_MINUTES;
    if (offset < 0 || local.minutes >= session.closeMinutesEastern || offset % 10 !== 0) continue;
    const index = Math.floor(offset / 10);
    if (index < 0 || index >= session.expectedIntervals) continue;
    byIndex.set(index, aggregate);
  }
  return Array.from({ length: session.expectedIntervals }, (_, intervalIndex) => {
    const aggregate = byIndex.get(intervalIndex);
    if (!aggregate) return missingBar(input, intervalIndex);
    const state = aggregate.volume > 0 ? "VALID_TRADED" : "NO_TRADE";
    return {
      securityId: input.securityId,
      sessionDate: input.sessionDate,
      intervalIndex,
      state,
      ...(state === "VALID_TRADED"
        ? {
            open: scaledPrice(aggregate.open),
            high: scaledPrice(aggregate.high),
            low: scaledPrice(aggregate.low),
            close: scaledPrice(aggregate.close),
            volume: scaledVolume(aggregate.volume),
            ...(aggregate.vwap === undefined ? {} : { vwap: scaledPrice(aggregate.vwap) }),
            ...(aggregate.transactionCount === undefined
              ? {}
              : { transactionCount: scaledCount(aggregate.transactionCount) }),
          }
        : { volume: 0 }),
      sourceTimestamp: new Date(aggregate.timestamp).toISOString(),
      observedAt: input.observedAt,
      ingestedAt: input.ingestedAt ?? input.observedAt,
      dataQuality: state === "VALID_TRADED" ? "GOOD" : "SUSPECT",
      corporateActionIds: [...(input.corporateActionIds ?? [])],
      flags: ["MASSIVE_AGGREGATE_10M", state === "NO_TRADE" ? "NO_TRADE" : "REGULAR_SESSION"],
      schemaVersion: INTRADAY_SCHEMA_VERSION,
      revision: 1,
      provenance: input.provenance,
    } satisfies CanonicalTenMinuteBar;
  });
}

export function reconstructDailyBar(
  bars: readonly CanonicalTenMinuteBar[],
  observedAt = new Date().toISOString(),
): CanonicalDailyBar | undefined {
  const valid = bars
    .filter(
      (bar) =>
        bar.state === "VALID_TRADED" &&
        bar.open !== undefined &&
        bar.high !== undefined &&
        bar.low !== undefined &&
        bar.close !== undefined &&
        bar.volume !== undefined,
    )
    .sort((a, b) => a.intervalIndex - b.intervalIndex);
  const first = valid[0];
  const last = valid.at(-1);
  if (!first || !last) return undefined;
  return {
    securityId: first.securityId,
    sessionDate: first.sessionDate,
    open: first.open!,
    high: Math.max(...valid.map((bar) => bar.high!)),
    low: Math.min(...valid.map((bar) => bar.low!)),
    close: last.close!,
    volume: valid.reduce((sum, bar) => sum + bar.volume!, 0),
    ...(last.sourceTimestamp === undefined ? {} : { sourceTimestamp: last.sourceTimestamp }),
    observedAt,
    ingestedAt: observedAt,
    dataQuality: valid.length === bars.length ? "GOOD" : "PARTIAL_RUN",
    corporateActionIds: [...new Set(bars.flatMap((bar) => bar.corporateActionIds))],
    flags: ["RECONSTRUCTED_FROM_DUST_10M"],
    schemaVersion: "foundation-d-v0",
    revision: Math.max(...bars.map((bar) => bar.revision), 1),
    provenance: first.provenance,
  };
}

export interface AggregatedIntradayBar {
  securityId: string;
  sessionDate: string;
  intervalIndex: number;
  sourceIntervalMinutes: 10;
  targetIntervalMinutes: number;
  state: CanonicalTenMinuteBar["state"];
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

/** Rebuilds larger intraday views from canonical 10-minute source evidence. */
export function aggregateIntradayBars(
  bars: readonly CanonicalTenMinuteBar[],
  targetIntervalMinutes: number,
): AggregatedIntradayBar[] {
  if (
    !Number.isInteger(targetIntervalMinutes) ||
    targetIntervalMinutes < 10 ||
    targetIntervalMinutes % 10 !== 0
  )
    throw new Error("INVALID_AGGREGATION_INTERVAL");
  const groups = new Map<number, CanonicalTenMinuteBar[]>();
  for (const bar of bars) {
    const key = Math.floor(bar.intervalIndex / (targetIntervalMinutes / 10));
    groups.set(key, [...(groups.get(key) ?? []), bar]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([intervalIndex, group]) => {
      const valid = group
        .filter(
          (bar) =>
            bar.state === "VALID_TRADED" &&
            bar.open !== undefined &&
            bar.high !== undefined &&
            bar.low !== undefined &&
            bar.close !== undefined,
        )
        .sort((a, b) => a.intervalIndex - b.intervalIndex);
      const first = valid[0];
      const last = valid.at(-1);
      if (!first || !last)
        return {
          securityId: group[0]!.securityId,
          sessionDate: group[0]!.sessionDate,
          intervalIndex,
          sourceIntervalMinutes: 10,
          targetIntervalMinutes,
          state: group.some((bar) => bar.state === "HALTED") ? "HALTED" : "NO_TRADE",
        };
      return {
        securityId: first.securityId,
        sessionDate: first.sessionDate,
        intervalIndex,
        sourceIntervalMinutes: 10,
        targetIntervalMinutes,
        state: (valid.length === group.length
          ? "VALID_TRADED"
          : "PARTIAL") as CanonicalTenMinuteBar["state"],
        open: first.open!,
        high: Math.max(...valid.map((bar) => bar.high!)),
        low: Math.min(...valid.map((bar) => bar.low!)),
        close: last.close!,
        volume: valid.reduce((sum, bar) => sum + (bar.volume ?? 0), 0),
      };
    });
}
