import assert from "node:assert/strict";
import test from "node:test";
import { tenMinDayDone } from "./tenmin-day-done";

test("tenMinDayDone: the examples from the issue", () => {
  assert.equal(tenMinDayDone(true, false), true);
  assert.equal(tenMinDayDone(true, true), false);
  assert.equal(tenMinDayDone(false, false), false);
  assert.equal(tenMinDayDone(false, true), false);
});
