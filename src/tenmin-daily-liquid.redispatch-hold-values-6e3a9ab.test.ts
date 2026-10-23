import assert from "node:assert/strict";
import test from "node:test";
import { tenMinDailyRedispatchHold } from "./tenmin-daily-liquid";

test("redispatch hold values", () => {
  assert.equal(tenMinDailyRedispatchHold({ TENMIN_AUTO_REDISPATCH: "" }), 'SKIP_REDISPATCH_PAUSED:TENMIN_AUTO_REDISPATCH=""');
  assert.equal(tenMinDailyRedispatchHold({ TENMIN_AUTO_REDISPATCH: "TRUE" }), 'SKIP_REDISPATCH_PAUSED:TENMIN_AUTO_REDISPATCH="TRUE"');
  assert.equal(tenMinDailyRedispatchHold({ TENMIN_AUTO_REDISPATCH: "true", TENMIN_DAILY_ENABLED: "false" }), undefined);
  assert.equal(tenMinDailyRedispatchHold({ TENMIN_DAILY_ENABLED: "true" }), "SKIP_REDISPATCH_PAUSED:TENMIN_AUTO_REDISPATCH=unset");
});
