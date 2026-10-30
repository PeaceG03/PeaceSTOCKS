import assert from "node:assert/strict";
import test from "node:test";
import { hostFailureCauseLine } from "./host-failure-cause-line";

test("hostFailureCauseLine: the examples from the issue", () => {
  assert.equal(hostFailureCauseLine("fetch failed", "ETIMEDOUT"), "MARKETS_SCHEDULER_HOST_FAILED:fetch failed:cause=ETIMEDOUT");
  assert.equal(hostFailureCauseLine("fetch failed", "UND_ERR_SOCKET"), "MARKETS_SCHEDULER_HOST_FAILED:fetch failed:cause=UND_ERR_SOCKET");
  assert.equal(hostFailureCauseLine("R2_GET_503", "ECONNRESET"), "MARKETS_SCHEDULER_HOST_FAILED:R2_GET_503:cause=ECONNRESET");
  assert.equal(hostFailureCauseLine(" Read 2 failed. ", "x"), "MARKETS_SCHEDULER_HOST_FAILED: Read 2 failed. :cause=x");
  assert.equal(hostFailureCauseLine("", "ECONNRESET"), "MARKETS_SCHEDULER_HOST_FAILED::cause=ECONNRESET");
  assert.equal(hostFailureCauseLine("boom", " Ab 1. "), "MARKETS_SCHEDULER_HOST_FAILED:boom:cause= Ab 1. ");
  assert.equal(hostFailureCauseLine("boom", ""), "MARKETS_SCHEDULER_HOST_FAILED:boom:cause=");
});
