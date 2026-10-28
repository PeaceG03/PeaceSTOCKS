import assert from "node:assert/strict";
import test from "node:test";
import { countErrorMessage } from "./health-error-message-count";

test("countErrorMessage: the examples from the issue", () => {
  assert.equal(countErrorMessage([], "timeout"), 0);
  assert.equal(countErrorMessage(["timeout"], "timeout"), 1);
  assert.equal(countErrorMessage(["timeout"], "r2 down"), 0);
  assert.equal(countErrorMessage(["timeout", "r2 down", "timeout"], "timeout"), 2);
  assert.equal(countErrorMessage(["timeout", "r2 down", "timeout"], "r2 down"), 1);
  assert.equal(countErrorMessage(["Timeout", "timeout ", "timeout"], "timeout"), 1);
  assert.equal(countErrorMessage(["a", "a", "a"], "a"), 3);
});
