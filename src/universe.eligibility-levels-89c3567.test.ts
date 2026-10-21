import assert from "node:assert/strict";
import test from "node:test";
import { eligibilityForBarCount } from "./universe";

test("eligibility levels", () => {
  assert.equal(eligibilityForBarCount(0), "LEVEL_0");
  assert.equal(eligibilityForBarCount(19), "LEVEL_1");
  assert.equal(eligibilityForBarCount(251), "LEVEL_2");
  assert.equal(eligibilityForBarCount(252), "LEVEL_3");
  assert.throws(() => eligibilityForBarCount(1.5), /INVALID_BAR_COUNT/);
});
