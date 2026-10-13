import assert from "node:assert/strict";
import test from "node:test";
import { planMissedScanAt } from "./scan-backstop";

test("a missed scheduled scan is dispatched once, a started one is not", () => {
  assert.equal(planMissedScanAt("2026-10-13T06:47:00Z", []), "dispatch");
  assert.equal(planMissedScanAt("2026-10-13T06:47:00Z", ["2026-10-13T05:31:00Z"]), "none");
  assert.equal(planMissedScanAt("2026-10-12T06:47:00Z", []), "none");
  assert.equal(planMissedScanAt("2026-10-13T07:47:00Z", []), "none");
  assert.equal(planMissedScanAt("2026-10-13T10:47:00Z", ["2026-10-13T05:31:00Z"]), "dispatch");
});
