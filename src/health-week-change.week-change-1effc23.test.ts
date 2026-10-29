import assert from "node:assert/strict";
import test from "node:test";
import { weekChange } from "./health-week-change";

test("weekChange: the examples from the issue", () => {
  assert.equal(weekChange(false, false, false), "same");
  assert.equal(weekChange(false, false, true), "better");
  assert.equal(weekChange(false, true, false), "worse");
  assert.equal(weekChange(false, true, true), "worse");
  assert.equal(weekChange(true, false, false), "first week");
  assert.equal(weekChange(true, false, true), "first week");
  assert.equal(weekChange(true, true, false), "first week");
  assert.equal(weekChange(true, true, true), "first week");
});
