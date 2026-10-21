import assert from "node:assert/strict";
import test from "node:test";
import { lastOutcomeFromRecord } from "./tenmin-mode";

test("refused outcomes", () => {
  assert.equal(lastOutcomeFromRecord("STOP_REFUSAL:TENMIN_UNIVERSE_EMPTY", "success"), "refused");
  assert.equal(lastOutcomeFromRecord("STOP_BOUNDED_MANUAL_RUN", "success"), "refused");
  assert.equal(lastOutcomeFromRecord("HTTP 429", "failure"), "rate_limited");
  assert.equal(lastOutcomeFromRecord(undefined, "failure"), "failed");
  assert.equal(lastOutcomeFromRecord("CONTINUE", undefined), "ok");
});
