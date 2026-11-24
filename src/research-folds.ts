/**
 * Walk-forward folds and the sealed held-out period for the research harness.
 *
 * Sessions are indexes into the harness's ordered session list. A session D's outcome is the
 * open(D+1) -> open(D+2) return (picks freeze before the D+1 open), so it reads prices up to D+2.
 * Rules (assertFoldOrder):
 *  - each fold's test window starts after its train window ends plus an embargo of >= 1 session
 *    (test start > train end + 1), so nothing a parameter was chosen on overlaps a test outcome;
 *  - test windows are in order and do not overlap;
 *  - every train and test outcome ends before the held-out period (index + 2 < heldOutStart), so
 *    no development result reads a held-out price.
 * The held-out period is evaluated at most once per registered strategy (HeldOutSeal).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppendOnlyLog, configHash } from "./append-only-log";

export interface SessionRange {
  /** First session index (inclusive). */
  start: number;
  /** Last session index (inclusive). */
  end: number;
}

export interface Fold {
  index: number;
  train: SessionRange;
  test: SessionRange;
}

export interface FoldConfig {
  trainSessions: number;
  testSessions: number;
  /** Sessions skipped between a train window's end and its test window's start (>= 1). */
  embargoSessions: number;
  /** "rolling": fixed-length train windows; "expanding": train always starts at the first session. */
  mode: "rolling" | "expanding";
}

/** Session outcomes read prices this many sessions after D (open of D+2). */
export const OUTCOME_LAG_SESSIONS = 2;

export const FOLD_ORDER_INVALID = "FOLD_ORDER_INVALID";

/** Folds over development sessions [0, heldOutStart): each test window follows its train window. */
export function walkForwardFolds(heldOutStart: number, config: FoldConfig): Fold[] {
  const { trainSessions, testSessions, embargoSessions } = config;
  if (!(trainSessions >= 1 && testSessions >= 1 && embargoSessions >= 1) || ![trainSessions, testSessions, embargoSessions].every(Number.isInteger))
    throw new Error(`${FOLD_ORDER_INVALID}:config`);
  const lastUsable = heldOutStart - 1 - OUTCOME_LAG_SESSIONS;
  const folds: Fold[] = [];
  for (let testStart = trainSessions + embargoSessions; testStart <= lastUsable; testStart += testSessions) {
    const testEnd = Math.min(testStart + testSessions - 1, lastUsable);
    // A trailing fold shorter than half a test window is dropped (too few sessions to judge).
    if (testEnd - testStart + 1 < testSessions / 2) break;
    const trainEnd = testStart - embargoSessions - 1;
    const trainStart = config.mode === "expanding" ? 0 : trainEnd - trainSessions + 1;
    folds.push({ index: folds.length, train: { start: trainStart, end: trainEnd }, test: { start: testStart, end: testEnd } });
  }
  assertFoldOrder(folds, heldOutStart);
  return folds;
}

export function assertFoldOrder(folds: readonly Fold[], heldOutStart: number): void {
  if (!folds.length) throw new Error(`${FOLD_ORDER_INVALID}:no-folds`);
  let previousTestEnd = -1;
  for (const fold of folds) {
    const { train, test } = fold;
    const fail = (why: string) => {
      throw new Error(`${FOLD_ORDER_INVALID}:fold-${fold.index}:${why}`);
    };
    if (!(train.start >= 0 && train.start <= train.end)) fail("train-range");
    if (!(test.start <= test.end)) fail("test-range");
    if (!(test.start > train.end + 1)) fail("test-not-after-train");
    if (!(test.start > previousTestEnd)) fail("test-overlap");
    if (!(test.end + OUTCOME_LAG_SESSIONS < heldOutStart)) fail("reads-held-out");
    previousTestEnd = test.end;
  }
}

// ---------------------------------------------------------------------------------------------
// Held-out seal

export type SealEntry =
  | { type: "REGISTER"; strategyHash: string; config: unknown; window: { from: string; to: string }; windowHash: string }
  | { type: "EVALUATE"; strategyHash: string; windowHash: string; evaluation: number }
  | { type: "RESULT"; strategyHash: string; evaluation: number; resultHash: string; result: unknown }
  | { type: "UNSEAL"; strategyHash: string; by: string; reason: string };

export const HELD_OUT_SEALED = "HELD_OUT_SEALED";
export const HELD_OUT_NOT_REGISTERED = "HELD_OUT_NOT_REGISTERED";
export const HELD_OUT_WINDOW_CHANGED = "HELD_OUT_WINDOW_CHANGED";

/**
 * One look at the held-out period per registered strategy. The log (append-only, hash chained) holds
 * REGISTER / EVALUATE / RESULT / UNSEAL records; each evaluation also creates a marker file with the
 * exclusive-create flag, so removing log lines does not reopen the period. Evaluation n (0-based) is
 * allowed only when n <= the number of recorded human unseals, and its marker does not exist yet.
 */
export class HeldOutSeal {
  private readonly log: AppendOnlyLog<SealEntry>;

  constructor(
    readonly path: string,
    now?: () => string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.log = new AppendOnlyLog<SealEntry>(path, now);
  }

  private markerPath(strategyHash: string, evaluation: number): string {
    return join(dirname(this.path), "heldout-markers", `${strategyHash}.${evaluation}.json`);
  }

  register(config: unknown, window: { from: string; to: string }): string {
    const strategyHash = configHash(config);
    const windowHash = configHash(window);
    const prior = this.log.entries().find((e) => e.type === "REGISTER" && e.strategyHash === strategyHash);
    if (prior) {
      if (prior.type === "REGISTER" && prior.windowHash !== windowHash) throw new Error(`${HELD_OUT_WINDOW_CHANGED}:${strategyHash}`);
      return strategyHash;
    }
    this.log.append({ type: "REGISTER", strategyHash, config, window, windowHash });
    return strategyHash;
  }

  /** Evaluations recorded so far and unseals granted, for a strategy. */
  status(strategyHash: string): { registered: boolean; evaluations: number; unseals: number } {
    const entries = this.log.entries().filter((e) => e.strategyHash === strategyHash);
    return {
      registered: entries.some((e) => e.type === "REGISTER"),
      evaluations: entries.filter((e) => e.type === "EVALUATE").length,
      unseals: entries.filter((e) => e.type === "UNSEAL").length,
    };
  }

  /**
   * Runs `evaluate` on the held-out window once. The EVALUATE record and the marker are written
   * BEFORE it runs, so a crash or an exception still uses up the look.
   */
  evaluateOnce<R>(strategyHash: string, window: { from: string; to: string }, evaluate: () => R): R {
    const entries = this.log.entries();
    const registered = entries.find((e) => e.type === "REGISTER" && e.strategyHash === strategyHash);
    if (!registered || registered.type !== "REGISTER") throw new Error(`${HELD_OUT_NOT_REGISTERED}:${strategyHash}`);
    const windowHash = configHash(window);
    if (registered.windowHash !== windowHash) throw new Error(`${HELD_OUT_WINDOW_CHANGED}:${strategyHash}`);
    const { evaluations, unseals } = this.status(strategyHash);
    const evaluation = evaluations;
    if (evaluation > unseals) throw new Error(`${HELD_OUT_SEALED}:${strategyHash}:evaluations=${evaluations}:unseals=${unseals}`);
    const marker = this.markerPath(strategyHash, evaluation);
    mkdirSync(dirname(marker), { recursive: true });
    if (existsSync(marker)) throw new Error(`${HELD_OUT_SEALED}:${strategyHash}:marker-${evaluation}`);
    writeFileSync(marker, `${JSON.stringify({ strategyHash, evaluation, windowHash })}\n`, { flag: "wx" });
    this.log.append({ type: "EVALUATE", strategyHash, windowHash, evaluation });
    const result = evaluate();
    this.log.append({ type: "RESULT", strategyHash, evaluation, resultHash: configHash(result), result });
    return result;
  }

  /** A human's recorded decision to allow one more look (CLI: research-harness-cli unseal, TTY only). */
  unseal(strategyHash: string, by: string, reason: string): void {
    if (!by.trim() || !reason.trim()) throw new Error("HELD_OUT_UNSEAL_NEEDS_BY_AND_REASON");
    if (!this.status(strategyHash).registered) throw new Error(`${HELD_OUT_NOT_REGISTERED}:${strategyHash}`);
    this.log.append({ type: "UNSEAL", strategyHash, by: by.trim(), reason: reason.trim() });
  }
}
