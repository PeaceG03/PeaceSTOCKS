import assert from "node:assert/strict";
import test from "node:test";
import { eligibilityForBarCount } from "./universe";

test("eligibilityForBarCount throws INVALID_BAR_COUNT", () => {
  assert.throws(() => eligibilityForBarCount(-1), /INVALID_BAR_COUNT/);
  assert.equal(eligibilityForBarCount(20), "LEVEL_2");
});
