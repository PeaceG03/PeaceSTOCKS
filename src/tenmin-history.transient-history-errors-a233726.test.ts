import assert from "node:assert/strict";
import test from "node:test";
import { isTransientHistoryError } from "./tenmin-history";

test("transient history errors", () => {
  assert.equal(isTransientHistoryError("socket hang up"), true);
  assert.equal(isTransientHistoryError("HTTP 503 Service Unavailable"), true);
  assert.equal(isTransientHistoryError("upstream returned 502"), true);
  assert.equal(isTransientHistoryError("Request timed out"), true);
  assert.equal(isTransientHistoryError("ENOTFOUND api.example"), true);
  assert.equal(isTransientHistoryError("UND_ERR_CONNECT_TIMEOUT"), true);
  assert.equal(isTransientHistoryError("HTTP 404"), false);
  assert.equal(isTransientHistoryError("status 5020"), false);
});
