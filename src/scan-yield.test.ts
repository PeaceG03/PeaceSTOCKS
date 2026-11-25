import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createScanYieldCheck, inScanGuardWindow, scanYieldReason } from "./scan-yield";

const actionsEnv = {
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/scanner.yml@refs/heads/main",
  GITHUB_RUN_ID: "100",
  GITHUB_API_URL: "https://api.example.test",
};
const midday = () => new Date("2026-10-06T18:00:00Z");
const runs = (workflow_runs: { id: number; status: string; event: string; display_title?: string }[]): typeof fetch =>
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

test("backfill yields inside a guard window when SCANNER_MANUAL_ONLY is false, even without API access", async () => {
  assert.match(
    (await scanYieldReason({ now: () => new Date("2026-10-06T05:20:00Z"), env: { SCANNER_MANUAL_ONLY: "false" } })) ?? "",
    /^SCAN_GUARD_WINDOW:/,
  );
  assert.equal(await scanYieldReason({ now: midday, env: { SCANNER_MANUAL_ONLY: "false" } }), undefined);
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

test("history/backfill never yield to a restarter run (hourly :47 cron), only to real scan/history runs", async () => {
  const restarter = { id: 102, status: "in_progress", event: "schedule", display_title: "Scanner restarter" };
  assert.equal(
    await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: runs([{ id: 100, status: "in_progress", event: "workflow_dispatch" }, restarter]) }),
    undefined,
  );
  assert.equal(
    await scanYieldReason({
      now: midday,
      env: actionsEnv,
      fetchImpl: runs([restarter, { id: 101, status: "pending", event: "schedule", display_title: "Scanner" }]),
    }),
    "SCAN_RUN_WAITING:101:schedule:pending",
  );
});

test("a failed run check yields rather than risk the scan's budget", async () => {
  const failing = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  assert.equal(await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: failing }), "SCAN_CHECK_FAILED:http-503");
  const throwing = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.match((await scanYieldReason({ now: midday, env: actionsEnv, fetchImpl: throwing })) ?? "", /^SCAN_CHECK_FAILED:Error: offline/);
});

test("scanner.yml has no schedule crons while manual-only; daily liquid times stay outside the guard windows", () => {
  const yml = readFileSync(join(process.cwd(), ".github/workflows/scanner.yml"), "utf8");
  const crons = [...yml.matchAll(/^[ \t]*- cron: "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(crons, []);
  // The daily liquid ticks start outside every guard window, after the scan they follow.
  for (const hm of ["06:20", "10:20"]) assert.equal(inScanGuardWindow(new Date(`2026-10-13T${hm}:00Z`)), false, hm);
  assert.equal(yml.includes("30 21 * * 1-5"), false);
  assert.equal(yml.includes("30 1 * * 2-6"), false);
});

test("manual-only: do not yield for scheduled-slot windows; still yield to a queued or in-progress scanner run", async () => {
  // Run 45558915363 started 06:13Z inside 05:15–06:15 and fetched 0 sessions.
  // Run 45579381976 started 08:47Z and stopped at 09:16Z (inside 09:15–10:15) after 47 sessions, stopReason YIELDED.
  const at0613 = () => new Date("2026-11-25T06:13:00Z");
  const at0916 = () => new Date("2026-11-25T09:16:00Z");

  for (const now of [at0613, at0916]) {
    assert.equal(await scanYieldReason({ now, env: {} }), undefined, "unset defaults to manual-only");
    assert.equal(await scanYieldReason({ now, env: { SCANNER_MANUAL_ONLY: "true" } }), undefined);
    assert.equal(await scanYieldReason({ now, env: { SCANNER_MANUAL_ONLY: "TRUE" } }), undefined);
    assert.match(
      (await scanYieldReason({ now, env: { SCANNER_MANUAL_ONLY: "false" } })) ?? "",
      /^SCAN_GUARD_WINDOW:/,
    );
    assert.equal(await createScanYieldCheck({ now, env: {} })(), undefined);
    assert.match((await createScanYieldCheck({ now, env: { SCANNER_MANUAL_ONLY: "false" } })()) ?? "", /^SCAN_GUARD_WINDOW:/);
  }

  assert.equal(
    await scanYieldReason({
      now: at0916,
      env: { ...actionsEnv, SCANNER_MANUAL_ONLY: "true" },
      fetchImpl: runs([
        { id: 100, status: "in_progress", event: "workflow_dispatch" },
        { id: 101, status: "queued", event: "workflow_dispatch", display_title: "Scanner" },
      ]),
    }),
    "SCAN_RUN_WAITING:101:workflow_dispatch:queued",
  );
  assert.equal(
    await scanYieldReason({
      now: at0916,
      env: { ...actionsEnv },
      fetchImpl: runs([
        { id: 100, status: "in_progress", event: "workflow_dispatch" },
        { id: 102, status: "in_progress", event: "schedule", display_title: "Scanner restarter" },
      ]),
    }),
    undefined,
  );

  const yml = readFileSync(join(process.cwd(), ".github/workflows/scanner.yml"), "utf8");
  assert.match(yml, /SCANNER_MANUAL_ONLY: \$\{\{ vars\.SCANNER_MANUAL_ONLY \}\}/u);
});

