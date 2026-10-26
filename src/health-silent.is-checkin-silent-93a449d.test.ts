import assert from "node:assert/strict";
import test from "node:test";
import { isCheckinSilent } from "./health-silent";

test("isCheckinSilent: the examples from the issue", () => {
  assert.equal(isCheckinSilent(0, 10), false);
  assert.equal(isCheckinSilent(5, 10), false);
  assert.equal(isCheckinSilent(10, 10), false);
  assert.equal(isCheckinSilent(11, 10), true);
  assert.equal(isCheckinSilent(12, 10), true);
  assert.equal(isCheckinSilent(60, 10), true);
  assert.equal(isCheckinSilent(200, 10), true);
  assert.equal(isCheckinSilent(9, 10), false);
  assert.equal(isCheckinSilent(30, 30), false);
  assert.equal(isCheckinSilent(31, 30), true);
  assert.equal(isCheckinSilent(29, 30), false);
  assert.equal(isCheckinSilent(0, 120), false);
  assert.equal(isCheckinSilent(119, 120), false);
  assert.equal(isCheckinSilent(120, 120), false);
  assert.equal(isCheckinSilent(121, 120), true);
  assert.equal(isCheckinSilent(240, 120), true);
  assert.equal(isCheckinSilent(400, 120), true);
  assert.equal(isCheckinSilent(15, 1440), false);
  assert.equal(isCheckinSilent(1440, 1440), false);
  assert.equal(isCheckinSilent(1441, 1440), true);
  assert.equal(isCheckinSilent(3000, 1440), true);
  assert.equal(isCheckinSilent(700, 1440), false);
});
