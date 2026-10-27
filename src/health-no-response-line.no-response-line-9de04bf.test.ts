import assert from "node:assert/strict";
import test from "node:test";
import { noResponseLine } from "./health-no-response-line";

test("noResponseLine: the examples from the issue", () => {
  assert.equal(noResponseLine("Daily Bars", 45), "no response from Daily Bars, requested health check 45 time/s");
  assert.equal(noResponseLine("gap-refill", 1), "no response from gap-refill, requested health check 1 time/s");
  assert.equal(noResponseLine("r2", 0), "no response from r2, requested health check 0 time/s");
  assert.equal(noResponseLine("read-api ", 7), "no response from read-api , requested health check 7 time/s");
  assert.equal(noResponseLine("", 5), "no response from , requested health check 5 time/s");
  assert.equal(noResponseLine("intraday2", 1440), "no response from intraday2, requested health check 1440 time/s");
  assert.equal(noResponseLine("tenmin", -1), "no response from tenmin, requested health check -1 time/s");
});
