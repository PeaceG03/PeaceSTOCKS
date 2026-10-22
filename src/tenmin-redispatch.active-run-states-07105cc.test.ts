import assert from "node:assert/strict";
import test from "node:test";
import { countOtherActiveScannerRuns } from "./tenmin-redispatch";

test("active run states", () => {
  assert.equal(countOtherActiveScannerRuns([{ id: 1, status: "waiting" }, { id: 2, status: "pending" }, { id: 3, status: "requested" }]), 3);
  assert.equal(countOtherActiveScannerRuns([{ id: 1, status: "completed" }, { id: 2, status: "cancelled" }, { id: 3, status: "unknown" }]), 0);
  assert.equal(countOtherActiveScannerRuns([{ id: 1, status: "queued", display_title: null }], 2), 1);
  assert.equal(countOtherActiveScannerRuns([{ id: 5, status: "in_progress" }, { id: 6, status: "queued" }], 5), 1);
});
