import assert from "node:assert/strict";
import test from "node:test";
import { groupedDailyPath } from "./massive-provider";

test("groupedDailyPath throws INVALID_GROUPED_DAILY_DATE", () => {
  assert.throws(() => groupedDailyPath("2026-10-15/../x"), /INVALID_GROUPED_DAILY_DATE/);
  assert.equal(groupedDailyPath("2026-10-15"), "/v2/aggs/grouped/locale/us/market/stocks/2026-10-15");
});
