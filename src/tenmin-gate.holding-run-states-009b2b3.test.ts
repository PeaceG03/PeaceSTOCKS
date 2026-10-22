import assert from "node:assert/strict";
import test from "node:test";
import { holdActive } from "./tenmin-gate";

test("holding run states", () => {
  assert.equal(holdActive([{ id: 1, status: "waiting", conclusion: null }]), true);
  assert.equal(holdActive([{ id: 1, status: null, conclusion: null }]), true);
  assert.equal(holdActive([{ id: 1, status: "completed", conclusion: "failure" }, { id: 2, status: "completed", conclusion: "cancelled" }]), false);
  assert.equal(holdActive([{ id: 1, status: "completed", conclusion: "success" }, { id: 2, status: "pending", conclusion: null }]), true);
});
