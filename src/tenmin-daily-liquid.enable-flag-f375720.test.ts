import assert from "node:assert/strict";
import test from "node:test";
import { tenMinDailyEnabled } from "./tenmin-daily-liquid";

test("enable flag", () => {
  assert.equal(tenMinDailyEnabled({ TENMIN_DAILY_ENABLED: "true" }), true);
  assert.equal(tenMinDailyEnabled({ TENMIN_DAILY_ENABLED: "TRUE" }), false);
  assert.equal(tenMinDailyEnabled({ TENMIN_DAILY_ENABLED: "1" }), false);
  assert.equal(tenMinDailyEnabled({}), false);
  assert.equal(tenMinDailyEnabled({ TENMIN_AUTO_REDISPATCH: "true" }), false);
});
