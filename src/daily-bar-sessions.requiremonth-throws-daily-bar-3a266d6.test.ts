import assert from "node:assert/strict";
import test from "node:test";
import { requireMonth } from "./daily-bar-sessions";

test("requireMonth throws DAILY_BAR_MONTH_OUT_OF_RANGE", () => {
  assert.throws(() => requireMonth('2026-13'), /DAILY_BAR_MONTH_OUT_OF_RANGE/);
  assert.throws(() => requireMonth('2026-00'), /DAILY_BAR_MONTH_OUT_OF_RANGE/);
  assert.equal(requireMonth('2026-12'), undefined);
});
