import assert from "node:assert/strict";
import test from "node:test";
import { r2RequestFailure } from "./r2-request-failure";

test("r2RequestFailure: the examples from the issue", () => {
  assert.equal(r2RequestFailure("GET", "fetch failed"), "R2_REQUEST_FAILED:GET:fetch failed");
  assert.equal(r2RequestFailure("PUT", "fetch failed"), "R2_REQUEST_FAILED:PUT:fetch failed");
  assert.equal(r2RequestFailure("HEAD", "The operation was aborted due to timeout"), "R2_REQUEST_FAILED:HEAD:The operation was aborted due to timeout");
  assert.equal(r2RequestFailure("DELETE", "x"), "R2_REQUEST_FAILED:DELETE:x");
  assert.equal(r2RequestFailure("", ""), "R2_REQUEST_FAILED::");
  assert.equal(r2RequestFailure(" x 1. ", " Ab 2. "), "R2_REQUEST_FAILED: x 1. : Ab 2. ");
});
