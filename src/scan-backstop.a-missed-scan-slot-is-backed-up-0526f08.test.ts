import assert from "node:assert/strict";
import test from "node:test";
import { planOpenScanAt } from "./scan-backstop";

test("a missed scan slot is backed up until the next slot, never inside a guard window", () => {
  assert.equal(planOpenScanAt("2026-10-13T12:11:00Z", []), "dispatch");
  assert.equal(planOpenScanAt("2026-10-13T12:11:00Z", ["2026-10-13T09:31:00Z"]), "none");
  assert.equal(planOpenScanAt("2026-10-13T07:47:00Z", []), "dispatch");
  assert.equal(planOpenScanAt("2026-10-13T07:47:00Z", ["2026-10-13T05:52:42Z"]), "none");
  assert.equal(planOpenScanAt("2026-10-13T10:00:00Z", []), "wait");
  assert.equal(planOpenScanAt("2026-10-13T05:40:00Z", []), "none");
});
