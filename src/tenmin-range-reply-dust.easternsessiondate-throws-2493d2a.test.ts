import assert from "node:assert/strict";
import test from "node:test";
import { easternSessionDate } from "./tenmin-range-reply-dust";

test("easternSessionDate throws INVALID_TIMESTAMP", () => {
  assert.throws(() => easternSessionDate(1e20), /INVALID_TIMESTAMP/);
  assert.equal(easternSessionDate(0), "1969-12-31");
});
