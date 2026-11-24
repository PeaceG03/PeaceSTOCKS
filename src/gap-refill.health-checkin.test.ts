import assert from "node:assert/strict";
import { test } from "node:test";
import { refillCheckin } from "./gap-refill";

test("C3: --after-scan checks in to health on the success and the failure path", () => {
  assert.deepEqual(refillCheckin(["--after-scan"], { code: 0 }), { state: "OK", message: "AFTER_SCAN" });
  assert.deepEqual(refillCheckin(["--after-scan"], { code: 2 }), { state: "ERROR", message: "GAP_REFILL_EXIT_2 (after-scan)" });
  assert.deepEqual(refillCheckin(["--after-scan"], { fail: "error" }), { state: "ERROR", message: "GAP_REFILL_FAIL_error (after-scan)" });
});

test("C3: the weekly refill (no argument) still checks in; the read-only probes never do", () => {
  assert.deepEqual(refillCheckin([], { code: 0 }), { state: "OK" });
  assert.deepEqual(refillCheckin([], { code: 4 }), { state: "ERROR", message: "GAP_REFILL_EXIT_4" });
  assert.deepEqual(refillCheckin([], { fail: "GUARD_REFUSED" }), { state: "ERROR", message: "GAP_REFILL_FAIL_GUARD_REFUSED" });
  assert.equal(refillCheckin(["--check"], { code: 0 }), undefined);
  assert.equal(refillCheckin(["--check-asof"], { code: 2 }), undefined);
});
