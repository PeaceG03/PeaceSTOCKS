import assert from "node:assert/strict";
import test from "node:test";
import { classifyPlanProbe, probeDates, probeMassivePlan } from "./massive-plan-probe";

test("plan probe: 200 with bars => older reachable; 403 => same plan; errors unknown; rate header parsed", () => {
  assert.equal(classifyPlanProbe(200, '{"resultsCount":7}', null, "x").olderReachable, true);
  assert.equal(classifyPlanProbe(200, '{"resultsCount":0}', null, "x").olderReachable, false);
  assert.equal(classifyPlanProbe(403, "timeframe", null, "x").olderReachable, false);
  assert.equal(classifyPlanProbe(500, "", null, "x").olderReachable, undefined);
  assert.equal(classifyPlanProbe("error", "", null, "x").olderReachable, undefined);
  assert.equal(classifyPlanProbe(403, "", "300", "x").ratePerMin, 300);
  assert.deepEqual(probeDates("2024-10-07"), { from: "2024-08-28", to: "2024-09-07" });
});

test("plan probe: one request, before the window, key never logged", async () => {
  const urls: string[] = [];
  const f = (async (u: URL) => { urls.push(String(u)); return new Response('{"resultsCount":3}', { status: 200 }); }) as unknown as typeof fetch;
  const p = await probeMassivePlan("k", new Date("2026-10-13T12:00:00Z"), f);
  assert.equal(urls.length, 1);
  assert.equal(p.olderReachable, true);
  assert.ok(!JSON.stringify(p).includes("k\""));
});
