/**
 * Held-out evaluation of the scanner's pick lists on stored daily bars (no network, no writes).
 *
 * For each evaluated session D it rebuilds exactly what a forward scan at D would have seen:
 * bars with sessionDate <= D inside the scan's own bar window (scanBarWindowStart), securities
 * point in time (ACTIVE = has a bar on D, eligibility from the bar count up to D, never the
 * all-time count), then runs the production rankSecurities. Outcomes use only later sessions:
 * entry at the next session's open (picks freeze before that open), exit at the close h sessions
 * after D. Baselines on the same names and sessions: the equal-weight average of every ranked
 * name with an outcome ("universe"), random lists of the same size from that universe, and SPY.
 */
import type { CanonicalDailyBar, CorporateAction, PredictionSet, SecurityMasterRecord } from "./contracts";
import { ELIGIBILITY_FLOOR, type EligibilityFloor } from "./eligibility-floor";
import { DEFAULT_SCANNER_CONFIG, rankSecurities } from "./ranking";
import { resolveSpyBenchmarkId, scanBarWindowStart, type SessionCalendar } from "./scanner";
import { nextSessionOpen } from "./session-open";
import { eligibilityForBarCount } from "./universe";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export interface EvalBar {
  securityId: string;
  sessionDate: string;
  open: number;
  close: number;
  volume: number;
  revision: number;
}

/** Price history indexed for point-in-time reads. Bars must already be one per security and session. */
export class EvalHistory {
  readonly sessions: string[];
  private readonly byDate = new Map<string, EvalBar[]>();
  private readonly bySecurity = new Map<string, Map<string, EvalBar>>();
  private readonly firstIndex = new Map<string, number>();

  constructor(bars: Iterable<EvalBar>, minBarsPerSession = 1) {
    for (const bar of bars) {
      let day = this.byDate.get(bar.sessionDate);
      if (!day) this.byDate.set(bar.sessionDate, (day = []));
      day.push(bar);
      let own = this.bySecurity.get(bar.securityId);
      if (!own) this.bySecurity.set(bar.securityId, (own = new Map()));
      own.set(bar.sessionDate, bar);
    }
    this.sessions = [...this.byDate.keys()].filter((d) => this.byDate.get(d)!.length >= minBarsPerSession).sort();
    const index = new Map(this.sessions.map((d, i) => [d, i]));
    for (const [id, own] of this.bySecurity) {
      let first = Infinity;
      for (const d of own.keys()) first = Math.min(first, index.get(d) ?? Infinity);
      this.firstIndex.set(id, first);
    }
  }

  barsOn(date: string): EvalBar[] {
    return this.byDate.get(date) ?? [];
  }

  bar(securityId: string, date: string): EvalBar | undefined {
    return this.bySecurity.get(securityId)?.get(date);
  }

  /** Stored sessions with a bar for the security up to and including session index i. */
  barCountUpTo(securityId: string, i: number): number {
    const own = this.bySecurity.get(securityId);
    if (!own) return 0;
    let n = 0;
    for (const d of own.keys()) if (d <= this.sessions[i]!) n += 1;
    return n;
  }
}

/** Securities as a scan at D would have known them; nothing after D is used. */
export function pointInTimeSecurities(
  master: readonly SecurityMasterRecord[],
  history: EvalHistory,
  i: number,
): SecurityMasterRecord[] {
  const D = history.sessions[i]!;
  return master.map((security) => {
    const active = history.bar(security.securityId, D) !== undefined;
    const count = history.barCountUpTo(security.securityId, i);
    return {
      ...security,
      status: active ? "ACTIVE" : "INACTIVE",
      barCount: count,
      eligibility: eligibilityForBarCount(count),
    } as SecurityMasterRecord;
  });
}

/** The bars a forward scan at session index i would load: its own window, nothing after D. */
export function scanInputBars(history: EvalHistory, i: number, calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): CanonicalDailyBar[] {
  const D = history.sessions[i]!;
  const start = scanBarWindowStart(D, calendar);
  const out: CanonicalDailyBar[] = [];
  for (let k = i; k >= 0 && history.sessions[k]! >= start; k -= 1)
    for (const bar of history.barsOn(history.sessions[k]!)) out.push(bar as unknown as CanonicalDailyBar);
  return out;
}

/** Next-open to close h sessions after D (h >= 1). Undefined when either bar is missing or invalid. */
export function forwardReturn(history: EvalHistory, securityId: string, i: number, h: number): number | undefined {
  const entryDate = history.sessions[i + 1];
  const exitDate = history.sessions[i + h];
  if (!entryDate || !exitDate) return undefined;
  const entry = history.bar(securityId, entryDate);
  const exit = history.bar(securityId, exitDate);
  if (!entry || !exit || !(entry.open > 0) || !(exit.close > 0)) return undefined;
  return exit.close / entry.open - 1;
}

export interface SessionOutcome {
  sessionDate: string;
  universeSize: number;
  universeMean: number;
  spy?: number;
  /** Spearman rank correlation of overallScore with the forward return over the universe. */
  ic: number;
  lists: Record<string, { size: number; mean: number; random: number[] }>;
}

export interface EvalOptions {
  horizon: number;
  randomDraws: number;
  seed: number;
  /** Ids to drop from outcomes for this session (e.g. a known split inside the window). */
  excluded?: (securityId: string, i: number, h: number) => boolean;
  /** Clip every return to the universe's [p, 1-p] quantiles of that session (same for picks and baselines). */
  winsorize?: number;
  calendar?: SessionCalendar;
  /** Stored split records, passed to rankSecurities as the scan does (only those effective <= D are used). */
  splitActions?: readonly CorporateAction[];
  /**
   * "effective-date" (default): every split record is used from its effective date on, even if it was
   * recorded later (look-ahead on knowledge time). "as-known": only records whose observedAt is before
   * the next session's 09:30 ET open, i.e. what a forward scan of D could have read.
   */
  splitKnowledge?: "effective-date" | "as-known";
  /** The eligibility floor, as the scan applies it (default); null ranks without it (comparison only). */
  floor?: EligibilityFloor | null;
}

/** Split records a forward scan of D could have read: observed before the next session's open. */
export function splitActionsKnownAt(
  actions: readonly CorporateAction[],
  sessionDate: string,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): CorporateAction[] {
  const open = nextSessionOpen(sessionDate, calendar)?.nextSessionOpen.getTime();
  if (open === undefined) return [];
  return actions.filter((a) => {
    const seen = Date.parse(a.observedAt ?? "");
    return Number.isFinite(seen) && seen < open;
  });
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((v, k) => [v, k] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let k = 0; k < order.length; ) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]![0] === order[k]![0]) j += 1;
    for (let m = k; m <= j; m += 1) out[order[m]![1]] = (k + j) / 2;
    k = j + 1;
  }
  return out;
}

export function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length < 3) return 0;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (ra.length - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < ra.length; k += 1) {
    num += (ra[k]! - mean) * (rb[k]! - mean);
    da += (ra[k]! - mean) ** 2;
    db += (rb[k]! - mean) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Rank as a forward scan at session index i would, then score every list on later sessions only. */
export function evaluateSession(
  master: readonly SecurityMasterRecord[],
  history: EvalHistory,
  i: number,
  options: EvalOptions,
): { predictions: PredictionSet[]; excluded: number; floorExcluded: number; outcome: SessionOutcome } | undefined {
  const D = history.sessions[i]!;
  if (!history.sessions[i + options.horizon]) return undefined;
  const securities = pointInTimeSecurities(master, history, i);
  const bars = scanInputBars(history, i, options.calendar);
  const spyId = resolveSpyBenchmarkId(securities);
  const benchmark = spyId ? bars.filter((bar) => bar.securityId === spyId) : [];
  const splitActions =
    options.splitKnowledge === "as-known"
      ? splitActionsKnownAt(options.splitActions ?? [], D, options.calendar)
      : (options.splitActions ?? []);
  const result = rankSecurities(securities, bars, benchmark, D, DEFAULT_SCANNER_CONFIG, splitActions, options.floor === undefined ? ELIGIBILITY_FLOOR : options.floor);
  const h = options.horizon;
  const raw = new Map<string, number>();
  for (const item of result.ranked) {
    if (options.excluded?.(item.securityId, i, h)) continue;
    const r = forwardReturn(history, item.securityId, i, h);
    if (r !== undefined) raw.set(item.securityId, r);
  }
  const values = [...raw.values()].sort((a, b) => a - b);
  if (!values.length) return undefined;
  const lo = options.winsorize ? quantile(values, options.winsorize) : -Infinity;
  const hi = options.winsorize ? quantile(values, 1 - options.winsorize) : Infinity;
  const ret = new Map([...raw].map(([id, r]) => [id, Math.min(hi, Math.max(lo, r))]));
  const universe = [...ret.values()];
  const universeMean = universe.reduce((s, v) => s + v, 0) / universe.length;
  const scored = result.ranked.filter((item) => ret.has(item.securityId));
  const ic = spearman(scored.map((item) => item.overallScore), scored.map((item) => ret.get(item.securityId)!));
  const draw = rng(options.seed ^ (i * 2654435761));
  const lists: SessionOutcome["lists"] = {};
  for (const set of result.predictions) {
    const got = set.securityIds.filter((id) => ret.has(id)).map((id) => ret.get(id)!);
    if (!got.length) continue;
    const random: number[] = [];
    for (let k = 0; k < options.randomDraws; k += 1) {
      // Partial Fisher-Yates over the universe for a same-size random list.
      const pool = universe.slice();
      let sum = 0;
      for (let m = 0; m < got.length; m += 1) {
        const j = m + Math.floor(draw() * (pool.length - m));
        [pool[m], pool[j]] = [pool[j]!, pool[m]!];
        sum += pool[m]!;
      }
      random.push(sum / got.length);
    }
    lists[set.setType] = { size: got.length, mean: got.reduce((s, v) => s + v, 0) / got.length, random };
  }
  const spy = spyId ? forwardReturn(history, spyId, i, h) : undefined;
  return {
    predictions: result.predictions,
    excluded: result.excluded?.length ?? 0,
    floorExcluded: result.floorExcluded?.length ?? 0,
    outcome: { sessionDate: D, universeSize: universe.length, universeMean, ...(spy !== undefined ? { spy } : {}), ic, lists },
  };
}

export interface ListSummary {
  sessions: number;
  meanReturn: number;
  universeMean: number;
  meanExcess: number;
  excessTStat: number;
  hitRate: number;
  /** Share of random-list draws whose average over all sessions is >= the list's (one-sided p). */
  randomP: number;
  randomMean: number;
  spyMean?: number;
}

/** Aggregate per-session outcomes; `step` keeps every step-th session (non-overlapping for h > 1). */
export function summarize(outcomes: readonly SessionOutcome[], step = 1): { lists: Record<string, ListSummary>; meanIC: number; icTStat: number; sessions: number } {
  const kept = outcomes.filter((_, k) => k % step === 0);
  const types = [...new Set(kept.flatMap((o) => Object.keys(o.lists)))].sort();
  const t = (xs: number[]) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
    return { m, t: sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0 };
  };
  const lists: Record<string, ListSummary> = {};
  for (const type of types) {
    const rows = kept.filter((o) => o.lists[type]);
    const excess = rows.map((o) => o.lists[type]!.mean - o.universeMean);
    const draws = rows[0]!.lists[type]!.random.length;
    const observed = rows.reduce((s, o) => s + o.lists[type]!.mean, 0) / rows.length;
    let atLeast = 0;
    let randomSum = 0;
    for (let k = 0; k < draws; k += 1) {
      const avg = rows.reduce((s, o) => s + o.lists[type]!.random[k]!, 0) / rows.length;
      randomSum += avg;
      if (avg >= observed) atLeast += 1;
    }
    const spyRows = rows.filter((o) => o.spy !== undefined);
    const ex = t(excess);
    lists[type] = {
      sessions: rows.length,
      meanReturn: observed,
      universeMean: rows.reduce((s, o) => s + o.universeMean, 0) / rows.length,
      meanExcess: ex.m,
      excessTStat: ex.t,
      hitRate: excess.filter((e) => e > 0).length / rows.length,
      randomP: draws ? (atLeast + 1) / (draws + 1) : 1,
      randomMean: draws ? randomSum / draws : 0,
      ...(spyRows.length ? { spyMean: spyRows.reduce((s, o) => s + o.spy!, 0) / spyRows.length } : {}),
    };
  }
  const ic = t(kept.map((o) => o.ic));
  return { lists, meanIC: ic.m, icTStat: ic.t, sessions: kept.length };
}
