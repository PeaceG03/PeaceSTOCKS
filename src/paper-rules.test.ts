import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadPaperRules, parsePaperRules, PAPER_RULES_CURRENT_VERSION } from "./paper-rules";

const file = () => readFileSync(new URL("../config/paper-rules-v4.json", import.meta.url), "utf8");

test("paper rules v4: exactly the pre-registered values", () => {
  const { rules, rulesSha256 } = loadPaperRules();
  assert.equal(PAPER_RULES_CURRENT_VERSION, "paper-rules-v4");
  assert.deepEqual({ ...rules }, {
    rulesVersion: "paper-rules-v4",
    mode: "SIMULATED_ONLY",
    list: "TOP_15_OVERALL",
    weighting: "EQUAL",
    startingCapitalUsd: 100000,
    entry: "NEXT_SESSION_OPEN_AFTER_FREEZE",
    exit: "FOLLOWING_SESSION_OPEN",
    holdSessions: 1,
    maxPositionFractionOfEquity: 0.1,
    dailyLossLimitFraction: 0.03,
    commissionPerOrderUsd: 0,
    slippageBpsPerSide: 10,
    wholeShares: true,
    markZeroAfterMissedExits: 5,
    stuckPositionRule: "MARK_ZERO_THEN_CORRECT",
    coverageHoleFraction: 0.5,
  });
  assert.match(rulesSha256, /^[0-9a-f]{64}$/u);
});

test("paper rules: the doc states the same rules as the file", () => {
  const doc = readFileSync(new URL("../docs/PAPER_TRADING.md", import.meta.url), "utf8");
  for (const phrase of [
    "`TOP_15_OVERALL`",
    "equal weight",
    "$100,000",
    "next trading session after the freeze",
    "open of the following trading session",
    "at most 10% of equity",
    "lost 3% or more",
    "$0 per order",
    "10 bps per side",
    "rulesVersion `paper-rules-v4`",
    "5 exit attempts in a row",
    "valued at $0",
    "`MARK_ZERO_THEN_CORRECT`",
    "appended correction",
    "coverage hole",
    "fewer than 50% of the median",
    "at the actual open",
    "simulated, no real money",
  ])
    assert.ok(doc.includes(phrase), phrase);
});

test("paper rules: strict parsing rejects unknown keys, missing keys, wrong enums and bad numbers", () => {
  const base = JSON.parse(file()) as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>, drop?: string) => {
    const copy: Record<string, unknown> = { ...base, ...patch };
    if (drop) delete copy[drop];
    assert.throws(() => parsePaperRules(JSON.stringify(copy)), /PAPER_RULES_INVALID/u);
  };
  assert.doesNotThrow(() => parsePaperRules(JSON.stringify(base)));
  bad({ extra: 1 });
  bad({}, "slippageBpsPerSide");
  bad({ mode: "LIVE" });
  bad({ list: "TOP_50_OVERALL" });
  bad({ holdSessions: 2 });
  bad({ wholeShares: false });
  bad({ maxPositionFractionOfEquity: 0 });
  bad({ maxPositionFractionOfEquity: 1.5 });
  bad({ dailyLossLimitFraction: -0.03 });
  bad({ slippageBpsPerSide: -1 });
  bad({ slippageBpsPerSide: "10" });
  bad({ startingCapitalUsd: Number.NaN });
  bad({ unexplainedGapRatio: 1.8 }); // v1's gap rule is gone for good
  bad({ writeOffAfterMissedExits: 5 }); // v2's last-close write-off is gone for good
  bad({ markZeroAfterMissedExits: 0 });
  bad({ markZeroAfterMissedExits: 61 });
  bad({ markZeroAfterMissedExits: 2.5 });
  bad({}, "markZeroAfterMissedExits");
  bad({ stuckPositionRule: "WRITE_OFF_LAST_CLOSE" });
  bad({}, "stuckPositionRule");
  bad({ coverageHoleFraction: 0 });
  bad({ coverageHoleFraction: 1.5 });
  bad({ coverageHoleFraction: "0.5" });
  bad({}, "coverageHoleFraction");
  bad({ rulesVersion: "v1" });
  assert.throws(() => parsePaperRules("not json"), /PAPER_RULES_INVALID:NOT_JSON/u);
  assert.throws(() => loadPaperRules("../x"), /PAPER_RULES_INVALID/u);
});

test("paper rules: only the current version's file exists, and no file carries the gap rule", () => {
  const dir = new URL("../config/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.startsWith("paper-rules-"));
  assert.deepEqual(files, [`${PAPER_RULES_CURRENT_VERSION}.json`]);
  for (const name of files) assert.equal(readFileSync(new URL(name, dir), "utf8").includes("unexplainedGapRatio"), false);
});
