import assert from "node:assert/strict";
import test from "node:test";
import { effectiveGate, hasSealedMarker, parseGate, planGateGuard, GUARD_ALERT_TITLE, ONEOFF_SEALED_RUN_NAME, type RunLike } from "./tenmin-gate";

const sealedRun: RunLike = { id: 1, status: "completed", conclusion: "success", head_branch: "main", event: "workflow_dispatch", display_title: ONEOFF_SEALED_RUN_NAME };
const now = new Date("2026-10-12T22:00:00Z");

test("gate parse: true on, until_seal needs a plain workflow file, anything else off", () => {
  assert.deepEqual(parseGate("true"), { kind: "on" });
  assert.deepEqual(parseGate("until_oneoff_seal:oct2024-tenmin.yml"), { kind: "until_seal", workflow: "oct2024-tenmin.yml" });
  for (const v of [undefined, "false", "TRUE", "until_oneoff_seal:../x.yml", "until_oneoff_seal:a/b.yml", "until_oneoff_seal:"]) assert.deepEqual(parseGate(v), { kind: "off" });
});

test("marker: only a completed successful post-seal dispatch on main counts", () => {
  assert.equal(hasSealedMarker([sealedRun]), true);
  assert.equal(hasSealedMarker([{ ...sealedRun, status: "in_progress", conclusion: null }]), false);
  assert.equal(hasSealedMarker([{ ...sealedRun, conclusion: "failure" }]), false);
  assert.equal(hasSealedMarker([{ ...sealedRun, head_branch: "feature" }]), false);
  assert.equal(hasSealedMarker([{ ...sealedRun, display_title: "Oct 2024 ten-minute fetch (one-off) run" }]), false);
});

test("effective gate: until_seal opens only on the marker; fail closed when unresolved", () => {
  const v = "until_oneoff_seal:oct2024-tenmin.yml";
  assert.equal(effectiveGate(v, true), "true");
  assert.equal(effectiveGate(v, false), v);
  assert.equal(effectiveGate(v, undefined), v);
  assert.equal(effectiveGate("false", true), "false");
  assert.equal(effectiveGate("true", undefined), "true");
});

test("restarter guard: alerts only when off, no one-off active, idle >30 min, not already open", () => {
  const base = { effective: "false", now, openAlertTitles: [] as string[] };
  assert.equal(planGateGuard({ ...base, effective: "true", oneOffRuns: [] }).action, "none");
  assert.equal(planGateGuard({ ...base, oneOffRuns: [{ id: 2, status: "in_progress", conclusion: null }] }).action, "none");
  assert.equal(planGateGuard({ ...base, oneOffRuns: [{ id: 3, status: "completed", conclusion: "success", updated_at: "2026-10-12T21:45:00Z" }] }).action, "none");
  assert.equal(planGateGuard({ ...base, oneOffRuns: [{ id: 3, status: "completed", conclusion: "success", updated_at: "2026-10-12T21:20:00Z" }] }).action, "alert");
  assert.equal(planGateGuard({ ...base, oneOffRuns: [] }).action, "alert");
  assert.equal(planGateGuard({ ...base, oneOffRuns: [], openAlertTitles: [GUARD_ALERT_TITLE] }).action, "none");
  assert.equal(planGateGuard({ ...base, oneOffRuns: { error: "http-403" } }).action, "alert");
});
