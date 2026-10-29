import assert from "node:assert/strict";
import test from "node:test";
import { errorCountLine } from "./health-error-count-line";

test("errorCountLine: the examples from the issue", () => {
  assert.equal(errorCountLine("Fetch Failed", 40), "Fetch Failed: 40 time/s");
  assert.equal(errorCountLine("r2-timeout", 1), "r2-timeout: 1 time/s");
  assert.equal(errorCountLine("429", 0), "429: 0 time/s");
  assert.equal(errorCountLine("bars late ", 7), "bars late : 7 time/s");
  assert.equal(errorCountLine("", 5), ": 5 time/s");
  assert.equal(errorCountLine("timeout", 1440), "timeout: 1440 time/s");
  assert.equal(errorCountLine("gap", -1), "gap: -1 time/s");
});
