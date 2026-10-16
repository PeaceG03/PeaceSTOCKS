import assert from "node:assert/strict";
import test from "node:test";
import { daysBackToSlotDay } from "./scan-backstop";

test("daysBackToSlotDay returns the expected values", () => {
  assert.equal(daysBackToSlotDay(2, [2, 3, 4, 5, 6]), 0);
  assert.equal(daysBackToSlotDay(1, [2, 3, 4, 5, 6]), 2);
  assert.equal(daysBackToSlotDay(0, [2, 3, 4, 5, 6]), 1);
  assert.equal(daysBackToSlotDay(3, []), -1);
});
