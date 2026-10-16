import assert from "node:assert/strict";
import test from "node:test";
import { daysBackToSlotDay } from "./scan-backstop";

test("daysBackToSlotDay throws INVALID_UTC_DAY", () => {
  assert.throws(() => daysBackToSlotDay(7.5, [1]), /INVALID_UTC_DAY/);
  assert.equal(daysBackToSlotDay(3, [3]), 0);
});
