import assert from "node:assert/strict";
import test from "node:test";
import { bandOf } from "./num-utils";

test("bandOf returns the expected values", () => {
  assert.equal(bandOf(5, 0, 10), "inside");
  assert.equal(bandOf(-1, 0, 10), "below");
  assert.equal(bandOf(11, 0, 10), "above");
  assert.throws(() => bandOf(1, 10, 0), /BAD_BAND/);
});
