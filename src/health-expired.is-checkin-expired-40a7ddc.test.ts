import assert from "node:assert/strict";
import test from "node:test";
import { isCheckinExpired } from "./health-expired";

test("isCheckinExpired: the examples from the issue", () => {
  assert.equal(isCheckinExpired(0), false);
  assert.equal(isCheckinExpired(1), false);
  assert.equal(isCheckinExpired(7), false);
  assert.equal(isCheckinExpired(14), false);
  assert.equal(isCheckinExpired(21), false);
  assert.equal(isCheckinExpired(29), false);
  assert.equal(isCheckinExpired(30), false);
  assert.equal(isCheckinExpired(31), true);
  assert.equal(isCheckinExpired(32), true);
  assert.equal(isCheckinExpired(45), true);
  assert.equal(isCheckinExpired(60), true);
  assert.equal(isCheckinExpired(90), true);
  assert.equal(isCheckinExpired(131), true);
  assert.equal(isCheckinExpired(180), true);
  assert.equal(isCheckinExpired(230), true);
  assert.equal(isCheckinExpired(280), true);
  assert.equal(isCheckinExpired(330), true);
  assert.equal(isCheckinExpired(365), true);
  assert.equal(isCheckinExpired(-1), false);
  assert.equal(isCheckinExpired(-30), false);
  assert.equal(isCheckinExpired(-70), false);
});
