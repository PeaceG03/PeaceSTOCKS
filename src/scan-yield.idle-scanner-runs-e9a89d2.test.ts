import assert from "node:assert/strict";
import test from "node:test";
import { isIdleScannerRun } from "./scan-yield";

test("idle scanner runs", () => {
  assert.equal(isIdleScannerRun({ display_title: "Scanner restarter" }), true);
  assert.equal(isIdleScannerRun({ display_title: "Scanner tenmin daily (off)" }), true);
  assert.equal(isIdleScannerRun({ display_title: "Scanner" }), false);
  assert.equal(isIdleScannerRun({ display_title: null }), false);
});
