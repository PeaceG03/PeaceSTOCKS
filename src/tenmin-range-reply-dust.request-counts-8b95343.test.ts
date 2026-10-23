import assert from "node:assert/strict";
import test from "node:test";
import { tenMinMassiveRequestsOf } from "./tenmin-range-reply-dust";

test("request counts", () => {
  assert.equal(tenMinMassiveRequestsOf({ tenMinMassiveRequests: 3 }), 3);
  assert.equal(tenMinMassiveRequestsOf({ tenMinMassiveRequests: 0 }), 0);
  assert.equal(tenMinMassiveRequestsOf({ tenMinMassiveRequests: -2 }), 0);
  assert.equal(tenMinMassiveRequestsOf({ tenMinMassiveRequests: 1.5 }), 0);
  assert.equal(tenMinMassiveRequestsOf({ tenMinMassiveRequests: "4" }), 0);
  assert.equal(tenMinMassiveRequestsOf(null), 0);
  assert.equal(tenMinMassiveRequestsOf("boom"), 0);
});
