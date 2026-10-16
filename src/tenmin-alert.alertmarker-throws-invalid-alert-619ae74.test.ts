import assert from "node:assert/strict";
import test from "node:test";
import { alertMarker } from "./tenmin-alert";

test("alertMarker throws INVALID_ALERT_KEY", () => {
  assert.throws(() => alertMarker(""), /INVALID_ALERT_KEY/);
  assert.equal(alertMarker("tenmin").length, 34);
});
