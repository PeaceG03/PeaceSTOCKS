import assert from "node:assert/strict";
import test from "node:test";
import { datedTickerMonthStarts } from "./ticker-reference-dated";

test("first month option", () => {
  assert.deepEqual(datedTickerMonthStarts(new Date("2026-03-15T00:00:00Z"), { firstMonth: "2026-01-01" }), ["2026-01-01", "2026-02-01", "2026-03-01"]);
  assert.deepEqual(datedTickerMonthStarts(new Date("2026-03-15T00:00:00Z"), { firstMonth: "2026-04-01" }), []);
  assert.throws(() => datedTickerMonthStarts(new Date("2026-03-15T00:00:00Z"), { firstMonth: "2026-01-15" }), /INVALID_FIRST_MONTH/);
  assert.deepEqual(datedTickerMonthStarts(new Date("2026-01-31T23:59:00Z"), { firstMonth: "2025-12-01" }), ["2025-12-01", "2026-01-01"]);
});
