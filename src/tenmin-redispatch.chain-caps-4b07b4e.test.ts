import assert from "node:assert/strict";
import test from "node:test";
import { maxChainOf } from "./tenmin-redispatch";

test("chain caps", () => {
  assert.equal(maxChainOf(7), 7);
  assert.equal(maxChainOf(150), 100);
  assert.equal(maxChainOf(-1), 24);
  assert.equal(maxChainOf(2.5), 24);
  assert.equal(maxChainOf(""), 24);
  assert.equal(maxChainOf("101"), 100);
});
