import assert from "node:assert/strict";
import test from "node:test";
import { needsAttention } from "./health-needs-attention";

test("needsAttention: the examples from the issue", () => {
  assert.equal(needsAttention([]), false);
  assert.equal(needsAttention([0, 0, 0, 0]), false);
  assert.equal(needsAttention([1, 0, 0, 0]), true);
  assert.equal(needsAttention([0, 0, 0, 1]), true);
  assert.equal(needsAttention([0, 40, 0, 0]), true);
  assert.equal(needsAttention([0, 0, 101, 0]), true);
  assert.equal(needsAttention([2, 3, 1, 5]), true);
  assert.equal(needsAttention([-99, 0, 0, 0]), false);
  assert.equal(needsAttention([-5, 1, 0, 0]), true);
});
