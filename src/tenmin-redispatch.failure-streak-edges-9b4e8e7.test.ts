import assert from "node:assert/strict";
import test from "node:test";
import { priorConsecutiveFailures } from "./tenmin-redispatch";

test("failure streak edges", () => {
  assert.equal(priorConsecutiveFailures([]), 0);
  assert.equal(priorConsecutiveFailures([{ id: 3, event: "workflow_dispatch", status: "completed", conclusion: "cancelled", display_title: "Scanner" }, { id: 2, event: "workflow_dispatch", status: "completed", conclusion: "failure", display_title: "Scanner" }]), 0);
  assert.equal(priorConsecutiveFailures([{ id: 3, event: "schedule", status: "completed", conclusion: "success", display_title: "Scanner" }, { id: 2, event: "workflow_dispatch", status: "completed", conclusion: "failure", display_title: "Scanner" }]), 1);
  assert.equal(priorConsecutiveFailures([{ id: 2, event: "workflow_dispatch", status: "completed", conclusion: "failure", display_title: "Scanner" }, { id: 1, event: "workflow_dispatch", status: "completed", conclusion: "failure", display_title: "Scanner" }]), 2);
});
