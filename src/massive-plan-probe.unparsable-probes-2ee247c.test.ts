import assert from "node:assert/strict";
import test from "node:test";
import { classifyPlanProbe } from "./massive-plan-probe";

test("unparsable probes", () => {
  assert.deepEqual(classifyPlanProbe(200, "not json", null, "2024-08-28"), { olderReachable: undefined, ratePerMin: undefined, probedFrom: "2024-08-28", status: 200 });
  assert.deepEqual(classifyPlanProbe(403, "", "0", "2024-08-28"), { olderReachable: false, ratePerMin: undefined, probedFrom: "2024-08-28", status: 403 });
  assert.deepEqual(classifyPlanProbe(429, "", "abc", "2024-08-28"), { olderReachable: undefined, ratePerMin: undefined, probedFrom: "2024-08-28", status: 429 });
});
