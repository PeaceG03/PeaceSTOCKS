import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alertMarker, alertText, mountainTime, planTenMinAlert, runTenMinAlert, type TenMinAlertInput } from "./tenmin-alert";
import type { TenMinRunRecord } from "./tenmin-redispatch";

function record(nextAction: "continue" | "wait" | "stop", reason: string, extra: Partial<TenMinRunRecord> = {}): TenMinRunRecord {
  return {
    outcome: {
      schemaVersion: 1 as never,
      runId: "r",
      nextAction: nextAction === "stop" ? "stop" : "continue",
      reason,
      rangesPlanned: 12,
      rangesSealed: 0,
      rangesRemaining: 12,
      madeProgress: true,
      rangeRemaining: { range: "2024-11-01_2024-12-31", plannedFetches: 7363, storedFetches: 2922, gappedFetches: 3, orphanFetches: 0, remainingFetches: 4438 } as never,
    },
    jobResult: "success",
    chain: 3,
    githubRunId: "111",
    finishedAt: "2026-10-09T22:00:00Z",
    decision: { dispatch: nextAction === "continue", nextAction, reason, nextChain: 4 },
    ...extra,
  };
}

const chain = (over: Partial<TenMinAlertInput>): TenMinAlertInput => ({
  trigger: "chain",
  record: undefined,
  historyStep: "success",
  redispatchStep: "success",
  killSwitch: "true",
  ...over,
});

test("chain: dispatched next run closes any open alert", () => {
  assert.equal(planTenMinAlert(chain({ nextAction: "continue", reason: "CONTINUE_TIME_BUDGET" })).action, "close");
});

test("chain: planned waits (guard window, run active, queue check) never alert", () => {
  for (const reason of ["WAIT_GUARD_WINDOW", "WAIT_NEAR_GUARD_WINDOW", "WAIT_RUN_ACTIVE:1", "WAIT_QUEUE_CHECK_FAILED:http-500"])
    assert.equal(planTenMinAlert(chain({ nextAction: "wait", reason })).action, "none", reason);
});

test("chain: real stops alert, keyed by run id + reason code", () => {
  for (const reason of ["STOP_ERROR:boom", "STOP_OUTAGE:x", "STOP_DONE:no-range-left", "STOP_RANGE_END_CAP:2024-12-31", "STOP_NO_PROGRESS:TIME_BUDGET", "STOP_JOB_FAILURE", "STOP_JOB_CANCELLED", "STOP_CHAIN_CAP:24", "STOP_NO_OUTCOME"]) {
    const plan = planTenMinAlert(chain({ record: record("stop", reason), nextAction: "stop", reason }));
    assert.equal(plan.action, "alert", reason);
    if (plan.action === "alert") {
      assert.equal(plan.reason, reason);
      assert.equal(plan.key, `111:${reason.split(":")[0]}`);
    }
  }
});

test("chain: manual pause is silent unless the history step itself failed", () => {
  assert.equal(planTenMinAlert(chain({ killSwitch: "false", historyStep: "cancelled", nextAction: "stop", reason: "KILL_SWITCH_OFF" })).action, "none");
  assert.equal(planTenMinAlert(chain({ killSwitch: undefined, nextAction: "stop", reason: "KILL_SWITCH_OFF" })).action, "none");
  assert.equal(planTenMinAlert(chain({ killSwitch: "false", historyStep: "failure", nextAction: "stop", reason: "KILL_SWITCH_OFF" })).action, "alert");
});

test("chain: a failed redispatch step alerts with the rewritten stop record when present", () => {
  const rec = record("stop", "STOP_SCAN_CANCELLED:run=9");
  const plan = planTenMinAlert(chain({ record: rec, redispatchStep: "failure", nextAction: "continue", reason: "CONTINUE_TIME_BUDGET" }));
  assert.deepEqual(plan, { action: "alert", reason: "STOP_SCAN_CANCELLED:run=9", key: "111:STOP_SCAN_CANCELLED" });
  const bare = planTenMinAlert(chain({ redispatchStep: "failure" }));
  assert.equal(bare.action === "alert" && bare.reason, "STOP_REDISPATCH_STEP_FAILURE");
});

test("chain: no decision at all alerts", () => {
  const plan = planTenMinAlert(chain({ historyStep: "skipped", redispatchStep: "success" }));
  assert.equal(plan.action === "alert" && plan.reason, "STOP_NO_DECISION:skipped");
});

test("fallback: restart closes, waits and pause are silent, active run defers, stop alerts with the chain's key", () => {
  const fb = (over: Partial<TenMinAlertInput>): TenMinAlertInput => ({ trigger: "fallback", record: undefined, redispatchStep: "success", killSwitch: "true", otherActiveRuns: 0, ...over });
  assert.equal(planTenMinAlert(fb({ nextAction: "continue", reason: "CONTINUE_TIME_BUDGET" })).action, "close");
  assert.equal(planTenMinAlert(fb({ nextAction: "wait", reason: "WAIT_GUARD_WINDOW" })).action, "none");
  assert.equal(planTenMinAlert(fb({ killSwitch: "false", nextAction: "stop", reason: "KILL_SWITCH_OFF" })).action, "none");
  assert.equal(planTenMinAlert(fb({ nextAction: "stop", reason: "STOP_NO_OUTCOME", otherActiveRuns: 1 })).action, "none");
  const rec = record("stop", "STOP_RANGE_END_CAP:2024-12-31");
  const fromFallback = planTenMinAlert(fb({ record: rec, nextAction: "stop", reason: "STOP_RANGE_END_CAP:2024-12-31" }));
  const fromChain = planTenMinAlert(chain({ record: rec, nextAction: "stop", reason: "STOP_RANGE_END_CAP:2024-12-31" }));
  assert.equal(fromFallback.action, "alert");
  assert.deepEqual(fromFallback, fromChain, "same stop seen by chain and fallback dedupes");
  const failed = planTenMinAlert(fb({ redispatchStep: "failure" }));
  assert.equal(failed.action === "alert" && failed.reason, "STOP_FALLBACK_STEP_FAILURE");
});

test("alert text: run link, reason, progress, MT time, marker, no personal data", () => {
  const { title, body } = alertText({ reason: "STOP_DONE:no-range-left", key: "111:STOP_DONE", runUrl: "https://github.com/o/r/actions/runs/5", trigger: "chain", record: record("stop", "STOP_DONE:no-range-left"), now: new Date("2026-10-09T22:30:00Z") });
  assert.equal(title, "Scanner stopped: STOP_DONE:no-range-left");
  assert.match(body, /actions\/runs\/5/);
  assert.match(body, /2922 of 7363 fetches stored, 4438 remaining/);
  assert.match(body, /Oct 9, 2026, 4:30 PM MT/);
  assert.ok(body.includes(alertMarker("111:STOP_DONE")));
  assert.doesNotMatch(body, /@[a-z0-9-]+\.[a-z]{2,}/i);
  assert.ok(alertText({ reason: "x".repeat(200), key: "k", runUrl: "u", trigger: "fallback", record: undefined, now: new Date() }).title.length < 110);
  assert.match(mountainTime(new Date("2026-01-15T12:00:00Z")), /5:00 AM MT/);
});

// ---- CLI with a fake GitHub API ----

interface Call { method: string; path: string; body?: unknown }
function fakeGitHub(state: { open: { number: number; body: string }[]; closed?: { number: number; body: string }[]; comments?: Record<number, string[]>; runs?: { status: string }[] }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/repos\/o\/r/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: path + u.search, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/actions/workflows/scanner.yml/runs") return json({ workflow_runs: state.runs ?? [] });
    if (path === "/issues" && method === "GET") return json(u.searchParams.get("state") === "open" ? state.open : [...state.open, ...(state.closed ?? [])]);
    if (path === "/issues" && method === "POST") return json({ number: 42 }, 201);
    const c = path.match(/^\/issues\/(\d+)\/comments$/);
    if (c && method === "GET") return json((state.comments?.[Number(c[1])] ?? []).map((b) => ({ body: b })));
    if (c && method === "POST") return json({ id: 1 }, 201);
    if (/^\/issues\/\d+$/.test(path) && method === "PATCH") return json({});
    return json({ message: "nope" }, 404);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const keys = ["GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_RUN_ID", "GITHUB_API_URL", "TENMIN_RECORD_FILE", "TENMIN_HISTORY_STEP", "TENMIN_REDISPATCH_STEP", "TENMIN_NEXT_ACTION", "TENMIN_REASON", "TENMIN_AUTO_REDISPATCH", "SCANNER_ALERT_LABEL", "SCANNER_ALERT_FORCE_REASON"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", GITHUB_RUN_ID: "7", GITHUB_API_URL: "https://api.test" }, env);
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

async function recordFile(rec: TenMinRunRecord): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alert-"));
  const file = join(dir, "record.json");
  await writeFile(file, JSON.stringify(rec));
  return file;
}

test("cli: stop with no open alert opens one issue, labeled and assigned", async () => {
  const gh = fakeGitHub({ open: [] });
  try {
    const file = await recordFile(record("stop", "STOP_OUTAGE:massive"));
    await withEnv({ TENMIN_RECORD_FILE: file, TENMIN_HISTORY_STEP: "success", TENMIN_REDISPATCH_STEP: "success", TENMIN_NEXT_ACTION: "stop", TENMIN_REASON: "STOP_OUTAGE:massive", TENMIN_AUTO_REDISPATCH: "true" }, async () => {
      assert.equal(await runTenMinAlert("chain"), "alert: opened #42");
    });
    const create = gh.calls.find((c) => c.method === "POST" && c.path === "/issues");
    assert.deepEqual((create?.body as { labels: string[] }).labels, ["scanner-alert"]);
    assert.deepEqual((create?.body as { assignees: string[] }).assignees, ["PeaceG03"]);
    assert.match((create?.body as { title: string }).title, /^Scanner stopped: STOP_OUTAGE:massive$/);
  } finally { gh.restore(); }
});

test("cli: stop with an open alert comments instead of opening another", async () => {
  const gh = fakeGitHub({ open: [{ number: 5, body: alertMarker("999:STOP_ERROR") }] });
  try {
    const file = await recordFile(record("stop", "STOP_OUTAGE:massive"));
    await withEnv({ TENMIN_RECORD_FILE: file, TENMIN_REDISPATCH_STEP: "success", TENMIN_NEXT_ACTION: "stop", TENMIN_REASON: "STOP_OUTAGE:massive", TENMIN_AUTO_REDISPATCH: "true" }, async () => {
      assert.equal(await runTenMinAlert("chain"), "alert: commented on #5");
    });
    assert.ok(!gh.calls.some((c) => c.method === "POST" && c.path === "/issues"));
  } finally { gh.restore(); }
});

test("cli: the same stop already reported (open or closed, body or comment) is not repeated", async () => {
  const gh = fakeGitHub({ open: [], closed: [{ number: 8, body: "x" }], comments: { 8: [alertMarker("111:STOP_RANGE_END_CAP")] } });
  try {
    const file = await recordFile(record("stop", "STOP_RANGE_END_CAP:2024-12-31"));
    await withEnv({ TENMIN_RECORD_FILE: file, TENMIN_REDISPATCH_STEP: "success", TENMIN_NEXT_ACTION: "stop", TENMIN_REASON: "STOP_RANGE_END_CAP:2024-12-31", TENMIN_AUTO_REDISPATCH: "true" }, async () => {
      assert.equal(await runTenMinAlert("fallback"), "alert: already reported in #8");
    });
    assert.ok(!gh.calls.some((c) => c.method === "POST"));
  } finally { gh.restore(); }
});

test("cli: a chained run closes open alerts with 'Chain running again'", async () => {
  const gh = fakeGitHub({ open: [{ number: 5, body: "b" }] });
  try {
    await withEnv({ TENMIN_REDISPATCH_STEP: "success", TENMIN_NEXT_ACTION: "continue", TENMIN_REASON: "CONTINUE_TIME_BUDGET", TENMIN_AUTO_REDISPATCH: "true" }, async () => {
      assert.match(await runTenMinAlert("chain"), /^close: 1 closed/);
    });
    const comment = gh.calls.find((c) => c.method === "POST" && c.path === "/issues/5/comments");
    assert.match((comment?.body as { body: string }).body, /^Chain running again/);
    assert.deepEqual(gh.calls.find((c) => c.method === "PATCH")?.body, { state: "closed", state_reason: "completed" });
  } finally { gh.restore(); }
});

test("cli: planned wait touches no issue", async () => {
  const gh = fakeGitHub({ open: [{ number: 5, body: "b" }] });
  try {
    await withEnv({ TENMIN_REDISPATCH_STEP: "success", TENMIN_NEXT_ACTION: "wait", TENMIN_REASON: "WAIT_GUARD_WINDOW", TENMIN_AUTO_REDISPATCH: "true" }, async () => {
      assert.match(await runTenMinAlert("chain"), /^none: planned wait/);
    });
    assert.ok(!gh.calls.some((c) => c.method !== "GET"));
  } finally { gh.restore(); }
});

test("cli: test label keeps test alerts apart from real ones", async () => {
  const gh = fakeGitHub({ open: [] });
  try {
    await withEnv({ SCANNER_ALERT_LABEL: "scanner-alert-test", SCANNER_ALERT_FORCE_REASON: "TEST_ALERT:safe to close" }, async () => {
      assert.equal(await runTenMinAlert("chain"), "alert: opened #42");
    });
    assert.ok(gh.calls.every((c) => !c.path.includes("labels=scanner-alert&") && !c.path.endsWith("labels=scanner-alert")));
    assert.deepEqual((gh.calls.find((c) => c.method === "POST")?.body as { labels: string[] }).labels, ["scanner-alert-test"]);
  } finally { gh.restore(); }
});
