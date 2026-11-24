/**
 * Statistics for the research harness: one-sided t-tests on daily series, Holm's step-down
 * correction across every variant ever tried, and per-series metrics.
 *
 * The t-test runs on the portfolio's DAILY series (one number per session), not on individual
 * picks, so names that move together are not counted as independent evidence.
 */
import type { DailyResult } from "./research-costs";

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

export function tStat(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** One-sided p = P(T >= t) for Student's t with df degrees of freedom. */
export function tUpperP(t: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(t)) return t === Infinity ? 0 : 1;
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? tail : 1 - tail;
}

/** One-sided test that the mean of xs is > 0. */
export function oneSidedTest(xs: readonly number[]): { sessions: number; mean: number; t: number; p: number } {
  const t = tStat(xs);
  return { sessions: xs.length, mean: mean(xs), t, p: xs.length >= 2 ? tUpperP(t, xs.length - 1) : 1 };
}

/**
 * Holm step-down adjusted p-values for `ps`, in input order, for a family of `m` tests
 * (m >= ps.length; tests whose p-value is not given count as p = 1, which makes the
 * correction no weaker than Bonferroni with m for the smallest p).
 */
export function holmAdjusted(ps: readonly number[], m = ps.length): number[] {
  if (m < ps.length) throw new Error("HOLM_FAMILY_TOO_SMALL");
  const order = ps.map((p, k) => [p, k] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ps.length);
  let running = 0;
  for (const [rank, [p, k]] of order.entries()) {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[k] = running;
  }
  return out;
}

export interface SeriesMetrics {
  sessions: number;
  meanGross: number;
  meanNet: number;
  meanCost: number;
  meanTurnover: number;
  meanUniverse: number;
  meanSpy: number | null;
  /** Net minus the equal-weight universe, per session. */
  excessUniverse: { sessions: number; mean: number; t: number; p: number };
  /** Net minus SPY, on sessions with a SPY outcome. */
  excessSpy: { sessions: number; mean: number; t: number; p: number };
  /** Annualized (sqrt 252) Sharpe of the net series (no risk-free rate). */
  sharpeNet: number;
}

export function seriesMetrics(daily: readonly DailyResult[]): SeriesMetrics {
  const net = daily.map((d) => d.net);
  const withSpy = daily.filter((d) => d.spy !== undefined);
  const sdNet = Math.sqrt(net.reduce((s, v) => s + (v - mean(net)) ** 2, 0) / Math.max(1, net.length - 1));
  return {
    sessions: daily.length,
    meanGross: mean(daily.map((d) => d.gross)),
    meanNet: mean(net),
    meanCost: mean(daily.map((d) => d.cost)),
    meanTurnover: mean(daily.map((d) => d.turnover)),
    meanUniverse: mean(daily.map((d) => d.universe)),
    meanSpy: withSpy.length ? mean(withSpy.map((d) => d.spy!)) : null,
    excessUniverse: oneSidedTest(daily.map((d) => d.net - d.universe)),
    excessSpy: oneSidedTest(withSpy.map((d) => d.net - d.spy!)),
    sharpeNet: sdNet > 0 ? (mean(net) / sdNet) * Math.sqrt(252) : 0,
  };
}
