import assert from "node:assert/strict";
import test from "node:test";
import { checkinLine } from "./health-checkin-count-line";

test("checkinLine: the examples from the issue", () => {
  assert.equal(checkinLine("r2", 1000, 1008), "r2: sent 1000 of 1008 check-ins");
  assert.equal(checkinLine("Daily Bars", 7, 7), "Daily Bars: sent 7 of 7 check-ins");
  assert.equal(checkinLine("", 0, 1), ": sent 0 of 1 check-ins");
  assert.equal(checkinLine("read-api ", 1, 0), "read-api : sent 1 of 0 check-ins");
  assert.equal(checkinLine("tenmin", -1, 1440), "tenmin: sent -1 of 1440 check-ins");
  assert.equal(checkinLine("gap-refill", 3, -2), "gap-refill: sent 3 of -2 check-ins");
});
