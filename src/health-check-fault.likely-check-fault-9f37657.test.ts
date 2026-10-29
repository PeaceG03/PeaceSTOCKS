import assert from "node:assert/strict";
import test from "node:test";
import { likelyCheckFault } from "./health-check-fault";

test("likelyCheckFault: the examples from the issue", () => {
  assert.equal(likelyCheckFault(0), false);
  assert.equal(likelyCheckFault(1), false);
  assert.equal(likelyCheckFault(2), false);
  assert.equal(likelyCheckFault(3), true);
  assert.equal(likelyCheckFault(4), true);
  assert.equal(likelyCheckFault(12), true);
  assert.equal(likelyCheckFault(103), true);
  assert.equal(likelyCheckFault(-97), false);
});
