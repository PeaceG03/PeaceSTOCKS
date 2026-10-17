import assert from "node:assert/strict";
import test from "node:test";
import { sumOf } from "./num-utils";

test("sumOf returns the expected values", () => {
  assert.equal(sumOf([1, 2, 3]), 6);
  assert.equal(sumOf([]), 0);
  assert.equal(sumOf([0.5, -2]), -1.5);
});
