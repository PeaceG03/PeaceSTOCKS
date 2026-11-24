/**
 * Variant evaluation and the variant log.
 *
 * A strategy is a list of candidate configurations. In each walk-forward fold the candidate with the
 * highest train-window mean net excess over the equal-weight universe is chosen (ties: the first),
 * and only that choice is scored on the fold's test window. Every evaluation appends one record to
 * the append-only variant log: the strategy hash, every candidate hash, each fold's dates, choice
 * and test metrics, the pooled test metrics and the pooled p-value. Every result reports how many
 * distinct variants the log holds and the Holm-adjusted pooled p-value over all of them.
 */
import { AppendOnlyLog, configHash } from "./append-only-log";
import { simulateList, type CostConfig, type DailyResult, type HarnessSession } from "./research-costs";
import type { Fold, FoldConfig } from "./research-folds";
import { holmAdjusted, mean, seriesMetrics, type SeriesMetrics } from "./research-stats";

export interface CandidateConfig {
  kind: "scanner-list";
  list: string;
  topN?: number;
  /** Scanner/ranking code the lists came from (part of the hash: new code = new variant). */
  scanner: string;
}

export interface StrategyConfig {
  name: string;
  candidates: CandidateConfig[];
  costs: CostConfig;
  folds: FoldConfig;
  /** How outcomes are measured; part of the hash. */
  outcome: "open-to-next-open";
  splits: "as-known";
}

export interface FoldResult {
  index: number;
  train: { from: string; to: string };
  testWindow: { from: string; to: string };
  /** Hash of the candidate chosen on the train window. */
  chosen: string;
  trainScore: number;
  test: SeriesMetrics;
  positive: boolean;
}

export interface VariantRecord {
  strategyHash: string;
  name: string;
  candidateHashes: string[];
  folds: FoldResult[];
  pooled: SeriesMetrics;
  /** max(p vs universe, p vs SPY): both must hold (intersection-union test). */
  pooledP: number;
}

export interface StrategyEvaluation {
  record: VariantRecord;
  daily: DailyResult[];
  /** Distinct variants (candidate hashes) in the log after this record. */
  variantsTried: number;
  /** Holm-adjusted pooledP over the latest record of every strategy in the log. */
  adjustedP: number;
  foldsPositive: number;
}

/** A fold counts as positive when net beats both benchmarks on its test window. */
export const foldPositive = (m: SeriesMetrics): boolean => m.excessUniverse.mean > 0 && m.excessSpy.mean > 0;

export function evaluateStrategy(
  sessions: readonly HarnessSession[],
  folds: readonly Fold[],
  strategy: StrategyConfig,
  log: AppendOnlyLog<VariantRecord>,
): StrategyEvaluation {
  if (!strategy.candidates.length) throw new Error("STRATEGY_HAS_NO_CANDIDATES");
  const candidateHashes = strategy.candidates.map((c) => configHash(c));
  const date = (i: number) => sessions[i]!.sessionDate;
  const results: FoldResult[] = [];
  const daily: DailyResult[] = [];
  for (const fold of folds) {
    let best = 0;
    let bestScore = -Infinity;
    for (const [k, candidate] of strategy.candidates.entries()) {
      const train = simulateList(sessions, fold.train, candidate.list, strategy.costs, candidate.topN);
      const score = mean(train.map((d) => d.net - d.universe));
      if (score > bestScore) [best, bestScore] = [k, score];
    }
    const chosen = strategy.candidates[best]!;
    const test = simulateList(sessions, fold.test, chosen.list, strategy.costs, chosen.topN);
    daily.push(...test);
    const metrics = seriesMetrics(test);
    results.push({
      index: fold.index,
      train: { from: date(fold.train.start), to: date(fold.train.end) },
      testWindow: { from: date(fold.test.start), to: date(fold.test.end) },
      chosen: candidateHashes[best]!,
      trainScore: bestScore,
      test: metrics,
      positive: foldPositive(metrics),
    });
  }
  const pooled = seriesMetrics(daily);
  const record: VariantRecord = {
    strategyHash: configHash(strategy),
    name: strategy.name,
    candidateHashes,
    folds: results,
    pooled,
    pooledP: Math.max(pooled.excessUniverse.p, pooled.excessSpy.p),
  };
  log.append(record);
  const all = log.entries();
  const latest = new Map<string, VariantRecord>();
  for (const entry of all) latest.set(entry.strategyHash, entry);
  const variantsTried = new Set(all.flatMap((e) => e.candidateHashes)).size;
  const strategies = [...latest.values()];
  const adjusted = holmAdjusted(strategies.map((s) => s.pooledP), Math.max(variantsTried, strategies.length));
  const adjustedP = adjusted[strategies.findIndex((s) => s.strategyHash === record.strategyHash)]!;
  return { record, daily, variantsTried, adjustedP, foldsPositive: results.filter((r) => r.positive).length };
}
