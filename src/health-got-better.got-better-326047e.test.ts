import assert from "node:assert/strict";
import test from "node:test";
import { gotBetter } from "./health-got-better";

test("gotBetter: the examples from the issue", () => {
  assert.equal(gotBetter(5, 3), false);
  assert.equal(gotBetter(3, 5), true);
  assert.equal(gotBetter(4, 4), false);
  assert.equal(gotBetter(1, 0), false);
  assert.equal(gotBetter(0, 1), true);
  assert.equal(gotBetter(0, 0), false);
  assert.equal(gotBetter(200, 0), false);
  assert.equal(gotBetter(0, 200), true);
});
