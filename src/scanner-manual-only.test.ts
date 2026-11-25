// Manual-only until reliable (Peace, Nov 24 2026): scanner.yml has no schedule,
// auto-chain paths stay off unless SCANNER_AUTO_CHAIN is exactly "true", and
// health skips scan freshness / missed-check-in alerts unless SCANNER_MANUAL_ONLY is exactly "false".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HEALTHY, evaluateHealth, scannerManualOnly } from "./health-check";
import { scannerAutoChainEnabled } from "./scanner-auto-chain";
import { decideTenMinRedispatch, type TenMinRedispatchInput, type TenMinRunOutcome } from "./tenmin-redispatch";

const scanner = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
const healthYml = readFileSync(new URL("../.github/workflows/health.yml", import.meta.url), "utf8");
const fallbackYml = readFileSync(new URL("../.github/workflows/tenmin-history-fallback.yml", import.meta.url), "utf8");
const backstopYml = readFileSync(new URL("../.github/workflows/scan-backstop.yml", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/SCANNER.md", import.meta.url), "utf8");

function yamlTopBlock(yml: string, key: string): string {
  const start = yml.search(new RegExp(`^${key}:`, "m"));
  assert.ok(start >= 0, `${key} block present`);
  const from = yml.slice(start);
  const next = from.slice(key.length + 1).search(/^\n[A-Za-z]/m);
  return next < 0 ? from : from.slice(0, key.length + 1 + next);
}

function jobBody(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} present`);
  const rest = yml.slice(start + 1);
  const end = rest.search(/\n  [a-z_]+:\n/u);
  return end < 0 ? yml.slice(start) : yml.slice(start, start + 1 + end);
}

test("scanner.yml: on.schedule is gone; workflow_dispatch stays (manual-only until reliable)", () => {
  const on = yamlTopBlock(scanner, "on");
  assert.match(on, /^  workflow_dispatch:/m);
  assert.doesNotMatch(on, /^  schedule:/m);
  assert.doesNotMatch(on, /^    - cron:/m);
  assert.deepEqual([...scanner.matchAll(/^[ \t]*- cron: "/gm)].map((m) => m[0]), []);
  assert.doesNotMatch(on, /^  workflow_call:/m);
});

test("auto-chain paths: chain follow-up, history-end backstop, and chain/fallback env require SCANNER_AUTO_CHAIN", () => {
  const followup = jobBody(scanner, "chain_followup");
  assert.match(followup, /vars\.SCANNER_AUTO_CHAIN == 'true'/u);
  const after = jobBody(scanner, "scan_backstop_after_history");
  assert.match(after, /vars\.SCANNER_AUTO_CHAIN == 'true'/u);
  assert.match(after, /needs: \[tenmin_history\]/u);
  const chainStep = jobBody(scanner, "tenmin_history");
  assert.match(chainStep, /SCANNER_AUTO_CHAIN: \$\{\{ vars\.SCANNER_AUTO_CHAIN \}\}/u);
  assert.match(fallbackYml, /SCANNER_AUTO_CHAIN: \$\{\{ vars\.SCANNER_AUTO_CHAIN \}\}/u);
  assert.match(backstopYml, /SCANNER_AUTO_CHAIN: \$\{\{ vars\.SCANNER_AUTO_CHAIN \}\}/u);
});

test("SCANNER_AUTO_CHAIN defaults off; only exactly true enables auto re-dispatch", () => {
  assert.equal(scannerAutoChainEnabled(undefined), false);
  assert.equal(scannerAutoChainEnabled(""), false);
  assert.equal(scannerAutoChainEnabled("TRUE"), false);
  assert.equal(scannerAutoChainEnabled("true"), true);
  const continueOutcome = {
    schemaVersion: "tenmin-history-outcome-v1",
    runId: "r1",
    nextAction: "continue",
    reason: "CONTINUE_TIME_BUDGET",
    rangesPlanned: 12,
    rangesSealed: 0,
    rangesRemaining: 2,
    madeProgress: true,
  } as TenMinRunOutcome;
  const base: TenMinRedispatchInput = {
    trigger: "chain",
    outcome: continueOutcome,
    jobResult: "success",
    nowUtc: new Date("2026-10-06T12:00:00Z"),
    queue: { otherActiveRuns: 0 },
    killSwitch: "true",
    chain: 0,
    maxChain: undefined,
  };
  const off = decideTenMinRedispatch({ ...base, scannerAutoChain: "" });
  assert.equal(off.reason, "SCANNER_AUTO_CHAIN_OFF");
  assert.equal(off.dispatch, false);
  assert.equal(decideTenMinRedispatch({ ...base, scannerAutoChain: "true" }).dispatch, true);
  // Existing callers that omit the field keep the previous kill-switch-only behavior.
  assert.equal(decideTenMinRedispatch(base).dispatch, true);
});

test("health.yml passes SCANNER_MANUAL_ONLY; unset/true skip scan freshness, false does not", () => {
  assert.match(healthYml, /SCANNER_MANUAL_ONLY: \$\{\{ vars\.SCANNER_MANUAL_ONLY \}\}/u);
  assert.equal(scannerManualOnly(undefined), true);
  assert.equal(scannerManualOnly(""), true);
  assert.equal(scannerManualOnly("true"), true);
  assert.equal(scannerManualOnly("TRUE"), true, "only exactly false turns the skip off");
  assert.equal(scannerManualOnly("false"), false);

  const NOW = new Date("2026-10-27T12:00:00Z");
  const parts = [
    { name: "scan", allowedSilenceMinutes: 60 },
    { name: "daily 10-minute step", allowedSilenceMinutes: 60 },
    { name: "history chain", allowedSilenceMinutes: 60 },
    { name: "backfill" },
    { name: "gap refill", allowedSilenceMinutes: 60 * 24 * 8 },
  ];
  const stale = (part: string) => ({ part, state: "OK", at: "2026-10-26T11:30:00Z" });
  const fresh = (part: string, state = "OK", message?: string) => ({
    part,
    state,
    at: "2026-10-27T11:30:00Z",
    ...(message ? { message } : {}),
  });
  const latest = new Map([
    ["scan", stale("scan")],
    ["gap refill", fresh("gap refill")],
  ]);

  const before = evaluateHealth({ parts, latest, now: NOW });
  assert.equal(before.parts.find((p) => p.name === "scan")!.status, "no response");
  assert.equal(before.attention, true);
  assert.ok(!before.lines.some((l) => l.includes("manual-only")));

  const skipped = evaluateHealth({ parts, latest, now: NOW, manualOnly: true });
  assert.equal(skipped.parts.find((p) => p.name === "scan")!.status, "OK");
  assert.equal(skipped.parts.find((p) => p.name === "daily 10-minute step")!.status, "OK");
  assert.equal(skipped.parts.find((p) => p.name === "history chain")!.status, "OK");
  assert.equal(skipped.headline, HEALTHY);
  assert.equal(skipped.attention, false);
  assert.ok(skipped.lines.includes("scan freshness skipped: manual-only"));
  assert.ok(skipped.parts.find((p) => p.name === "scan")!.line.includes("manual-only"));

  const failed = evaluateHealth({
    parts,
    latest: new Map([
      ["scan", fresh("scan", "ERROR", "MASSIVE_HTTP_500")],
      ["gap refill", fresh("gap refill")],
    ]),
    now: NOW,
    manualOnly: true,
  });
  assert.equal(failed.parts.find((p) => p.name === "scan")!.status, "error");
  assert.equal(failed.attention, true);
  assert.ok(failed.lines.includes("scan freshness skipped: manual-only"));

  const scheduled = evaluateHealth({ parts, latest, now: NOW, manualOnly: scannerManualOnly("false") });
  assert.equal(scheduled.parts.find((p) => p.name === "scan")!.status, "no response");
  assert.equal(scheduled.attention, true);
});

test("docs: Manual-only until reliable (Peace, Nov 24 2026) names the disabled workflows and how to flip back", () => {
  assert.match(docs, /Manual-only until reliable \(Peace, Nov 24 2026\)/u);
  for (const name of ["Scan backstop", "Ten-minute history fallback", "Daily-bars gap refill", "Oct 2024 ten-minute fetch", "Paper trading"]) {
    assert.match(docs, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"), name);
  }
  assert.match(docs, /SCANNER_AUTO_CHAIN/u);
  assert.match(docs, /SCANNER_MANUAL_ONLY/u);
  assert.match(docs, /set the repo variable `SCANNER_MANUAL_ONLY` to `false`/iu);
});
