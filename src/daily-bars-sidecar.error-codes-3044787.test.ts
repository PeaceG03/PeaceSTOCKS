import assert from "node:assert/strict";
import test from "node:test";
import { errorCode } from "./daily-bars-sidecar";

test("error codes", () => {
  assert.equal(errorCode("DAILY_SIDECAR_MISSING: x"), "DAILY_SIDECAR_MISSING");
  assert.equal(errorCode("A1_B2 tail"), "A1_B2");
  assert.equal(errorCode("lowercase message"), "UNKNOWN");
  assert.equal(errorCode(""), "UNKNOWN");
  assert.equal(errorCode(42), "UNKNOWN");
  assert.equal(errorCode({ message: "BAD_CODE" }), "UNKNOWN");
  assert.equal(errorCode("9LIVES"), "UNKNOWN");
});
