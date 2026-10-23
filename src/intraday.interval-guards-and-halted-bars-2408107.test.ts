import assert from "node:assert/strict";
import test from "node:test";
import { aggregateIntradayBars } from "./intraday";

test("interval guards and halted bars", () => {
  assert.throws(() => aggregateIntradayBars([], 25), /INVALID_AGGREGATION_INTERVAL/);
  assert.throws(() => aggregateIntradayBars([], 5), /INVALID_AGGREGATION_INTERVAL/);
  assert.deepEqual(aggregateIntradayBars([], 20), []);
  assert.deepEqual(aggregateIntradayBars([{ securityId: "sec_a", sessionDate: "2026-10-13", intervalIndex: 3, state: "HALTED", observedAt: "t", ingestedAt: "t", dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "foundation-d.1-10m-v1", revision: 1, provenance: { provider: "p", dataset: "d", retrievalId: "r", ingestionVersion: "i", normalizerVersion: "n" } }], 30), [{ securityId: "sec_a", sessionDate: "2026-10-13", intervalIndex: 1, sourceIntervalMinutes: 10, targetIntervalMinutes: 30, state: "HALTED" }]);
});
