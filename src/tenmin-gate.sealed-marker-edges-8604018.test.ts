import assert from "node:assert/strict";
import test from "node:test";
import { hasSealedMarker } from "./tenmin-gate";

test("sealed marker edges", () => {
  assert.equal(hasSealedMarker([]), false);
  assert.equal(hasSealedMarker([{ id: 1, status: "completed", conclusion: "success", head_branch: "main", event: "schedule", display_title: "One-off ten-minute fetch: sealed (post-seal)" }]), false);
  assert.equal(hasSealedMarker([{ id: 1, status: "completed", conclusion: "success", head_branch: "main", event: "workflow_dispatch" }]), false);
  assert.equal(hasSealedMarker([{ id: 1, status: "completed", conclusion: "failure", head_branch: "main", event: "workflow_dispatch", display_title: "x" }, { id: 2, status: "completed", conclusion: "success", head_branch: "main", event: "workflow_dispatch", display_title: "One-off ten-minute fetch: sealed (post-seal)" }]), true);
});
