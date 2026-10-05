import assert from "node:assert/strict";
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
  assert.equal(inScanGuardWindow(new Date("2026-10-05T21:14:59Z")), false);
  assert.equal(inScanGuardWindow(new Date("2026-10-05T21:15:00Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-05T22:14:00Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-05T22:15:00Z")), false);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T01:15:00Z")), true);
  assert.equal(inScanGuardWindow(new Date("2026-10-06T02:15:00Z")), false);
});

test("backfill yields inside a guard window even without API access", async () => {
  assert.match(
    (await scanYieldReason({ now: () => new Date("2026-10-05T21:20:00Z"), env: {} })) ?? "",
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
