// Builder teaching example: a history run waiting behind a scan/daily/backfill run is restarted when that run ends,
// by the blocker itself (chain_followup job), not by cron.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countOtherActiveScannerRuns } from "./tenmin-redispatch";

const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
const job = (() => {
  const start = yml.indexOf("\n  chain_followup:\n");
  assert.ok(start >= 0, "chain_followup job present");
  const next = yml.slice(start + 1).search(/\n  [a-z_]+:\n/u);
  return yml.slice(start, start + 1 + next);
})();

test("chain_followup: after scan/tenmin_daily/backfill, always(), skipped only when none ran, reuses the fallback", () => {
  assert.match(job, /needs: \[scan, tenmin_daily, backfill\]/u);
  assert.match(job, /always\(\)/u);
  for (const j of ["scan", "tenmin_daily", "backfill"]) assert.match(job, new RegExp(`needs\\.${j}\\.result != 'skipped'`, "u"));
  assert.match(job, /uses: \.\/\.github\/workflows\/tenmin-history-fallback\.yml/u);
  assert.match(job, /actions: write/u);
  assert.doesNotMatch(job, /schedule/u, "not tied to any cron");
});

test("chain_followup: the blocker's own run is not counted as active, so the wait resolves", () => {
  const self = { id: 7, status: "in_progress", event: "workflow_dispatch", display_title: "Scanner", name: "Scanner", created_at: "2026-10-13T05:52:42Z" };
  assert.equal(countOtherActiveScannerRuns([self] as never, 7), 0);
  assert.equal(countOtherActiveScannerRuns([self] as never, undefined), 1, "without exclusion it would wait forever");
});
