import assert from "node:assert/strict";
import test from "node:test";
import { sampleVariance } from "./features";

test("sampleVariance returns the expected values", () => {
  assert.equal(sampleVariance([2, 4, 6]), 4);
  assert.equal(sampleVariance([1, 3]), 2);
  assert.equal(sampleVariance([5]), 0);
  assert.equal(sampleVariance([]), 0);
});
