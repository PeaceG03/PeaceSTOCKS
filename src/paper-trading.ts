/**
 * Simulated paper trading of the frozen TOP_15_OVERALL picks under the pre-registered rules
 * (config/paper-rules-v2.json, docs/PAPER_TRADING.md). No broker: every order is a ledger row filled from
 * the stored daily bars. Nothing here sends an order anywhere.
 *
 * One run: (1) gates (enabled, kill switches) before anything is read or written; (2) fill stored
 * intents whose session bars exist, oldest first; (3) write missing day rows; (4) before the next open,
 * write that open's intents: SELL everything held, BUY the frozen picks if the freeze proof holds and the
 * daily loss limit was not hit. Every write is write-once (src/paper-ledger.ts).
 */
import type {
  CanonicalDailyBar,
  CorporateAction,
  PredictionSet,
  PredictionStatus,
  SecurityMasterRecord,
} from "./contracts";
import { etCalendarDate, etWallClockToUtc } from "./et-time";
import {
  paperClientOrderId,
  paperCorrectionKey,
  paperLedgerKey,
  parsePaperCorrectionKey,
  type PaperCorrection,
  type PaperDay,
  type PaperEntryRefusal,
  type PaperFill,
  type PaperFills,
  type PaperIntents,
  type PaperLedgerStore,
  type PaperOrderIntent,
  type PaperPosition,
} from "./paper-ledger";
import type { LoadedPaperRules, PaperRules } from "./paper-rules";
import { resolveSessionPredictionStatus } from "./prediction-status";
import { resolveSpyBenchmarkId } from "./scanner";
import { nextEligibleSession, previousEligibleSession } from "./session-open";
import { splitEventsBySecurity, type SplitEvent } from "./split-adjust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Read-only view of the scanner's stored data that paper trading uses. */
export interface PaperMarketReader {
  loadPredictionStatuses(sessionDate: string): Promise<PredictionStatus[]>;
  loadPredictions(sessionDate: string): Promise<PredictionSet[]>;
  loadBarsBetween(from: string, to: string): Promise<CanonicalDailyBar[]>;
  loadSecurities(): Promise<SecurityMasterRecord[]>;
  loadSplitActions(): Promise<CorporateAction[]>;
}

export type PaperGate =
  | { state: "ON" }
  | { state: "DISABLED" }
  | { state: "KILLED"; source: "VARIABLE" | "FILE" | "BUCKET" };

/**
 * Default off: on only when PAPER_TRADING_ENABLED is exactly "true". PAPER_TRADING_KILL kills on any
 * value except empty or "false" (fail-safe), and so does a PAPER_TRADING_KILL file at the repo root.
 */
export function paperGate(env: Readonly<Record<string, string | undefined>>, killFileExists: boolean): PaperGate {
  if (env.PAPER_TRADING_ENABLED !== "true") return { state: "DISABLED" };
  const kill = (env.PAPER_TRADING_KILL ?? "").trim().toLowerCase();
  if (kill !== "" && kill !== "false") return { state: "KILLED", source: "VARIABLE" };
  if (killFileExists) return { state: "KILLED", source: "FILE" };
  return { state: "ON" };
}

export type FreezeProof =
  | { ok: true; securityIds: string[]; sessionOpen: string }
  | { ok: false; reason: PaperEntryRefusal };

/**
 * May the frozen picks of `freezeSessionDate` be entered at the open of `entrySessionDate`? Reuses the
 * stored freeze status (resolveSessionPredictionStatus, as the site does); never recomputes it.
 */
export function checkFreezeProof(
  statuses: readonly PredictionStatus[],
  sets: readonly PredictionSet[],
  freezeSessionDate: string,
  entrySessionDate: string,
  list: PaperRules["list"],
): FreezeProof {
  const own = statuses.filter((status) => status.sessionDate === freezeSessionDate);
  if (!own.length) return { ok: false, reason: "NO_FREEZE_STATUS" };
  if (own.some((status) => status.reason === "EVIDENCE_ONLY")) return { ok: false, reason: "EVIDENCE_ONLY" };
  const resolved = resolveSessionPredictionStatus(own)!;
  if (resolved.status !== "FROZEN") return { ok: false, reason: "UNAVAILABLE" };
  if (resolved.reason !== "PREDICTIONS_FROZEN") return { ok: false, reason: "NOT_PREDICTIONS_FROZEN" };
  if (!resolved.predictedAt || !resolved.nextSessionOpen || !resolved.nextSessionDate)
    return { ok: false, reason: "FREEZE_PROOF_MISSING" };
  if (resolved.nextSessionDate !== entrySessionDate) return { ok: false, reason: "FREEZE_SESSION_MISMATCH" };
  const open = Date.parse(resolved.nextSessionOpen);
  const predicted = Date.parse(resolved.predictedAt);
  if (!Number.isFinite(open) || !Number.isFinite(predicted)) return { ok: false, reason: "FREEZE_PROOF_MISSING" };
  if (open !== etWallClockToUtc(entrySessionDate, 9, 30).getTime()) return { ok: false, reason: "FREEZE_SESSION_MISMATCH" };
  if (!(predicted < open)) return { ok: false, reason: "FROZEN_AFTER_OPEN" };
  const candidates = sets.filter((set) => set.setType === list && set.sessionDate === freezeSessionDate);
  if (candidates.length !== 1) return { ok: false, reason: "LIST_MISSING" };
  const set = candidates[0]!;
  if (set.unavailableReason || !set.securityIds.length) return { ok: false, reason: "LIST_EMPTY" };
  const frozen = Date.parse(set.frozenAt);
  if (!Number.isFinite(frozen) || !(frozen < open)) return { ok: false, reason: "FROZEN_AFTER_OPEN" };
  return { ok: true, securityIds: [...new Set(set.securityIds)], sessionOpen: resolved.nextSessionOpen };
}

/** True when the book lost the limit or more: mark / start - 1 <= -limit. */
export function dailyLossBreached(equityStart: number, equityMark: number, limit: number): boolean {
  if (!(equityStart > 0)) return true;
  return equityMark / equityStart - 1 <= -limit;
}

/** Equal weight, capped: min(equity / names, cap x equity). */
export function entryNotional(equity: number, names: number, cap: number): number {
  if (!(names > 0) || !(equity > 0)) return 0;
  return Math.min(equity / names, cap * equity);
}

export const buyFillPrice = (open: number, bps: number) => open * (1 + bps / 10_000);
export const sellFillPrice = (open: number, bps: number) => open * (1 - bps / 10_000);

/** Product of split factors effective in (after, upTo]; NaN when any is unusable; 1 when none. */
export function splitFactorBetween(events: readonly SplitEvent[] | undefined, after: string, upTo: string): number {
  let product = 1;
  for (const event of events ?? []) if (event.effectiveDate > after && event.effectiveDate <= upTo) product *= event.factor;
  return product;
}

/**
 * The split factor paper fills and both benchmarks apply, the same way: the known records' product,
 * or 1 (the actual, unadjusted price) when the records conflict. Nothing is dropped or filled flat.
 */
export function appliedSplitFactor(events: readonly SplitEvent[] | undefined, after: string, upTo: string): { factor: number; unreconciled: boolean } {
  const factor = splitFactorBetween(events, after, upTo);
  return Number.isFinite(factor) && factor > 0 ? { factor, unreconciled: false } : { factor: 1, unreconciled: true };
}

/** One bar per security and session (highest revision), with lookups. */
export class PaperBars {
  private readonly byId = new Map<string, Map<string, CanonicalDailyBar>>();
  private readonly dates = new Set<string>();
  constructor(bars: Iterable<CanonicalDailyBar>) {
    for (const bar of bars) {
      let own = this.byId.get(bar.securityId);
      if (!own) this.byId.set(bar.securityId, (own = new Map()));
      const prior = own.get(bar.sessionDate);
      if (!prior || bar.revision >= prior.revision) own.set(bar.sessionDate, bar);
      this.dates.add(bar.sessionDate);
    }
  }
  hasSession(date: string): boolean {
    return this.dates.has(date);
  }
  open(id: string, date: string): number | undefined {
    const value = this.byId.get(id)?.get(date)?.open;
    return value !== undefined && value > 0 && Number.isFinite(value) ? value : undefined;
  }
  /** Newest positive close on or before `date` (strictly before when `strict`). */
  lastClose(id: string, date: string, strict: boolean): number | undefined {
    let best: CanonicalDailyBar | undefined;
    for (const bar of this.byId.get(id)?.values() ?? []) {
      if (strict ? bar.sessionDate >= date : bar.sessionDate > date) continue;
      if (!(bar.close > 0) || !Number.isFinite(bar.close)) continue;
      if (!best || bar.sessionDate > best.sessionDate) best = bar;
    }
    return best?.close;
  }
}

interface BookState {
  cash: number;
  positions: PaperPosition[];
}

/** Fill one session's intents at its open: exits first, then equal-weight capped entries. Pure. */
export function computeFills(input: {
  intents: PaperIntents;
  prior: BookState;
  bars: PaperBars;
  splits: ReadonlyMap<string, SplitEvent[]>;
  loaded: LoadedPaperRules;
  /** Corrections to add to cash at this open: their total, and every key applied so far (this open's included). */
  corrections?: { usd: number; applied: string[] };
}): PaperFills {
  const { intents, bars, splits } = input;
  const { rules, rulesSha256 } = input.loaded;
  const stamp = { rulesVersion: rules.rulesVersion, rulesSha256 };
  const S = intents.sessionDate;
  const bps = rules.slippageBpsPerSide;
  const commission = rules.commissionPerOrderUsd;
  const cashBefore = input.prior.cash + (input.corrections?.usd ?? 0);
  let cash = cashBefore;
  const held = new Map(input.prior.positions.map((position) => [position.securityId, position]));
  const fills: PaperFill[] = [];
  const base = (order: PaperOrderIntent) => ({
    ...stamp,
    clientOrderId: order.clientOrderId,
    securityId: order.securityId,
    side: order.side,
    purpose: order.purpose,
  });
  const none = { qty: 0, notionalUsd: 0, commissionUsd: 0, slippageUsd: 0 };

  for (const order of intents.orders.filter((o) => o.side === "SELL")) {
    const position = held.get(order.securityId);
    if (!position) {
      fills.push({ ...base(order), status: "NOT_HELD", ...none, flags: [] });
      continue;
    }
    const rawOpen = bars.open(order.securityId, S);
    const missed = (position.missedExits ?? 0) + 1;
    if (rawOpen === undefined && missed < rules.writeOffAfterMissedExits) {
      // Halted or no bar: stays held, sold at the next open it has.
      held.set(order.securityId, { ...position, missedExits: missed });
      fills.push({ ...base(order), status: "NO_PRICE", ...none, flags: [] });
      continue;
    }
    // Exit at the actual open (split-adjusted by the records known now; later records append a
    // correction). After writeOffAfterMissedExits misses in a row: written off at the last known close.
    const writeOff = rawOpen === undefined;
    const rawPrice = rawOpen ?? bars.lastClose(order.securityId, S, true) ?? position.entryOpen;
    const split = appliedSplitFactor(splits.get(order.securityId), position.entrySessionDate, S);
    const price = rawPrice / split.factor;
    const fillPrice = writeOff ? price : sellFillPrice(price, bps);
    const notional = position.qty * fillPrice;
    const orderCommission = writeOff ? 0 : commission;
    cash += notional - orderCommission;
    held.delete(order.securityId);
    fills.push({
      ...base(order),
      status: writeOff ? "WRITTEN_OFF" : "FILLED",
      qty: position.qty,
      ...(rawOpen !== undefined ? { rawOpen } : {}),
      rawPrice,
      fillPrice,
      splitFactorApplied: split.factor,
      entrySessionDate: position.entrySessionDate,
      notionalUsd: notional,
      commissionUsd: orderCommission,
      slippageUsd: writeOff ? 0 : position.qty * price * (bps / 10_000),
      flags: [...(split.unreconciled ? ["SPLIT_UNRECONCILED"] : []), ...(writeOff ? ["WRITE_OFF_LAST_CLOSE"] : [])],
    });
  }
  const cashAfterExits = cash;
  let marked = 0;
  for (const position of held.values())
    marked += position.qty * (bars.lastClose(position.securityId, S, true) ?? position.entryOpen);
  const equityAtOpen = cashAfterExits + marked;

  const buys = intents.orders.filter((o) => o.side === "BUY");
  const perName = entryNotional(equityAtOpen, buys.length, rules.maxPositionFractionOfEquity);
  for (const order of buys) {
    if (held.has(order.securityId)) {
      fills.push({ ...base(order), status: "ALREADY_HELD", ...none, flags: [] });
      continue;
    }
    const rawOpen = bars.open(order.securityId, S);
    if (rawOpen === undefined) {
      fills.push({ ...base(order), status: "NO_PRICE", ...none, flags: [] });
      continue;
    }
    const fillPrice = buyFillPrice(rawOpen, bps);
    const budget = Math.min(perName, cash) - commission;
    const qty = budget > 0 ? Math.floor(budget / fillPrice) : 0;
    if (qty <= 0) {
      fills.push({ ...base(order), status: "ZERO_QTY", ...none, rawOpen, flags: [] });
      continue;
    }
    const notional = qty * fillPrice;
    cash -= notional + commission;
    held.set(order.securityId, { securityId: order.securityId, qty, entryOpen: rawOpen, entryFillPrice: fillPrice, entrySessionDate: S });
    fills.push({
      ...base(order),
      status: "FILLED",
      qty,
      rawOpen,
      fillPrice,
      notionalUsd: notional,
      commissionUsd: commission,
      slippageUsd: qty * rawOpen * (bps / 10_000),
      flags: [],
    });
  }
  if (cash < -1e-6) throw new Error("PAPER_CASH_NEGATIVE");
  return {
    schemaVersion: "paper-fills-v1",
    ...stamp,
    sessionDate: S,
    cashBefore,
    cashAfterExits,
    equityAtOpen,
    cashAfter: cash,
    positionsAfter: [...held.values()].sort((a, b) => a.securityId.localeCompare(b.securityId)),
    fills,
    ...(input.corrections && input.corrections.applied.length
      ? { correctionsUsd: input.corrections.usd, correctionsApplied: [...input.corrections.applied].sort() }
      : {}),
  };
}

/**
 * Corrections owed on stored exit fills: for each FILLED / WRITTEN_OFF exit whose split factor (by the
 * records known now, appliedSplitFactor) differs from the factor its latest price used, the next
 * correction. The fill itself is never rewritten. Pure.
 */
export function correctionsFor(input: {
  fills: PaperFills;
  latest: ReadonlyMap<string, PaperCorrection>;
  splits: ReadonlyMap<string, SplitEvent[]>;
  loaded: LoadedPaperRules;
  now: Date;
}): PaperCorrection[] {
  const { rules, rulesSha256 } = input.loaded;
  const out: PaperCorrection[] = [];
  for (const fill of input.fills.fills) {
    if (fill.side !== "SELL" || (fill.status !== "FILLED" && fill.status !== "WRITTEN_OFF")) continue;
    if (fill.rawPrice === undefined || fill.splitFactorApplied === undefined || !fill.entrySessionDate || fill.fillPrice === undefined) continue;
    const previous = input.latest.get(fill.securityId);
    const previousFactor = previous?.correctedFactor ?? fill.splitFactorApplied;
    const previousFillPrice = previous?.correctedFillPrice ?? fill.fillPrice;
    const now = appliedSplitFactor(input.splits.get(fill.securityId), fill.entrySessionDate, input.fills.sessionDate).factor;
    if (Math.abs(now / previousFactor - 1) <= 1e-9) continue;
    const price = fill.rawPrice / now;
    const correctedFillPrice = fill.status === "WRITTEN_OFF" ? price : sellFillPrice(price, rules.slippageBpsPerSide);
    out.push({
      schemaVersion: "paper-correction-v1",
      rulesVersion: rules.rulesVersion,
      rulesSha256,
      sessionDate: input.fills.sessionDate,
      securityId: fill.securityId,
      clientOrderId: fill.clientOrderId,
      n: (previous?.n ?? 0) + 1,
      qty: fill.qty,
      rawPrice: fill.rawPrice,
      previousFactor,
      previousFillPrice,
      correctedFactor: now,
      correctedFillPrice,
      cashAdjustmentUsd: fill.qty * (correctedFillPrice - previousFillPrice),
      recordedAt: input.now.toISOString(),
    });
  }
  return out;
}

/** How many recent fill sessions are re-checked for late split records each run. */
export const PAPER_CORRECTION_LOOKBACK_SESSIONS = 30;

/**
 * Open-to-open return at the actual opens, split-adjusted exactly as paper exits are
 * (appliedSplitFactor); undefined only when a price is missing. No gap filter: big moves count.
 */
export function windowReturn(
  bars: PaperBars,
  splits: ReadonlyMap<string, SplitEvent[]>,
  id: string,
  from: string,
  to: string,
): number | undefined {
  const a = bars.open(id, from);
  const b = bars.open(id, to);
  if (a === undefined || b === undefined) return undefined;
  return b / appliedSplitFactor(splits.get(id), from, to).factor / a - 1;
}

const compound = (cumulative: number, r: number | null) => (r === null ? cumulative : (1 + cumulative) * (1 + r) - 1);

export function computeDay(input: {
  from: PaperFills;
  to: PaperFills;
  fromIntents?: PaperIntents | undefined;
  previousDay?: PaperDay;
  bars: PaperBars;
  splits: ReadonlyMap<string, SplitEvent[]>;
  securities: readonly SecurityMasterRecord[];
  loaded: LoadedPaperRules;
}): PaperDay {
  const { from, to, bars, splits } = input;
  const { rules, rulesSha256 } = input.loaded;
  const spyId = resolveSpyBenchmarkId(input.securities);
  const spy = spyId ? windowReturn(bars, splits, spyId, from.sessionDate, to.sessionDate) ?? null : null;
  const universe: number[] = [];
  for (const security of input.securities) {
    if (security.status !== "ACTIVE" || (security.eligibility !== "LEVEL_2" && security.eligibility !== "LEVEL_3")) continue;
    const r = windowReturn(bars, splits, security.securityId, from.sessionDate, to.sessionDate);
    if (r !== undefined) universe.push(r);
  }
  const universeReturn = universe.length ? universe.reduce((sum, r) => sum + r, 0) / universe.length : null;
  const paperReturn = to.equityAtOpen / from.equityAtOpen - 1;
  const cost = (fill: PaperFill) => fill.slippageUsd + fill.commissionUsd;
  const costsUsd =
    from.fills.filter((f) => f.side === "BUY").reduce((sum, f) => sum + cost(f), 0) +
    to.fills.filter((f) => f.side === "SELL").reduce((sum, f) => sum + cost(f), 0);
  const prev = input.previousDay;
  return {
    schemaVersion: "paper-day-v1",
    rulesVersion: rules.rulesVersion,
    rulesSha256,
    fromSessionDate: from.sessionDate,
    toSessionDate: to.sessionDate,
    equityFrom: from.equityAtOpen,
    equityTo: to.equityAtOpen,
    paperReturn,
    spyReturn: spy,
    universeReturn,
    universeSize: universe.length,
    cumulativePaperReturn: compound(prev?.cumulativePaperReturn ?? 0, paperReturn),
    cumulativeSpyReturn: compound(prev?.cumulativeSpyReturn ?? 0, spy),
    cumulativeUniverseReturn: compound(prev?.cumulativeUniverseReturn ?? 0, universeReturn),
    positions: from.positionsAfter.length,
    costsUsd,
    ...(to.correctionsUsd ? { correctionsUsd: to.correctionsUsd } : {}),
    ...(input.fromIntents?.entriesRefused ? { entriesRefused: input.fromIntents.entriesRefused } : {}),
  };
}

/** The next session whose 09:30 ET open is strictly after `now`. */
export function nextOpenSession(now: Date, calendar = US_EQUITY_MARKET_CALENDAR): string {
  const today = etCalendarDate(now);
  const kind = calendar.getSession(today).kind;
  if ((kind === "NORMAL" || kind === "HALF_DAY") && now.getTime() < etWallClockToUtc(today, 9, 30).getTime()) return today;
  const next = nextEligibleSession(today, calendar);
  if (!next) throw new Error("PAPER_NO_NEXT_SESSION");
  return next;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export interface PaperRunResult {
  gate: PaperGate["state"];
  killedBy?: "VARIABLE" | "FILE" | "BUCKET";
  filled: string[];
  /** Pending intents left unfilled because their session's bars are not stored yet. */
  pendingFills: number;
  /** Correction keys appended this run. */
  corrections?: string[];
  days: string[];
  intents?: {
    sessionDate: string;
    outcome: "WRITTEN" | "KEPT_EXISTING" | "DEFERRED_NO_FREEZE_STATUS" | "TOO_LATE";
    entries: number;
    exits: number;
    entriesRefused?: PaperEntryRefusal;
  };
}

export async function runPaperTrading(options: {
  ledger: PaperLedgerStore;
  market: PaperMarketReader;
  loaded: LoadedPaperRules;
  now: Date;
  env: Readonly<Record<string, string | undefined>>;
  killFileExists: boolean;
  calendar?: typeof US_EQUITY_MARKET_CALENDAR;
}): Promise<PaperRunResult> {
  const { ledger, market, loaded, now } = options;
  const { rules, rulesSha256 } = loaded;
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const gate = paperGate(options.env, options.killFileExists);
  if (gate.state !== "ON") return { gate: gate.state, ...(gate.state === "KILLED" ? { killedBy: gate.source } : {}), filled: [], pendingFills: 0, days: [] };
  if (await ledger.killed()) return { gate: "KILLED", killedBy: "BUCKET", filled: [], pendingFills: 0, days: [] };

  const intentSessions = await ledger.sessions("intents");
  const fillSessions = await ledger.sessions("fills");
  const daySessions = new Set(await ledger.sessions("days"));
  const filledSet = new Set(fillSessions);
  const lastFilled = fillSessions.at(-1);
  const pending = intentSessions.filter((s) => !filledSet.has(s));
  if (lastFilled && pending.some((s) => s < lastFilled)) throw new Error("PAPER_LEDGER_OUT_OF_ORDER");
  const T = nextOpenSession(now, calendar);
  const D = previousEligibleSession(T, calendar);
  if (!D) throw new Error("PAPER_NO_PREVIOUS_SESSION");
  const missingDays = fillSessions.filter((s, i) => i > 0 && !daySessions.has(s));
  const needIntents = !intentSessions.includes(T);

  const result: PaperRunResult = { gate: "ON", filled: [], pendingFills: 0, days: [] };
  const splits = splitEventsBySecurity(await market.loadSplitActions());
  const fillsCache = new Map<string, PaperFills>();
  const readFills = async (s: string) => {
    let found = fillsCache.get(s);
    if (!found) {
      found = await ledger.read<PaperFills>(paperLedgerKey("fills", s));
      if (!found) throw new Error("PAPER_LEDGER_FILLS_MISSING");
      fillsCache.set(s, found);
    }
    return found;
  };

  // (1b) Late split records: append corrections for recent exit fills (fills are never rewritten).
  const correctionKeys = await ledger.correctionKeys();
  for (const F of fillSessions.slice(-PAPER_CORRECTION_LOOKBACK_SESSIONS)) {
    const latest = new Map<string, PaperCorrection>();
    for (const key of correctionKeys) {
      const parsed = parsePaperCorrectionKey(key);
      if (!parsed || parsed.sessionDate !== F) continue;
      if ((latest.get(parsed.securityId)?.n ?? 0) > parsed.n) continue;
      const stored = await ledger.read<PaperCorrection>(key);
      if (stored) latest.set(parsed.securityId, stored);
    }
    for (const correction of correctionsFor({ fills: await readFills(F), latest, splits, loaded, now })) {
      const key = paperCorrectionKey(F, correction.securityId, correction.n);
      await ledger.putOnce(key, correction);
      correctionKeys.push(key);
      (result.corrections ??= []).push(key);
    }
  }

  if (!pending.length && !missingDays.length && !needIntents) {
    result.intents = { sessionDate: T, outcome: "KEPT_EXISTING", entries: 0, exits: 0 };
    return result;
  }

  // Bars for every session this run reads, plus 21 days before for last-close marks.
  const predecessors = missingDays.map((s) => fillSessions[fillSessions.indexOf(s) - 1]!);
  const dates = [...pending, ...missingDays, ...predecessors, D, ...(lastFilled ? [lastFilled] : [])].sort();
  const bars = new PaperBars(await market.loadBarsBetween(addDays(dates[0]!, -21), dates.at(-1)!));
  let securities: SecurityMasterRecord[] | undefined;
  const loadSecurities = async () => (securities ??= await market.loadSecurities());

  // (2) Fill pending intents, oldest first; stop at the first session whose bars are not stored yet.
  let state: BookState = lastFilled
    ? { cash: (await readFills(lastFilled)).cashAfter, positions: (await readFills(lastFilled)).positionsAfter }
    : { cash: rules.startingCapitalUsd, positions: [] };
  const allFilled = [...fillSessions];
  for (const S of pending) {
    if (!bars.hasSession(S)) break;
    const intents = await ledger.read<PaperIntents>(paperLedgerKey("intents", S));
    if (!intents) throw new Error("PAPER_LEDGER_INTENTS_MISSING");
    // Corrections not yet in cash enter it at this open.
    const applied = new Set((allFilled.length ? (await readFills(allFilled.at(-1)!)).correctionsApplied : undefined) ?? []);
    let usd = 0;
    for (const key of correctionKeys.filter((k) => !applied.has(k)).sort()) {
      usd += (await ledger.read<PaperCorrection>(key))!.cashAdjustmentUsd;
      applied.add(key);
    }
    const fills = computeFills({ intents, prior: state, bars, splits, loaded, corrections: { usd, applied: [...applied] } });
    if ((await ledger.putOnce(paperLedgerKey("fills", S), fills)) === "KEPT_EXISTING") {
      // A concurrent or earlier write won: continue from what is stored.
      fillsCache.delete(S);
    } else fillsCache.set(S, fills);
    const stored = await readFills(S);
    state = { cash: stored.cashAfter, positions: stored.positionsAfter };
    allFilled.push(S);
    result.filled.push(S);
  }
  result.pendingFills = pending.length - result.filled.length;

  // (3) Day rows for every filled session after the first that has none, in order.
  let previousDay: PaperDay | undefined;
  for (let i = 1; i < allFilled.length; i += 1) {
    const S = allFilled[i]!;
    if (daySessions.has(S)) {
      previousDay = undefined;
      continue;
    }
    const prior = allFilled[i - 1]!;
    previousDay ??= i > 1 ? await ledger.read<PaperDay>(paperLedgerKey("days", prior)) : undefined;
    if (i > 1 && !previousDay) throw new Error("PAPER_LEDGER_DAY_MISSING");
    const day = computeDay({
      from: await readFills(prior),
      to: await readFills(S),
      fromIntents: await ledger.read<PaperIntents>(paperLedgerKey("intents", prior)),
      ...(previousDay ? { previousDay } : {}),
      bars,
      splits,
      securities: await loadSecurities(),
      loaded,
    });
    await ledger.putOnce(paperLedgerKey("days", S), day);
    previousDay = (await ledger.read<PaperDay>(paperLedgerKey("days", S)))!;
    result.days.push(S);
  }

  // (4) Intents for the next open, written only before it.
  const sessionOpen = etWallClockToUtc(T, 9, 30);
  if (!needIntents) {
    result.intents = { sessionDate: T, outcome: "KEPT_EXISTING", entries: 0, exits: 0 };
    return result;
  }
  if (!(now.getTime() < sessionOpen.getTime())) {
    result.intents = { sessionDate: T, outcome: "TOO_LATE", entries: 0, exits: 0 };
    return result;
  }
  const statuses = await market.loadPredictionStatuses(D);
  if (!statuses.some((status) => status.sessionDate === D)) {
    result.intents = { sessionDate: T, outcome: "DEFERRED_NO_FREEZE_STATUS", entries: 0, exits: 0 };
    return result;
  }
  const stillPending = pending.filter((s) => !result.filled.includes(s));
  const holdings = new Set(state.positions.map((p) => p.securityId));
  for (const s of stillPending) {
    const intents = await ledger.read<PaperIntents>(paperLedgerKey("intents", s));
    for (const order of intents?.orders ?? []) if (order.side === "BUY") holdings.add(order.securityId);
  }
  let refused: PaperEntryRefusal | undefined;
  let picks: string[] = [];
  if (stillPending.length) refused = "FILLS_PENDING";
  else {
    const proof = checkFreezeProof(statuses, await market.loadPredictions(D), D, T, rules.list);
    if (!proof.ok) refused = proof.reason;
    else {
      const last = allFilled.at(-1);
      if (last) {
        const lastFills = await readFills(last);
        let mark = lastFills.cashAfter;
        for (const p of lastFills.positionsAfter) mark += p.qty * (bars.lastClose(p.securityId, D, false) ?? p.entryOpen);
        if (dailyLossBreached(lastFills.equityAtOpen, mark, rules.dailyLossLimitFraction)) refused = "DAILY_LOSS_LIMIT";
      }
      if (!refused) picks = proof.securityIds;
    }
  }
  const stamp = { rulesVersion: rules.rulesVersion, rulesSha256 };
  const order = (securityId: string, side: "BUY" | "SELL"): PaperOrderIntent => ({
    ...stamp,
    clientOrderId: paperClientOrderId(rules.rulesVersion, T, securityId, side),
    sessionDate: T,
    securityId,
    side,
    purpose: side === "BUY" ? "ENTRY" : "EXIT",
  });
  const orders = [
    ...[...holdings].sort().map((id) => order(id, "SELL")),
    ...picks.map((id) => order(id, "BUY")),
  ];
  if (new Set(orders.map((o) => o.clientOrderId)).size !== orders.length) throw new Error("PAPER_DUPLICATE_ORDER_ID");
  const intents: PaperIntents = {
    schemaVersion: "paper-intents-v1",
    ...stamp,
    sessionDate: T,
    freezeSessionDate: D,
    recordedAt: now.toISOString(),
    sessionOpen: sessionOpen.toISOString(),
    orders,
    ...(refused ? { entriesRefused: refused } : {}),
  };
  const outcome = await ledger.putOnce(paperLedgerKey("intents", T), intents);
  result.intents = {
    sessionDate: T,
    outcome,
    entries: picks.length,
    exits: holdings.size,
    ...(refused ? { entriesRefused: refused } : {}),
  };
  return result;
}
