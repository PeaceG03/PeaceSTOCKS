import assert from "node:assert/strict";
import test from "node:test";
import { corporateActionCoverageRecords } from "./corporate-action-coverage";

test("session dedupe and counts", () => {
  assert.deepEqual(corporateActionCoverageRecords(["2025-10-15", "2025-10-14", "2025-10-15"], [{ effectiveDate: "2025-10-15" }, { effectiveDate: "2025-10-15" }, { effectiveDate: "2025-10-01" }], { provider: "p", source: "s", recordedAt: "t", datasets: ["stocks-splits"] }), [{ schemaVersion: "corporate-action-coverage-v1", sessionDate: "2025-10-14", provider: "p", datasets: ["stocks-splits"], actions: 0, recordedAt: "t", source: "s" }, { schemaVersion: "corporate-action-coverage-v1", sessionDate: "2025-10-15", provider: "p", datasets: ["stocks-splits"], actions: 2, recordedAt: "t", source: "s" }]);
  assert.deepEqual(corporateActionCoverageRecords([], [{ effectiveDate: "2025-10-15" }], { provider: "p", source: "s", recordedAt: "t" }), []);
});
