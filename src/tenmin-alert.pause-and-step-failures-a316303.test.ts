import assert from "node:assert/strict";
import test from "node:test";
import { planTenMinAlert } from "./tenmin-alert";

test("pause and step failures", () => {
  assert.deepEqual(planTenMinAlert({ trigger: "chain", record: undefined, historyStep: "failure", redispatchStep: "success", killSwitch: undefined }), { action: "alert", reason: "STOP_JOB_FAILURE", key: "none:STOP_JOB_FAILURE" });
  assert.deepEqual(planTenMinAlert({ trigger: "chain", record: undefined, historyStep: "success", redispatchStep: "success", killSwitch: "false" }), { action: "none", why: "manual pause (TENMIN_AUTO_REDISPATCH not true)" });
  assert.deepEqual(planTenMinAlert({ trigger: "chain", record: undefined, historyStep: "success", redispatchStep: "cancelled", killSwitch: "true" }), { action: "alert", reason: "STOP_REDISPATCH_STEP_CANCELLED", key: "none:STOP_REDISPATCH_STEP_CANCELLED" });
  assert.deepEqual(planTenMinAlert({ trigger: "chain", record: undefined, historyStep: "success", redispatchStep: "", killSwitch: "true" }), { action: "alert", reason: "STOP_REDISPATCH_STEP_UNKNOWN", key: "none:STOP_REDISPATCH_STEP_UNKNOWN" });
  assert.deepEqual(planTenMinAlert({ trigger: "fallback", record: undefined, redispatchStep: "skipped", killSwitch: "true" }), { action: "alert", reason: "STOP_FALLBACK_STEP_SKIPPED", key: "fallback:none:skipped" });
  assert.deepEqual(planTenMinAlert({ trigger: "fallback", record: undefined, redispatchStep: "success", nextAction: "wait", reason: "WAIT_GUARD_WINDOW", killSwitch: "true" }), { action: "none", why: "planned wait (WAIT_GUARD_WINDOW)" });
});
