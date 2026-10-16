import assert from "node:assert/strict";
import test from "node:test";
import { countWholeHours } from "./num-utils";

test("countWholeHours returns the expected values", () => {
  assert.equal(countWholeHours(0), 0);
  assert.equal(countWholeHours(3599999), 0);
  assert.equal(countWholeHours(7200000), 2);
  assert.equal(countWholeHours(1000000000), 168);
});
