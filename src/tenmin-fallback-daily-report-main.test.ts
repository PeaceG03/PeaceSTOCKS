// The fallback reads only the daily report from main's runs (Auditor, early review: optional).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fallback = readFileSync(new URL("../.github/workflows/tenmin-history-fallback.yml", import.meta.url), "utf8");

test("fallback: the newest daily 10-minute report is taken from main's runs only", () => {
  const step = /artifacts\?name=tenmin-daily-report[^\n]*\n[^\n]*--jq '([^']+)'/u.exec(fallback)?.[1];
  assert.ok(step, "daily report lookup found");
  assert.match(step, /\.workflow_run\.head_branch == "main"/u);
  assert.match(step, /\(\.expired \| not\)/u);
});
