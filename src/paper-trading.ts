/**
 * Simulated paper trading of the frozen TOP_15_OVERALL picks under the pre-registered rules
 * (config/paper-rules-v5.json, docs/PAPER_TRADING.md). No broker: every order is a ledger row filled from
 * the stored daily bars. Nothing here sends an order anywhere.
 *
 * One run: (1) gates (enabled, kill switches) before anything is read or written; (1b) corrections for
 * late split records; (1c) resolutions of STUCK holdings (marked $0) from a later price or cash settlement; (2) fill stored exits and intents whose session bars exist, oldest first; (3)
 * write missing day rows; (4) before the next open, write its exits (SELL everything held, whatever the
 * freeze status) and, once the freeze status is stored, its entries (BUY the frozen picks if the freeze
 * proof holds and the daily loss limit was not hit). Every write is write-once (src/paper-ledger.ts).
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
  type PaperExits,
  type PaperFill,
  type PaperFills,
  type PaperIntents,
  type PaperLedgerStore,
  type PaperOrderIntent,
  type PaperPosition,
  type PaperRecoveryReview,
  type PaperStuckResolution,
  type PaperUniverseResolution,
  type PaperUniverseStuck,
} from "./paper-ledger";
import type { LoadedPaperRules, PaperRules } from "./paper-rules";
import { resolveSessionPredictionStatus } from "./prediction-status";
import { resolveSpyBenchmarkId } from "./scanner";
import { nextEligibleSession, previousEligibleSession } from "./session-open";
import { SETTLEMENT_ACTION_TYPES, splitEventsBySecurity, type SplitEvent } from "./split-adjust";
export { SETTLEMENT_ACTION_TYPES };
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Read-only view of the scanner's stored data that paper trading uses. */
export interface PaperMarketReader {
  loadPredictionStatuses(sessionDate: string): Promise<PredictionStatus[]>;
  loadPredictions(sessionDate: string): Promise<PredictionSet[]>;
  loadBarsBetween(from: string, to: string): Promise<CanonicalDailyBar[]>;
  loadSecurities(): Promise<SecurityMasterRecord[]>;
  loadSplitActions(): Promise<CorporateAction[]>;
  /** Stored MERGER / CLOSURE / DELISTING records (cash settlements). Optional: none means none known. */
  loadSettlementActions?(): Promise<CorporateAction[]>;
}

/** Cash per share a stored settlement record pays (0 is a valid bankruptcy payout), or undefined. */
export function settlementCashPerShare(action: Pick<CorporateAction, "actionType" | "details">): number | undefined {
  if (!SETTLEMENT_ACTION_TYPES.includes(action.actionType)) return undefined;
  const cash = (action.details as Record<string, unknown> | undefined)?.cash_per_share;
  return typeof cash === "number" && Number.isFinite(cash) && cash >= 0 ? cash : undefined;
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

/** Stored sessions before a session whose median name count defines "normal" coverage. */
export const COVERAGE_TRAILING_SESSIONS = 20;

/** One bar per security and session (highest revision), with lookups. */
export class PaperBars {
  private readonly byId = new Map<string, Map<string, CanonicalDailyBar>>();
  private readonly dates = new Set<string>();
  private readonly names = new Map<string, number>();
  private sorted: string[] | undefined;
  private readonly coveredCache = new Map<string, boolean>();
  private readonly idsOn = new Map<string, Set<string>>();
  private readonly dropoutCount = new Map<string, number | undefined>();
  private readonly spikeCache = new Map<string, boolean>();
  constructor(bars: Iterable<CanonicalDailyBar>) {
    for (const bar of bars) {
      let own = this.byId.get(bar.securityId);
      if (!own) this.byId.set(bar.securityId, (own = new Map()));
      const prior = own.get(bar.sessionDate);
      if (!prior) this.names.set(bar.sessionDate, (this.names.get(bar.sessionDate) ?? 0) + 1);
      let ids = this.idsOn.get(bar.sessionDate);
      if (!ids) this.idsOn.set(bar.sessionDate, (ids = new Set()));
      ids.add(bar.securityId);
      if (!prior || bar.revision >= prior.revision) own.set(bar.sessionDate, bar);
      this.dates.add(bar.sessionDate);
    }
  }
  hasSession(date: string): boolean {
    return this.dates.has(date);
  }
  /** Oldest stored session, or undefined when there are no bars. */
  firstSession(): string | undefined {
    return (this.sorted ??= [...this.dates].sort())[0];
  }
  /** Names with a stored bar on this session (0 when none). */
  nameCount(date: string): number {
    return this.names.get(date) ?? 0;
  }
  /**
   * Is this session covered by our data? False for a coverage hole: no bars at all, or fewer names than
   * `fraction` x the median name count of the COVERAGE_TRAILING_SESSIONS stored sessions before it
   * (as loaded). With no stored session before it, a session with bars counts as covered.
   */
  covered(date: string, fraction: number): boolean {
    if (!this.dates.has(date)) return false;
    const key = `${date}|${fraction}`;
    const cached = this.coveredCache.get(key);
    if (cached !== undefined) return cached;
    const sorted = (this.sorted ??= [...this.dates].sort());
    const at = sorted.indexOf(date);
    const trailing = sorted.slice(Math.max(0, at - COVERAGE_TRAILING_SESSIONS), at).map((d) => this.nameCount(d)).sort((a, b) => a - b);
    let result = true;
    if (trailing.length) {
      const mid = trailing.length >> 1;
      const median = trailing.length % 2 ? trailing[mid]! : (trailing[mid - 1]! + trailing[mid]!) / 2;
      result = this.nameCount(date) >= fraction * median;
    }
    this.coveredCache.set(key, result);
    return result;
  }
  /** Every stored session (as loaded), oldest first. */
  storedSessions(): readonly string[] {
    return (this.sorted ??= [...this.dates].sort());
  }
  /** Stored session right after `date` (as loaded), or undefined. */
  nextStoredSession(date: string): string | undefined {
    const sorted = (this.sorted ??= [...this.dates].sort());
    return sorted.find((d) => d > date);
  }
  /** Does the name have any stored bar on this session? */
  hasBar(id: string, date: string): boolean {
    return this.idsOn.get(date)?.has(id) ?? false;
  }
  /**
   * Drop-outs on a stored session: names with a bar on the stored session before it and none on this
   * one. Undefined for the oldest stored session or a session with no bars.
   */
  dropouts(date: string): number | undefined {
    if (this.dropoutCount.has(date)) return this.dropoutCount.get(date);
    const sorted = (this.sorted ??= [...this.dates].sort());
    const at = sorted.indexOf(date);
    let result: number | undefined;
    if (at > 0) {
      const today = this.idsOn.get(date)!;
      result = 0;
      for (const id of this.idsOn.get(sorted[at - 1]!)!) if (!today.has(id)) result += 1;
    }
    this.dropoutCount.set(date, result);
    return result;
  }
  /**
   * Is this session a mass drop-out (a gap in our data, not halts)? Its drop-outs are above both
   * dropoutSpikeMinNames and dropoutSpikeMultiple x the 99th percentile (nearest rank) of the drop-outs
   * on the COVERAGE_TRAILING_SESSIONS stored sessions before it. False when nothing trails it.
   */
  dropoutSpike(date: string, rules: Pick<PaperRules, "dropoutSpikeMultiple" | "dropoutSpikeMinNames">): boolean {
    const key = `${date}|${rules.dropoutSpikeMultiple}|${rules.dropoutSpikeMinNames}`;
    const cached = this.spikeCache.get(key);
    if (cached !== undefined) return cached;
    const count = this.dropouts(date);
    const sorted = (this.sorted ??= [...this.dates].sort());
    const at = sorted.indexOf(date);
    const trailing = sorted
      .slice(Math.max(0, at - COVERAGE_TRAILING_SESSIONS), Math.max(0, at))
      .map((d) => this.dropouts(d))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b);
    let result = false;
    if (count !== undefined && trailing.length) {
      const p99 = trailing[Math.ceil(0.99 * trailing.length) - 1]!;
      result = count > rules.dropoutSpikeMinNames && count > rules.dropoutSpikeMultiple * p99;
    }
    this.spikeCache.set(key, result);
    return result;
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
  /** Session of the newest positive close strictly before `date`, with that close. */
  lastCloseBefore(id: string, date: string): { sessionDate: string; close: number } | undefined {
    let best: CanonicalDailyBar | undefined;
    for (const bar of this.byId.get(id)?.values() ?? []) {
      if (bar.sessionDate >= date || !(bar.close > 0) || !Number.isFinite(bar.close)) continue;
      if (!best || bar.sessionDate > best.sessionDate) best = bar;
    }
    return best ? { sessionDate: best.sessionDate, close: best.close } : undefined;
  }
  /** Sessions with a usable open for this security, oldest first. */
  openSessions(id: string): string[] {
    return [...(this.byId.get(id)?.keys() ?? [])].filter((date) => this.open(id, date) !== undefined).sort();
  }
}

/** A holding's mark: $0 once STUCK, otherwise qty x the last close (or the entry open when none). */
export function positionMark(position: PaperPosition, lastClose: number | undefined): number {
  return position.stuckSince ? 0 : position.qty * (lastClose ?? position.entryOpen);
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
  /** STUCK holdings whose resolution enters cash at this open (they leave the book here). */
  resolved?: readonly PaperStuckResolution[];
  calendar?: typeof US_EQUITY_MARKET_CALENDAR;
  /** STUCK holdings whose later price is held back by the reverse-split guard (RECOVERY_NEEDS_REVIEW). */
  recoveryReviews?: ReadonlyMap<string, PaperRecoveryReview>;
}): PaperFills {
  const { intents, bars, splits } = input;
  const calendar = input.calendar ?? US_EQUITY_MARKET_CALENDAR;
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

  // A STUCK holding whose resolution (the actual amount) enters cash at this open leaves the book here.
  for (const resolution of input.resolved ?? []) {
    const position = held.get(resolution.securityId);
    if (!position?.stuckSince) continue;
    held.delete(resolution.securityId);
    fills.push({ ...stamp, clientOrderId: resolution.clientOrderId, securityId: resolution.securityId, side: "SELL", purpose: "EXIT", status: "STUCK_RESOLVED", ...none, qty: position.qty, entrySessionDate: position.entrySessionDate, flags: [] });
  }

  for (const order of intents.orders.filter((o) => o.side === "SELL")) {
    const position = held.get(order.securityId);
    if (!position) {
      fills.push({ ...base(order), status: "NOT_HELD", ...none, flags: [] });
      continue;
    }
    if (position.stuckSince) {
      // Already at $0: stays a STUCK holding until a resolution shows up in the data.
      fills.push({ ...base(order), status: "STUCK", ...none, flags: [] });
      continue;
    }
    const rawOpen = bars.open(order.securityId, S);
    const kind = rawOpen === undefined ? missKind(bars, order.securityId, S, rules, calendar) : undefined;
    if (kind === "COVERAGE_HOLE" || kind === "DATA_DROPOUT") {
      // A gap in our data (a coverage hole, or a mass drop-out inside its fallback window): not a
      // missed exit; stays held.
      fills.push({ ...base(order), status: "NO_PRICE", ...none, flags: [kind] });
      continue;
    }
    if (rawOpen === undefined) {
      const missed = (position.missedExits ?? 0) + 1;
      if (missed < rules.markZeroAfterMissedExits) {
        // Halted or no bar: stays held (marked at its last close), sold at the next open it has.
        held.set(order.securityId, { ...position, missedExits: missed });
        fills.push({ ...base(order), status: "NO_PRICE", ...none, flags: [] });
        continue;
      }
      // markZeroAfterMissedExits misses in a row: $0 from this open on, kept as a STUCK holding. Cash is
      // unchanged; a later price or cash settlement appends a resolution for the actual amount.
      const basis = bars.lastCloseBefore(order.securityId, S) ?? { sessionDate: position.entrySessionDate, close: position.entryOpen };
      held.set(order.securityId, { ...position, missedExits: missed, stuckSince: S, stuckBasisSessionDate: basis.sessionDate, stuckBasisClose: basis.close });
      fills.push({ ...base(order), status: "MARKED_ZERO", ...none, qty: position.qty, fillPrice: 0, entrySessionDate: position.entrySessionDate, flags: ["STUCK_AT_ZERO"] });
      continue;
    }
    // Exit at the actual open (split-adjusted by the records known now; later records append a correction).
    const rawPrice = rawOpen;
    const split = appliedSplitFactor(splits.get(order.securityId), position.entrySessionDate, S);
    const price = rawPrice / split.factor;
    const fillPrice = sellFillPrice(price, bps);
    const notional = position.qty * fillPrice;
    cash += notional - commission;
    held.delete(order.securityId);
    fills.push({
      ...base(order),
      status: "FILLED",
      qty: position.qty,
      rawOpen,
      rawPrice,
      fillPrice,
      splitFactorApplied: split.factor,
      entrySessionDate: position.entrySessionDate,
      notionalUsd: notional,
      commissionUsd: commission,
      slippageUsd: position.qty * price * (bps / 10_000),
      flags: split.unreconciled ? ["SPLIT_UNRECONCILED"] : [],
    });
  }
  const cashAfterExits = cash;
  let marked = 0;
  for (const position of held.values()) marked += positionMark(position, bars.lastClose(position.securityId, S, true));
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
    positionsAfter: [...held.values()]
      .map((p) => {
        const { recoveryNeedsReview: _old, ...rest } = p;
        const review = p.stuckSince ? input.recoveryReviews?.get(p.securityId) : undefined;
        return review ? { ...rest, recoveryNeedsReview: review } : rest;
      })
      .sort((a, b) => a.securityId.localeCompare(b.securityId)),
    fills,
    ...(input.corrections && input.corrections.applied.length
      ? { correctionsUsd: input.corrections.usd, correctionsApplied: [...input.corrections.applied].sort() }
      : {}),
  };
}

/**
 * Corrections owed on stored exit fills: for each FILLED exit whose split factor (by the
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
    if (fill.side !== "SELL" || fill.status !== "FILLED") continue;
    if (fill.rawPrice === undefined || fill.splitFactorApplied === undefined || !fill.entrySessionDate || fill.fillPrice === undefined) continue;
    const previous = input.latest.get(fill.securityId);
    const previousFactor = previous?.correctedFactor ?? fill.splitFactorApplied;
    const previousFillPrice = previous?.correctedFillPrice ?? fill.fillPrice;
    const now = appliedSplitFactor(input.splits.get(fill.securityId), fill.entrySessionDate, input.fills.sessionDate).factor;
    if (Math.abs(now / previousFactor - 1) <= 1e-9) continue;
    const price = fill.rawPrice / now;
    const correctedFillPrice = sellFillPrice(price, rules.slippageBpsPerSide);
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

/**
 * The resolution of one STUCK holding from data stored now, or undefined when none has shown up: the
 * earliest of (a) the first usable open after its entry session, up to `through` (sold at it with normal
 * slippage, split-adjusted like an exit) and (b) a cash settlement record (settlementCashPerShare)
 * effective after entry and on or before `through` (cash per share, split-adjusted, no slippage). On the
 * same date the settlement wins. Pure.
 */
type StuckResolutionInput = {
  position: PaperPosition;
  clientOrderId: string;
  n: number;
  bars: PaperBars;
  splits: ReadonlyMap<string, SplitEvent[]>;
  settlements: readonly CorporateAction[];
  through: string;
  loaded: LoadedPaperRules;
  now: Date;
};

/** The resolution of a STUCK holding from the data stored now, or undefined (see stuckResolutionCheck). */
export function stuckResolutionFor(input: StuckResolutionInput): PaperStuckResolution | undefined {
  return stuckResolutionCheck(input).resolution;
}

/** The close a $0 mark took away: stored on the position at the mark, else its entry open. */
export function stuckBasis(position: PaperPosition): { sessionDate: string; close: number } {
  return position.stuckBasisSessionDate !== undefined && position.stuckBasisClose !== undefined
    ? { sessionDate: position.stuckBasisSessionDate, close: position.stuckBasisClose }
    : { sessionDate: position.entrySessionDate, close: position.entryOpen };
}

/**
 * Resolution of a STUCK holding (paper, or a universe name through the same call): the earliest of a
 * later usable open and a cash settlement record, up to `through`. Reverse-split guard: a later open
 * more than recoveryGuardMultiple x the basis close (stuckBasis), with no
 * stored split record and no stored corporate action for the name after the basis session and up to
 * that open, is skipped and reported in `needsReview` (the first one); a later sane open, an open
 * covered by a record, or a cash settlement still resolves it.
 */
export function stuckResolutionCheck(input: StuckResolutionInput): { resolution?: PaperStuckResolution; needsReview?: PaperRecoveryReview } {
  const { position, bars, splits, through } = input;
  const { rules, rulesSha256 } = input.loaded;
  if (!position.stuckSince) return {};
  const id = position.securityId;
  const after = position.entrySessionDate;
  const basis = stuckBasis(position);
  const recordBetween = (from: string, upTo: string) =>
    (splits.get(id) ?? []).some((e) => e.effectiveDate > from && e.effectiveDate <= upTo) ||
    input.settlements.some((a) => a.securityId === id && a.effectiveDate > from && a.effectiveDate <= upTo);
  let settlement: { action: CorporateAction; cash: number } | undefined;
  for (const action of input.settlements) {
    if (action.securityId !== id || !(action.effectiveDate > after) || action.effectiveDate > through) continue;
    const cash = settlementCashPerShare(action);
    if (cash === undefined) continue;
    if (!settlement || action.effectiveDate < settlement.action.effectiveDate) settlement = { action, cash };
  }
  let priceDate: string | undefined;
  let needsReview: PaperRecoveryReview | undefined;
  for (const date of bars.openSessions(id)) {
    if (!(date > after) || date > through) continue;
    const raw = bars.open(id, date)!;
    // With any split record in between the price books (below), so the raw open is compared as is.
    const ratio = raw / basis.close;
    if (ratio > rules.recoveryGuardMultiple && !recordBetween(basis.sessionDate, date)) {
      needsReview ??= { sourceSessionDate: date, rawAmount: raw, ratio };
      continue;
    }
    priceDate = date;
    break;
  }
  const common = {
    schemaVersion: "paper-stuck-resolution-v1" as const,
    rulesVersion: rules.rulesVersion,
    rulesSha256,
    sessionDate: position.stuckSince,
    securityId: id,
    clientOrderId: input.clientOrderId,
    n: input.n,
    qty: position.qty,
    recordedAt: input.now.toISOString(),
  };
  if (settlement && (priceDate === undefined || settlement.action.effectiveDate <= priceDate)) {
    const factor = appliedSplitFactor(splits.get(id), after, settlement.action.effectiveDate).factor;
    const perShareUsd = settlement.cash / factor;
    return { resolution: {
      ...common,
      source: "CASH_SETTLEMENT",
      actionId: settlement.action.actionId,
      actionType: settlement.action.actionType,
      effectiveDate: settlement.action.effectiveDate,
      rawAmount: settlement.cash,
      splitFactorApplied: factor,
      perShareUsd,
      cashAdjustmentUsd: position.qty * perShareUsd,
    } };
  }
  if (priceDate === undefined) return needsReview ? { needsReview } : {};
  const rawAmount = bars.open(id, priceDate)!;
  const factor = appliedSplitFactor(splits.get(id), after, priceDate).factor;
  const perShareUsd = sellFillPrice(rawAmount / factor, rules.slippageBpsPerSide);
  return { resolution: {
    ...common,
    source: "PRICE",
    sourceSessionDate: priceDate,
    rawAmount,
    splitFactorApplied: factor,
    perShareUsd,
    cashAdjustmentUsd: position.qty * perShareUsd - rules.commissionPerOrderUsd,
  } };
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

type GapRules = Pick<PaperRules, "coverageHoleFraction" | "dropoutSpikeMultiple" | "dropoutSpikeMinNames" | "dropoutFallbackSessions">;

/**
 * Missed sessions for one name up to `to`, shared by paper and the universe. Walking back over eligible
 * sessions until one with an open (`lastOpen`), it counts the covered sessions (PaperBars.covered) with
 * no open; coverage holes are skipped. The run is a data drop-out (`dropout`) when the stored session
 * right after lastOpen is a mass drop-out (PaperBars.dropoutSpike) and the name has no bar there; then
 * its first dropoutFallbackSessions covered sessions do not count. lastOpen is undefined when the walk
 * leaves the loaded bars first (unknown, so never treated as missed).
 */
export function missedSessions(bars: PaperBars, id: string, to: string, rules: GapRules, _calendar = US_EQUITY_MARKET_CALENDAR): { misses: number; lastOpen?: string; dropout?: boolean } {
  // Only stored sessions can have an open or be covered (a session with no bars is a hole), so the walk
  // goes over the stored sessions on or before `to`, newest first.
  const stored = bars.storedSessions();
  let i = stored.length - 1;
  while (i >= 0 && stored[i]! > to) i -= 1;
  let covered = 0;
  for (; i >= 0; i -= 1) {
    const date = stored[i]!;
    if (bars.open(id, date) !== undefined) {
      const start = bars.nextStoredSession(date);
      const dropout = start !== undefined && start <= to && !bars.hasBar(id, start) && bars.dropoutSpike(start, rules);
      if (!dropout) return { misses: covered, lastOpen: date };
      return { misses: Math.max(0, covered - rules.dropoutFallbackSessions), lastOpen: date, dropout: true };
    }
    if (bars.covered(date, rules.coverageHoleFraction)) covered += 1;
  }
  return { misses: covered };
}

/**
 * What a session with no open is for one name: a COVERAGE_HOLE (not counted), a DATA_DROPOUT (inside the
 * fallback window of a mass drop-out; not counted) or a MISS (counts toward the $0 mark). Undefined when
 * the name has an open. One function for paper exits and the universe.
 */
export function missKind(bars: PaperBars, id: string, date: string, rules: GapRules, calendar = US_EQUITY_MARKET_CALENDAR): "COVERAGE_HOLE" | "DATA_DROPOUT" | "MISS" | undefined {
  if (bars.open(id, date) !== undefined) return undefined;
  if (!bars.covered(date, rules.coverageHoleFraction)) return "COVERAGE_HOLE";
  const run = missedSessions(bars, id, date, rules, calendar);
  return run.dropout && run.misses === 0 ? "DATA_DROPOUT" : "MISS";
}

/**
 * The universe's side of the $0 rule, the same trigger as paper: `to` has no open for the name, is a
 * counted miss (missKind), and is exactly its N-th counted miss in a row, after a session with an open.
 */
export function universeStuckAt(bars: PaperBars, id: string, to: string, rules: GapRules & Pick<PaperRules, "markZeroAfterMissedExits">, calendar = US_EQUITY_MARKET_CALENDAR): boolean {
  if (missKind(bars, id, to, rules, calendar) !== "MISS") return false;
  const run = missedSessions(bars, id, to, rules, calendar);
  return run.lastOpen !== undefined && run.misses === rules.markZeroAfterMissedExits;
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
  calendar?: typeof US_EQUITY_MARKET_CALENDAR;
  /** Stored cash settlement records (loadSettlementActions), for universe resolutions. */
  settlements?: readonly CorporateAction[];
  now?: Date;
}): PaperDay {
  const { from, to, bars, splits } = input;
  const calendar = input.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const { rules, rulesSha256 } = input.loaded;
  const spyId = resolveSpyBenchmarkId(input.securities);
  const spy = spyId ? windowReturn(bars, splits, spyId, from.sessionDate, to.sessionDate) ?? null : null;
  const prev = input.previousDay;
  // Equal-weight universe under the same MARK_ZERO_THEN_CORRECT rule as paper. Index level at the
  // window's opening open (1 at the start); a name newly at $0 loses its 1/n slice of it.
  const levelFrom = 1 + (prev?.cumulativeUniverseReturn ?? 0);
  const universe: number[] = [];
  const newlyStuck: { securityId: string; basis: { sessionDate: string; close: number } }[] = [];
  let universeDataDropout = 0;
  for (const security of input.securities) {
    if (security.status !== "ACTIVE" || (security.eligibility !== "LEVEL_2" && security.eligibility !== "LEVEL_3")) continue;
    const id = security.securityId;
    const r = windowReturn(bars, splits, id, from.sessionDate, to.sessionDate);
    if (r !== undefined) {
      universe.push(r);
      continue;
    }
    // Not priced this window: a data gap (left out), or a counted miss that may reach the $0 mark.
    const kind = missKind(bars, id, to.sessionDate, rules, calendar);
    if (kind === "DATA_DROPOUT") universeDataDropout += 1;
    if (kind !== "MISS" || !universeStuckAt(bars, id, to.sessionDate, rules, calendar)) continue;
    const basis = bars.lastCloseBefore(id, to.sessionDate);
    if (!basis) continue;
    universe.push(-1);
    newlyStuck.push({ securityId: id, basis });
  }
  // Resolve earlier universe $0 marks with the same data and the same function as paper
  // (stuckResolutionFor), with no costs: the recovered slice enters this window's return.
  const noCosts: LoadedPaperRules = { ...input.loaded, rules: { ...rules, slippageBpsPerSide: 0, commissionPerOrderUsd: 0 } };
  const stillStuck: PaperUniverseStuck[] = [];
  const resolved: PaperUniverseResolution[] = [];
  let recoveredUnits = 0;
  for (const entry of prev?.universeStuck ?? []) {
    const { resolution, needsReview } = stuckResolutionCheck({
      position: {
        securityId: entry.securityId,
        qty: 1,
        entryOpen: entry.basisClose,
        entryFillPrice: entry.basisClose,
        entrySessionDate: entry.basisSessionDate,
        stuckSince: entry.stuckSince,
        // No stuckBasis fields: the entry fields above are the basis (stuckBasis falls back to them).
      },
      clientOrderId: "universe",
      n: 1,
      bars,
      splits,
      settlements: input.settlements ?? [],
      through: to.sessionDate,
      loaded: noCosts,
      now: input.now ?? new Date(0),
    });
    if (!resolution) {
      const { recoveryNeedsReview: _old, ...rest } = entry;
      stillStuck.push(needsReview ? { ...rest, recoveryNeedsReview: needsReview } : rest);
      continue;
    }
    const units = (entry.units * resolution.perShareUsd) / entry.basisClose;
    recoveredUnits += units;
    resolved.push({
      securityId: entry.securityId,
      stuckSince: entry.stuckSince,
      source: resolution.source,
      ...(resolution.sourceSessionDate ? { sourceSessionDate: resolution.sourceSessionDate } : {}),
      ...(resolution.actionId ? { actionId: resolution.actionId } : {}),
      perShareUsd: resolution.perShareUsd,
      basisClose: entry.basisClose,
      units: entry.units,
      recoveredUnits: units,
    });
  }
  const n = universe.length;
  for (const stuck of newlyStuck)
    stillStuck.push({ securityId: stuck.securityId, stuckSince: to.sessionDate, basisSessionDate: stuck.basis.sessionDate, basisClose: stuck.basis.close, units: levelFrom / n });
  const correctionReturn = recoveredUnits / levelFrom;
  const universeReturn = n ? universe.reduce((sum, r) => sum + r, 0) / n + correctionReturn : resolved.length ? correctionReturn : null;
  const paperReturn = to.equityAtOpen / from.equityAtOpen - 1;
  const paperDataDropout = to.fills.filter((f) => f.flags.includes("DATA_DROPOUT")).length;
  const paperRecoveryNeedsReview = to.positionsAfter.filter((p) => p.recoveryNeedsReview).length;
  const universeRecoveryNeedsReview = stillStuck.filter((e) => e.recoveryNeedsReview).length;
  const cost = (fill: PaperFill) => fill.slippageUsd + fill.commissionUsd;
  const costsUsd =
    from.fills.filter((f) => f.side === "BUY").reduce((sum, f) => sum + cost(f), 0) +
    to.fills.filter((f) => f.side === "SELL").reduce((sum, f) => sum + cost(f), 0);
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
    ...(stillStuck.length ? { universeStuck: stillStuck.sort((a, b) => a.securityId.localeCompare(b.securityId)) } : {}),
    ...(universeDataDropout ? { universeDataDropout } : {}),
    ...(paperDataDropout ? { paperDataDropout } : {}),
    ...(universeRecoveryNeedsReview ? { universeRecoveryNeedsReview } : {}),
    ...(paperRecoveryNeedsReview ? { paperRecoveryNeedsReview } : {}),
    ...(resolved.length ? { universeResolved: resolved.sort((a, b) => a.securityId.localeCompare(b.securityId)), universeCorrectionReturn: correctionReturn } : {}),
    cumulativePaperReturn: compound(prev?.cumulativePaperReturn ?? 0, paperReturn),
    cumulativeSpyReturn: compound(prev?.cumulativeSpyReturn ?? 0, spy),
    cumulativeUniverseReturn: compound(prev?.cumulativeUniverseReturn ?? 0, universeReturn),
    positions: from.positionsAfter.length,
    costsUsd,
    ...(to.correctionsUsd ? { correctionsUsd: to.correctionsUsd } : {}),
    // No entry intents at the window's opening open: the freeze status never arrived before it.
    ...(input.fromIntents
      ? input.fromIntents.entriesRefused
        ? { entriesRefused: input.fromIntents.entriesRefused }
        : {}
      : { entriesRefused: "NO_FREEZE_STATUS" as const }),
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

/**
 * Calendar days of bars loaded before the earliest session a run reads: last closes, N missed sessions,
 * and the COVERAGE_TRAILING_SESSIONS stored sessions before them that define a coverage hole.
 */
export function paperBarsLookbackDays(rules: Pick<PaperRules, "markZeroAfterMissedExits" | "dropoutFallbackSessions">): number {
  // The walk back to a name's last open (up to N counted misses after a drop-out's fallback window),
  // the session before it, and the trailing sessions the hole and drop-out checks compare against.
  return Math.max(21, Math.ceil(((rules.markZeroAfterMissedExits + rules.dropoutFallbackSessions + COVERAGE_TRAILING_SESSIONS + 1) * 7) / 5) + 10);
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
  const exitSessions = await ledger.sessions("exits");
  const fillSessions = await ledger.sessions("fills");
  const daySessions = new Set(await ledger.sessions("days"));
  const filledSet = new Set(fillSessions);
  const lastFilled = fillSessions.at(-1);
  const pending = [...new Set([...intentSessions, ...exitSessions])].filter((s) => !filledSet.has(s)).sort();
  if (lastFilled && pending.some((s) => s < lastFilled)) throw new Error("PAPER_LEDGER_OUT_OF_ORDER");
  const T = nextOpenSession(now, calendar);
  const D = previousEligibleSession(T, calendar);
  if (!D) throw new Error("PAPER_NO_PREVIOUS_SESSION");
  const missingDays = fillSessions.filter((s, i) => i > 0 && !daySessions.has(s));
  const needIntents = !intentSessions.includes(T);
  const needExits = !exitSessions.includes(T);

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

  if (!pending.length && !missingDays.length && !needIntents && !needExits) {
    result.intents = { sessionDate: T, outcome: "KEPT_EXISTING", entries: 0, exits: 0 };
    return result;
  }

  // Bars for every session this run reads, plus enough days before for last-close marks and for the
  // universe's N-sessions-without-a-price check (paperBarsLookbackDays).
  const predecessors = missingDays.map((s) => fillSessions[fillSessions.indexOf(s) - 1]!);
  const dates = [...pending, ...missingDays, ...predecessors, D, ...(lastFilled ? [lastFilled] : [])].sort();
  const bars = new PaperBars(await market.loadBarsBetween(addDays(dates[0]!, -paperBarsLookbackDays(rules)), dates.at(-1)!));
  let securities: SecurityMasterRecord[] | undefined;
  const loadSecurities = async () => (securities ??= await market.loadSecurities());
  let settlementActions: CorporateAction[] | undefined;
  const loadSettlements = async () => (settlementActions ??= (await market.loadSettlementActions?.()) ?? []);

  // (1c) STUCK holdings (marked $0): append the resolution once a later price or a cash settlement is
  // stored. The MARKED_ZERO fill is never rewritten; the cash enters at the next open that is filled.
  const stuck = lastFilled ? (await readFills(lastFilled)).positionsAfter.filter((p) => p.stuckSince) : [];
  const recoveryReviews = new Map<string, PaperRecoveryReview>();
  if (stuck.length) {
    const settlements = await loadSettlements();
    for (const position of stuck) {
      const own = correctionKeys.map(parsePaperCorrectionKey).filter((k) => k && k.sessionDate === position.stuckSince && k.securityId === position.securityId);
      let resolvedAlready = false;
      for (const k of own) {
        const stored = await ledger.read<{ schemaVersion: string }>(paperCorrectionKey(k!.sessionDate, k!.securityId, k!.n));
        if (stored?.schemaVersion === "paper-stuck-resolution-v1") resolvedAlready = true;
      }
      if (resolvedAlready) continue;
      const markedZero = (await readFills(position.stuckSince!)).fills.find((f) => f.securityId === position.securityId && f.status === "MARKED_ZERO");
      if (!markedZero) throw new Error("PAPER_LEDGER_STUCK_FILL_MISSING");
      const n = own.reduce((max, k) => Math.max(max, k!.n), 0) + 1;
      const { resolution, needsReview } = stuckResolutionCheck({ position, clientOrderId: markedZero.clientOrderId, n, bars, splits, settlements, through: pending[0] ?? D, loaded, now });
      if (needsReview) recoveryReviews.set(position.securityId, needsReview);
      if (!resolution) continue;
      const key = paperCorrectionKey(position.stuckSince!, position.securityId, n);
      await ledger.putOnce(key, resolution);
      correctionKeys.push(key);
      (result.corrections ??= []).push(key);
    }
  }

  // (2) Fill pending intents, oldest first; stop at the first session whose bars are not stored yet.
  let state: BookState = lastFilled
    ? { cash: (await readFills(lastFilled)).cashAfter, positions: (await readFills(lastFilled)).positionsAfter }
    : { cash: rules.startingCapitalUsd, positions: [] };
  const allFilled = [...fillSessions];
  for (const S of pending) {
    if (!bars.hasSession(S)) break;
    const entries = intentSessions.includes(S) ? await ledger.read<PaperIntents>(paperLedgerKey("intents", S)) : undefined;
    const exits = exitSessions.includes(S) ? await ledger.read<PaperExits>(paperLedgerKey("exits", S)) : undefined;
    if (!entries && !exits) throw new Error("PAPER_LEDGER_INTENTS_MISSING");
    // Exits and entries for S's open, filled together (exits first).
    const intents: PaperIntents = {
      ...(entries ?? { schemaVersion: "paper-intents-v1", rulesVersion: rules.rulesVersion, rulesSha256, sessionDate: S, freezeSessionDate: "", recordedAt: "", sessionOpen: "" }),
      orders: [...(exits?.orders ?? []), ...(entries?.orders ?? [])],
    };
    // Corrections not yet in cash enter it at this open.
    const applied = new Set((allFilled.length ? (await readFills(allFilled.at(-1)!)).correctionsApplied : undefined) ?? []);
    let usd = 0;
    const resolved: PaperStuckResolution[] = [];
    for (const key of correctionKeys.filter((k) => !applied.has(k)).sort()) {
      const correction = (await ledger.read<PaperCorrection | PaperStuckResolution>(key))!;
      usd += correction.cashAdjustmentUsd;
      if (correction.schemaVersion === "paper-stuck-resolution-v1") resolved.push(correction);
      applied.add(key);
    }
    const fills = computeFills({ intents, prior: state, bars, splits, loaded, corrections: { usd, applied: [...applied] }, resolved, calendar, recoveryReviews });
    if ((await ledger.putOnce(paperLedgerKey("fills", S), fills)) === "KEPT_EXISTING") {
      // A concurrent or earlier write won: continue from what is stored.
      fillsCache.delete(S);
    } else fillsCache.set(S, fills);
    const stored = await readFills(S);
    state = { cash: stored.cashAfter, positions: stored.positionsAfter };
    allFilled.push(S);
    result.filled.push(S);
  }
  result.pendingFills = pending.filter((s) => s < T).length - result.filled.length;

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
      calendar,
      settlements: await loadSettlements(),
      now,
    });
    await ledger.putOnce(paperLedgerKey("days", S), day);
    previousDay = (await ledger.read<PaperDay>(paperLedgerKey("days", S)))!;
    result.days.push(S);
  }

  // (4) Orders for the next open, written only before it: exits whenever anything is held (whatever
  // the freeze), then entries once the freeze status of D is stored.
  const sessionOpen = etWallClockToUtc(T, 9, 30);
  if (!needIntents && !needExits) {
    result.intents = { sessionDate: T, outcome: "KEPT_EXISTING", entries: 0, exits: 0 };
    return result;
  }
  if (!(now.getTime() < sessionOpen.getTime())) {
    result.intents = { sessionDate: T, outcome: "TOO_LATE", entries: 0, exits: 0 };
    return result;
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
  // Sessions before T still waiting for their fills (T's own exits, if already written, are not).
  const stillPending = pending.filter((s) => s < T && !result.filled.includes(s));
  // STUCK holdings get no exit orders: they stay at $0 until a resolution shows up.
  const holdings = new Set(state.positions.filter((p) => !p.stuckSince).map((p) => p.securityId));
  for (const s of stillPending) {
    const intents = intentSessions.includes(s) ? await ledger.read<PaperIntents>(paperLedgerKey("intents", s)) : undefined;
    for (const o of intents?.orders ?? []) if (o.side === "BUY") holdings.add(o.securityId);
  }
  let exitsWritten = 0;
  if (needExits && holdings.size) {
    const exits: PaperExits = {
      schemaVersion: "paper-exits-v1",
      ...stamp,
      sessionDate: T,
      recordedAt: now.toISOString(),
      sessionOpen: sessionOpen.toISOString(),
      orders: [...holdings].sort().map((id) => order(id, "SELL")),
    };
    await ledger.putOnce(paperLedgerKey("exits", T), exits);
    exitsWritten = holdings.size;
  }
  if (!needIntents) {
    result.intents = { sessionDate: T, outcome: "KEPT_EXISTING", entries: 0, exits: exitsWritten };
    return result;
  }
  const statuses = await market.loadPredictionStatuses(D);
  if (!statuses.some((status) => status.sessionDate === D)) {
    result.intents = { sessionDate: T, outcome: "DEFERRED_NO_FREEZE_STATUS", entries: 0, exits: exitsWritten };
    return result;
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
        for (const p of lastFills.positionsAfter) mark += positionMark(p, bars.lastClose(p.securityId, D, false));
        if (dailyLossBreached(lastFills.equityAtOpen, mark, rules.dailyLossLimitFraction)) refused = "DAILY_LOSS_LIMIT";
      }
      if (!refused) picks = proof.securityIds;
    }
  }
  const orders = picks.map((id) => order(id, "BUY"));
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
    exits: exitsWritten,
    ...(refused ? { entriesRefused: refused } : {}),
  };
  return result;
}
