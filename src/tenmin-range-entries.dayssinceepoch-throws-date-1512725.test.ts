import assert from "node:assert/strict";
import test from "node:test";
import { daysSinceEpoch } from "./tenmin-range-entries";

test("daysSinceEpoch throws DATE_BEFORE_EPOCH", () => {
  assert.throws(() => daysSinceEpoch('1969-12-31'), /DATE_BEFORE_EPOCH/);
  assert.equal(daysSinceEpoch('1970-01-01'), 0);
});
