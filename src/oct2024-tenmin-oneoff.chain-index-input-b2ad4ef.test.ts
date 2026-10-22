import assert from "node:assert/strict";
import test from "node:test";
import { parseChainIndex } from "./oct2024-tenmin-oneoff";

test("chain index input", () => {
  assert.equal(parseChainIndex(undefined), 1);
  assert.equal(parseChainIndex(" 7 "), 7);
  assert.equal(parseChainIndex("999"), 999);
  assert.equal(parseChainIndex("01"), 1);
  assert.throws(() => parseChainIndex("1000"), /ONEOFF_CHAIN_INDEX_INVALID/);
  assert.throws(() => parseChainIndex("-1"), /ONEOFF_CHAIN_INDEX_INVALID/);
});
