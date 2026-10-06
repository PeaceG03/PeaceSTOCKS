import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inScanGuardWindow, scanYieldReason } from "./scan-yield";

const actionsEnv = {
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/scanner.yml@refs/heads/main",
  GITHUB_RUN_ID: "100",
  GITHUB_API_URL: "https://api.example.test",
};
const midday = () => new Date("2026-10-06T18:00:00Z");
const runs = (workflow_runs: { id: number; status: string; event: string }[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.example.test/repos/owner/repo/actions/workflows/scanner.yml/runs?per_page=30");
    return new Response(JSON.stringify({ workflow_runs }), { status: 200 });
  }) as typeof fetch;

test("guard windows open 15 minutes before each scheduled scan and last an hour", () => {
  // 05:15–06:15 UTC
  assert.equal(inScanGuardWindow(new Date("2026-10-06T05:14:59Z")), false);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T05:15:00Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T06:14:59Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T06:15:00Z")), false);
  // 09:15–10:15 UTC
  assert.equal(inScanGuardWindow(new Date("2026-10-06T09:14:59Z")), false);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T09:15:00Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T10:14:59Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T10:15:00Z")), false);
  // Former windows (21:15–22:15 / 01:15–02:15) are no longer guarded.
  assert.equal(inScanGuardWindow(new Date("2026-10-05T21:30:00Z")), false);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T01:30:00Z")), false);
});

test("backfill yields inside a guard window even without API access", async () => {
  assert.match(
    (await scanYieldReason({ now: () => new Date("2026-10-06T05:20:00Z"), env: {} })) ?? "",
    /^SCAN_GUARD_WINDOW:/,
  );
  assert.equal(await scanYieldReason({ now: midday, env: {} }), undefined);
});

test("backfill yields to any other queued or running run of the workflow, not to itself", async () => {
  assert.equal(
    await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: runs([{ id: 100, status: "in_progress", event: "workflow_dispatch" }, { id: 7, status: "completed", event: "schedule" }]) }),
    undefined,
  );
  assert.equal(
    await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: runs([{ id: 100, status: "in_progress", event: "workflow_dispatch" }, { id: 101, status: "pending", event: "schedule" }]) }),
    "SCAN_RUN_WAITING:101:schedule:pending",
  );
});

test("a failed run check yields rather than risk the scan's budget", async () => {
  const failing = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  assert.equal(await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: failing }), "SCAN_CHECK_FAILED:http-503");
  const throwing = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.match((await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: throwing })) ?? "", /^SCAN_CHECK_FAILED:Error: offline/);
});

test("scanner.yml schedule crons are 05:30 and 09:30 UTC Tue–Sat", () => {
  const yml = readFileSync(join(process.cwd(), ".github/workflows/scanner.yml"), "utf8");
  const crons = [...yml.matchAll(/^[ \t]*- cron: "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(crons, ["30 5 * * 2-6", "30 9 * * 2-6"]);
  assert.equal(yml.includes("30 21 * * 1-5"), false);
  assert.equal(yml.includes("30 1 * * 2-6"), false);
});
