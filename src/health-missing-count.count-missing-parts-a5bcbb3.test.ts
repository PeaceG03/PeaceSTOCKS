import assert from "node:assert/strict";
import test from "node:test";
import { countMissingParts } from "./health-missing-count";

test("countMissingParts: the examples from the issue", () => {
  assert.equal(countMissingParts([]), 0);
  assert.equal(countMissingParts(["OK"]), 0);
  assert.equal(countMissingParts(["SILENT"]), 1);
  assert.equal(countMissingParts(["ERROR"]), 0);
  assert.equal(countMissingParts(["WARN", "silent"]), 0);
  assert.equal(countMissingParts(["SILENT", "SILENT", "ERROR", "ERROR"]), 2);
  assert.equal(countMissingParts(["OK", "WARN", "SILENT", "ERROR", "SILENT", "SILENT"]), 3);
});
