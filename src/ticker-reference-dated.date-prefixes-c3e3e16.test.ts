import assert from "node:assert/strict";
import test from "node:test";
import { datedTickerDatePrefix } from "./ticker-reference-dated";

test("date prefixes", () => {
  assert.equal(datedTickerDatePrefix("2024-02-29"), "permanent/ticker-reference-dated/2024-02-29");
  assert.equal(datedTickerDatePrefix("2026-06-30"), "permanent/ticker-reference-dated/2026-06-30");
  assert.throws(() => datedTickerDatePrefix("2026-04-31"), /INVALID_CALENDAR_DATE/);
  assert.throws(() => datedTickerDatePrefix("2026-1-05"), /INVALID_SESSION_DATE/);
});
