import assert from "node:assert/strict";
import test from "node:test";
import { isIsoDateText } from "./tenmin-backfill";

test("isIsoDateText returns the expected values", () => {
  assert.equal(isIsoDateText("2024-10-31"), true);
  assert.equal(isIsoDateText("2024-1-31"), false);
});
