import assert from "node:assert/strict";
import test from "node:test";
import { tenMinRangeGapReason } from "./tenmin-range-reply-dust";

test("gap reason codes", () => {
  assert.equal(tenMinRangeGapReason(""), "TENMIN_RANGE_FETCH_FAILED");
  assert.equal(tenMinRangeGapReason("A"), "TENMIN_RANGE_FETCH_FAILED");
  assert.equal(tenMinRangeGapReason("AB"), "AB");
  assert.equal(tenMinRangeGapReason("a_CODE"), "TENMIN_RANGE_FETCH_FAILED");
  assert.equal(tenMinRangeGapReason("MASSIVE_NETWORK:ECONNRESET"), "MASSIVE_NETWORK");
});
