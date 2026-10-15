import assert from "node:assert/strict";
import test from "node:test";
import { planMissedScanAt } from "./scan-backstop";

test("planMissedScanAt throws INVALID_NOW_ISO", () => {
  assert.throws(() => planMissedScanAt("", []), /INVALID_NOW_ISO/);
  assert.equal(planMissedScanAt("2026-10-13T06:47:00Z", []), "dispatch");
});
