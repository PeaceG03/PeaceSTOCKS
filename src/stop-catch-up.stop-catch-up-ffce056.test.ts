import assert from "node:assert/strict";
import test from "node:test";
import { stopCatchUp } from "./stop-catch-up";

test("stopCatchUp: the examples from the issue", () => {
  assert.equal(stopCatchUp(0), false);
  assert.equal(stopCatchUp(1), false);
  assert.equal(stopCatchUp(2), false);
  assert.equal(stopCatchUp(3), true);
  assert.equal(stopCatchUp(4), true);
  assert.equal(stopCatchUp(103), true);
  assert.equal(stopCatchUp(50), true);
  assert.equal(stopCatchUp(-100), false);
});
