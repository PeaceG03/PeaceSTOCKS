import assert from "node:assert/strict";
import test from "node:test";
import { partState } from "./health-part-state";

test("partState: the examples from the issue", () => {
  assert.equal(partState(false, false), "OK");
  assert.equal(partState(true, false), "SILENT");
  assert.equal(partState(false, true), "ERROR");
  assert.equal(partState(true, true), "ERROR");
});
