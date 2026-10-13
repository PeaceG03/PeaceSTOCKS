import assert from "node:assert/strict";
import test from "node:test";
import { clampPercent } from "./num-utils";

test("clampPercent returns the expected values", () => {
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(42), 42);
});
