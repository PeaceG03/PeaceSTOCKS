import assert from "node:assert/strict";
import test from "node:test";
import { missedCheckins } from "./health-missed-checkins";

test("missedCheckins: the examples from the issue", () => {
  assert.equal(missedCheckins(1008, 1008), 0);
  assert.equal(missedCheckins(1008, 1007), 1);
  assert.equal(missedCheckins(1008, 1000), 8);
  assert.equal(missedCheckins(1008, 0), 1008);
  assert.equal(missedCheckins(2016, 0), 2016);
  assert.equal(missedCheckins(7, 9), 0);
  assert.equal(missedCheckins(0, 0), 0);
  assert.equal(missedCheckins(2016, 1500), 516);
  assert.equal(missedCheckins(7, 8), 0);
  assert.equal(missedCheckins(5, 2), 3);
  assert.equal(missedCheckins(1, 907), 0);
});
