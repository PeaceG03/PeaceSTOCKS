import assert from "node:assert/strict";
import test from "node:test";
import { datedTickerDatePrefix } from "./ticker-reference-dated";

test("datedTickerDatePrefix throws INVALID_CALENDAR_DATE", () => {
  assert.throws(() => datedTickerDatePrefix('2026-13-01'), /INVALID_CALENDAR_DATE/);
  assert.throws(() => datedTickerDatePrefix('2026-02-30'), /INVALID_CALENDAR_DATE/);
});
