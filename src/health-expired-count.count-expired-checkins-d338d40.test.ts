import assert from "node:assert/strict";
import test from "node:test";
import { countExpiredCheckins } from "./health-expired-count";

test("countExpiredCheckins: the examples from the issue", () => {
  assert.equal(countExpiredCheckins([]), 0);
  assert.equal(countExpiredCheckins([30]), 0);
  assert.equal(countExpiredCheckins([31]), 1);
  assert.equal(countExpiredCheckins([29, 30, 31]), 1);
  assert.equal(countExpiredCheckins([-1, -30, 31]), 1);
  assert.equal(countExpiredCheckins([60, 90, 365]), 3);
  assert.equal(countExpiredCheckins([-70, 0, 30]), 0);
});
