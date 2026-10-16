import assert from "node:assert/strict";
import test from "node:test";
import { alertMarker } from "./tenmin-alert";

test("alertMarker throws ALERT_KEY_CLOSES_COMMENT", () => {
  assert.throws(() => alertMarker("a-->b"), /ALERT_KEY_CLOSES_COMMENT/);
  assert.equal(alertMarker("111:STOP_DONE").length, 41);
});
