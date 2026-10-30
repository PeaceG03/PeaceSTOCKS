import assert from "node:assert/strict";
import test from "node:test";
import { dayFullyStored } from "./day-fully-stored";

test("dayFullyStored: the examples from the issue", () => {
  assert.equal(dayFullyStored(true, true), true);
  assert.equal(dayFullyStored(true, false), false);
  assert.equal(dayFullyStored(false, true), false);
  assert.equal(dayFullyStored(false, false), false);
});
