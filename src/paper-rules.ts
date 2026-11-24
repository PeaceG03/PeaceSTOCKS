/**
 * Pre-registered paper-trading rules (docs/PAPER_TRADING.md). The rules live in a versioned file,
 * config/paper-rules-<version>.json, committed before any paper result exists. Changing a rule means a
 * NEW file with a new rulesVersion, never an edit: every ledger row records the version and the sha256
 * of the exact file bytes, so a result can always be traced to the rules it ran under.
 *
 * Simulation only: there is no broker client in this repository.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PaperRules {
  readonly rulesVersion: string;
  readonly mode: "SIMULATED_ONLY";
  readonly list: "TOP_15_OVERALL";
  readonly weighting: "EQUAL";
  readonly startingCapitalUsd: number;
  readonly entry: "NEXT_SESSION_OPEN_AFTER_FREEZE";
  readonly exit: "FOLLOWING_SESSION_OPEN";
  readonly holdSessions: 1;
  readonly maxPositionFractionOfEquity: number;
  readonly dailyLossLimitFraction: number;
  readonly commissionPerOrderUsd: number;
  readonly slippageBpsPerSide: number;
  readonly wholeShares: true;
  /**
   * A held name with no open at this many exit attempts in a row (halted, delisted) is valued at $0 in
   * the ledger and in performance, and kept as a STUCK holding (never closed for good).
   */
  readonly markZeroAfterMissedExits: number;
  /**
   * MARK_ZERO_THEN_CORRECT (Peace, Nov 24): count a stuck holding at $0 for now; when a real later
   * price, buyout cash or bankruptcy payout shows up in the stored data, append a correction for the
   * actual amount. Fills and earlier ledger entries are never rewritten.
   */
  readonly stuckPositionRule: "MARK_ZERO_THEN_CORRECT";
}

export interface LoadedPaperRules {
  readonly rules: PaperRules;
  /** sha256 (hex) of the rules file bytes exactly as committed. */
  readonly rulesSha256: string;
}

/**
 * v2 (Nov 24, before any run): dropped v1's unapproved 1.8x "fill flat" gap rule (Auditor FAIL on #127:
 * it booked real crashes at 0% and biased P&L upward) and added a write-off at the last close.
 * v3 (Nov 24, before any run): replaces that write-off with Peace's $0-then-correct rule
 * (markZeroAfterMissedExits, stuckPositionRule). Neither v1 nor v2 ever ran; no ledger row was ever
 * written under them, so their files were removed.
 */
export const PAPER_RULES_CURRENT_VERSION = "paper-rules-v3";

const KEYS = [
  "rulesVersion",
  "mode",
  "list",
  "weighting",
  "startingCapitalUsd",
  "entry",
  "exit",
  "holdSessions",
  "maxPositionFractionOfEquity",
  "dailyLossLimitFraction",
  "commissionPerOrderUsd",
  "slippageBpsPerSide",
  "wholeShares",
  "markZeroAfterMissedExits",
  "stuckPositionRule",
] as const;

function fail(why: string): never {
  throw new Error(`PAPER_RULES_INVALID:${why}`);
}

function finiteIn(value: unknown, name: string, min: number, max: number, minExclusive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name}_NOT_A_NUMBER`);
  if (value > max || value < min || (minExclusive && value === min)) fail(`${name}_OUT_OF_RANGE`);
  return value;
}

/** Strict: exactly the known keys, fixed enum values, numbers in sane ranges. Anything else throws. */
export function parsePaperRules(text: string): PaperRules {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("NOT_JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("NOT_AN_OBJECT");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) fail("KEYS");
  if (typeof record.rulesVersion !== "string" || !/^paper-rules-v[0-9]+$/u.test(record.rulesVersion)) fail("rulesVersion");
  if (record.mode !== "SIMULATED_ONLY") fail("mode");
  if (record.list !== "TOP_15_OVERALL") fail("list");
  if (record.weighting !== "EQUAL") fail("weighting");
  if (record.entry !== "NEXT_SESSION_OPEN_AFTER_FREEZE") fail("entry");
  if (record.exit !== "FOLLOWING_SESSION_OPEN") fail("exit");
  if (record.holdSessions !== 1) fail("holdSessions");
  if (record.wholeShares !== true) fail("wholeShares");
  finiteIn(record.startingCapitalUsd, "startingCapitalUsd", 0, 1e9, true);
  finiteIn(record.maxPositionFractionOfEquity, "maxPositionFractionOfEquity", 0, 1, true);
  finiteIn(record.dailyLossLimitFraction, "dailyLossLimitFraction", 0, 1, true);
  finiteIn(record.commissionPerOrderUsd, "commissionPerOrderUsd", 0, 1000);
  finiteIn(record.slippageBpsPerSide, "slippageBpsPerSide", 0, 1000);
  finiteIn(record.markZeroAfterMissedExits, "markZeroAfterMissedExits", 1, 60);
  if (!Number.isInteger(record.markZeroAfterMissedExits)) fail("markZeroAfterMissedExits_NOT_AN_INTEGER");
  if (record.stuckPositionRule !== "MARK_ZERO_THEN_CORRECT") fail("stuckPositionRule");
  return Object.freeze({ ...record }) as unknown as PaperRules;
}

export function paperRulesPath(version: string = PAPER_RULES_CURRENT_VERSION): string {
  if (!/^paper-rules-v[0-9]+$/u.test(version)) fail("rulesVersion");
  return join(dirname(fileURLToPath(import.meta.url)), "..", "config", `${version}.json`);
}

/** Read and validate a rules file; the file name must match its rulesVersion. */
export function loadPaperRules(version: string = PAPER_RULES_CURRENT_VERSION): LoadedPaperRules {
  const bytes = readFileSync(paperRulesPath(version));
  const rules = parsePaperRules(bytes.toString("utf8"));
  if (rules.rulesVersion !== version) fail("FILE_VERSION_MISMATCH");
  return { rules, rulesSha256: createHash("sha256").update(bytes).digest("hex") };
}
