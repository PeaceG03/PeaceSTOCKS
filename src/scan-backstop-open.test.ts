// Builder teaching example: open-ended backstop run filter and wiring (callers, permissions, no PAT).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scanRunCreatedSince } from "./scan-backstop";

const wf = (f: string) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");

test("scan runs: scheduled Scanner + dispatched runs with a scan job count; history/restarter/old runs do not", async () => {
  const since = Date.parse("2026-10-13T09:25:00Z");
  const runs = [
    { id: 1, event: "schedule", display_title: "Scanner", created_at: "2026-10-13T09:31:00Z" },
    { id: 2, event: "workflow_dispatch", display_title: "Scanner", created_at: "2026-10-13T10:20:00Z" },
    { id: 3, event: "workflow_dispatch", display_title: "Scanner", created_at: "2026-10-13T11:00:00Z" },
    { id: 4, event: "schedule", display_title: "Scanner restarter", created_at: "2026-10-13T10:47:00Z" },
    { id: 5, event: "schedule", display_title: "Scanner", created_at: "2026-10-13T05:31:00Z" },
  ];
  const asked: number[] = [];
  const got = await scanRunCreatedSince(since, runs, async (id) => { asked.push(id); return id === 3; });
  assert.deepEqual(got, ["2026-10-13T09:31:00Z", "2026-10-13T11:00:00Z"]);
  assert.deepEqual(asked, [2, 3], "jobs fetched only for dispatched Scanner runs in range");
});

test("wiring: one reusable dispatcher (actions: write, GITHUB_TOKEN, serialized) called from :47, history end, fallback", () => {
  const b = wf("scan-backstop.yml");
  assert.match(b, /workflow_call:/u);
  assert.doesNotMatch(b, /schedule:|secrets\./u, "no cron of its own, no PAT");
  assert.match(b, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(b, /actions: write/u);
  assert.match(b, /group: scan-backstop/u);
  const s = wf("scanner.yml");
  const job = (y: string, n: string) => { const i = y.indexOf(`\n  ${n}:\n`); assert.ok(i >= 0, n); const r = y.slice(i + 1); const e = r.search(/\n  [a-z_]+:\n/u); return e < 0 ? r : r.slice(0, e); };
  assert.match(job(s, "scan_backstop"), /uses: \.\/\.github\/workflows\/scan-backstop\.yml/u);
  const after = job(s, "scan_backstop_after_history");
  assert.match(after, /needs: \[tenmin_history\]/u);
  assert.match(after, /always\(\) && needs\.tenmin_history\.result != 'skipped'/u);
  assert.match(after, /uses: \.\/\.github\/workflows\/scan-backstop\.yml/u);
  const f = job(wf("tenmin-history-fallback.yml"), "scan_backstop");
  assert.match(f, /needs: decide/u);
  assert.match(f, /uses: \.\/\.github\/workflows\/scan-backstop\.yml/u);
  assert.match(job(s, "chain_followup"), /tenmin-history-fallback\.yml/u, "chain_followup reaches it via the fallback");
});
