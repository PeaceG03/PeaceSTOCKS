import assert from "node:assert/strict";
import test from "node:test";
import { bandOf } from "./num-utils";

test("band edges", () => {
  assert.equal(bandOf(0, 0, 10), "inside");
  assert.equal(bandOf(10, 0, 10), "inside");
  assert.equal(bandOf(10.5, 0, 10), "above");
  assert.equal(bandOf(-0.5, 0, 10), "below");
});
