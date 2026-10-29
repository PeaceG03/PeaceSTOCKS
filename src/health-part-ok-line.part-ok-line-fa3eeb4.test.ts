import assert from "node:assert/strict";
import test from "node:test";
import { partOkLine } from "./health-part-ok-line";

test("partOkLine: the examples from the issue", () => {
  assert.equal(partOkLine("r2"), "r2: OK");
  assert.equal(partOkLine("Daily Bars"), "Daily Bars: OK");
  assert.equal(partOkLine(""), ": OK");
  assert.equal(partOkLine("read-api "), "read-api : OK");
  assert.equal(partOkLine("intraday2"), "intraday2: OK");
  assert.equal(partOkLine("gap-refill"), "gap-refill: OK");
});
