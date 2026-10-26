import assert from "node:assert/strict";
import test from "node:test";
import { countErrorParts } from "./health-error-count";

test("countErrorParts: the examples from the issue", () => {
  assert.equal(countErrorParts([]), 0);
  assert.equal(countErrorParts(["OK"]), 0);
  assert.equal(countErrorParts(["ERROR"]), 1);
  assert.equal(countErrorParts(["SILENT"]), 0);
  assert.equal(countErrorParts(["WARN", "error"]), 0);
  assert.equal(countErrorParts(["ERROR", "ERROR", "SILENT", "SILENT"]), 2);
  assert.equal(countErrorParts(["OK", "WARN", "ERROR", "SILENT", "ERROR", "ERROR"]), 3);
});
