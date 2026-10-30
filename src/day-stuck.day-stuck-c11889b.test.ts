import assert from "node:assert/strict";
import test from "node:test";
import { dayStuck } from "./day-stuck";

test("dayStuck: the examples from the issue", () => {
  assert.equal(dayStuck(0), false);
  assert.equal(dayStuck(1), false);
  assert.equal(dayStuck(5), false);
  assert.equal(dayStuck(6), true);
  assert.equal(dayStuck(7), true);
  assert.equal(dayStuck(106), true);
  assert.equal(dayStuck(40), true);
  assert.equal(dayStuck(-100), false);
});
