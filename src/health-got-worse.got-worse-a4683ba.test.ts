import assert from "node:assert/strict";
import test from "node:test";
import { gotWorse } from "./health-got-worse";

test("gotWorse: the examples from the issue", () => {
  assert.equal(gotWorse(5, 3), true);
  assert.equal(gotWorse(3, 5), false);
  assert.equal(gotWorse(4, 4), false);
  assert.equal(gotWorse(1, 0), true);
  assert.equal(gotWorse(0, 1), false);
  assert.equal(gotWorse(0, 0), false);
  assert.equal(gotWorse(200, 0), true);
  assert.equal(gotWorse(0, 200), false);
});
