import assert from "node:assert/strict";
import test from "node:test";
import { historyBlocked } from "./history-blocked";

test("historyBlocked: the examples from the issue", () => {
  assert.equal(historyBlocked(true, false, true), true);
  assert.equal(historyBlocked(true, true, true), false);
  assert.equal(historyBlocked(true, false, false), false);
  assert.equal(historyBlocked(true, true, false), false);
  assert.equal(historyBlocked(false, false, true), false);
  assert.equal(historyBlocked(false, true, true), false);
  assert.equal(historyBlocked(false, false, false), false);
  assert.equal(historyBlocked(false, true, false), false);
});
