import assert from "node:assert/strict";
import test from "node:test";
import { isTransientFailure } from "./tenmin-redispatch";

test("transient reasons", () => {
  assert.equal(isTransientFailure("success", "STOP_ERROR:HTTP 503"), true);
  assert.equal(isTransientFailure("success", "STOP_ERROR:ETIMEDOUT"), true);
  assert.equal(isTransientFailure("success", "STOP_ERROR:HTTP 404"), false);
  assert.equal(isTransientFailure("failure", "SCAN_CANCELLED"), false);
  assert.equal(isTransientFailure("failure", "KILL_SWITCH off"), false);
});
