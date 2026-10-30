import assert from "node:assert/strict";
import test from "node:test";
import { tenMinBarsSaved } from "./tenmin-bars-saved";

test("tenMinBarsSaved: the examples from the issue", () => {
  assert.equal(tenMinBarsSaved(39, 39), true);
  assert.equal(tenMinBarsSaved(38, 39), false);
  assert.equal(tenMinBarsSaved(0, 39), false);
  assert.equal(tenMinBarsSaved(40, 39), false);
  assert.equal(tenMinBarsSaved(21, 21), true);
  assert.equal(tenMinBarsSaved(20, 21), false);
  assert.equal(tenMinBarsSaved(22, 21), false);
  assert.equal(tenMinBarsSaved(1, 1), true);
  assert.equal(tenMinBarsSaved(0, 0), true);
  assert.equal(tenMinBarsSaved(139, 39), false);
  assert.equal(tenMinBarsSaved(-61, 39), false);
  assert.equal(tenMinBarsSaved(121, 21), false);
  assert.equal(tenMinBarsSaved(-100, 0), false);
  assert.equal(tenMinBarsSaved(100, 0), false);
  assert.equal(tenMinBarsSaved(3, 2), false);
  assert.equal(tenMinBarsSaved(2, 3), false);
});
