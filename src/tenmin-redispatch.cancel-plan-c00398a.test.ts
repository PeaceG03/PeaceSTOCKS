import assert from "node:assert/strict";
import test from "node:test";
import { planCancelDispatchedRun } from "./tenmin-redispatch";

test("cancel plan", () => {
  assert.deepEqual(planCancelDispatchedRun(undefined), { action: "none", detail: "dispatched-run-not-found" });
  assert.deepEqual(planCancelDispatchedRun({ id: 7, event: "workflow_dispatch", status: "in_progress", conclusion: null, created_at: "2024-01-01T00:00:00Z" }), { action: "cancel", runId: 7 });
  assert.deepEqual(planCancelDispatchedRun({ id: 8, event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "2024-01-01T00:00:00Z" }), { action: "none", detail: "status=completed:conclusion=success" });
});
