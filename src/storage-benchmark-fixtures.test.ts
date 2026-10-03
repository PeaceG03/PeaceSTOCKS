import assert from "node:assert/strict";
import test from "node:test";
import { PEACESTOCKS_STORAGE_BENCHMARK } from "./storage-benchmark-fixtures";

test("the four-day storage baseline fixture is frozen and mixed stock/ETF", () => {
  assert.deepEqual(PEACESTOCKS_STORAGE_BENCHMARK.dates, [
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
  ]);
  assert.equal(PEACESTOCKS_STORAGE_BENCHMARK.intervalMinutes, 10);
  assert.equal(PEACESTOCKS_STORAGE_BENCHMARK.logicalSchema, "foundation-d.1-10m-v1");
  assert.equal(
    new Set(PEACESTOCKS_STORAGE_BENCHMARK.securities.map((item) => item.securityId)).size,
    3,
  );
  assert.deepEqual(
    new Set(PEACESTOCKS_STORAGE_BENCHMARK.securities.map((item) => item.assetType)),
    new Set(["STOCK", "ETF"]),
  );
  assert.match(PEACESTOCKS_STORAGE_BENCHMARK.selectionRationale, /not a full-universe projection/);
});
