import assert from "node:assert/strict";
import test from "node:test";
import { weeklyExpected } from "./health-weekly-expected";

test("weeklyExpected: the examples from the issue", () => {
  assert.equal(weeklyExpected(0), 0);
  assert.equal(weeklyExpected(1), 7);
  assert.equal(weeklyExpected(2), 14);
  assert.equal(weeklyExpected(24), 168);
  assert.equal(weeklyExpected(144), 1008);
  assert.equal(weeklyExpected(288), 2016);
  assert.equal(weeklyExpected(-1), -7);
  assert.equal(weeklyExpected(-100), -700);
});
