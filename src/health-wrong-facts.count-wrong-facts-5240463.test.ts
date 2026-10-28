import assert from "node:assert/strict";
import test from "node:test";
import { countWrongFacts } from "./health-wrong-facts";

test("countWrongFacts: the examples from the issue", () => {
  assert.equal(countWrongFacts([]), 0);
  assert.equal(countWrongFacts([false]), 0);
  assert.equal(countWrongFacts([true]), 1);
  assert.equal(countWrongFacts([true, false, true]), 2);
  assert.equal(countWrongFacts([false, false, false]), 0);
  assert.equal(countWrongFacts([true, true, true, false]), 3);
});
