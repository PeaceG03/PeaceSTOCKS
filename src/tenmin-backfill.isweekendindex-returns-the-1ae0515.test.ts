import assert from "node:assert/strict";
import test from "node:test";
import { isWeekendIndex } from "./tenmin-backfill";

test("isWeekendIndex returns the expected values", () => {
  assert.equal(isWeekendIndex(0), true);
  assert.equal(isWeekendIndex(3), false);
});
