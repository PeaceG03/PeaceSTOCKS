import assert from "node:assert/strict";
import test from "node:test";
import { isTenMinRangeAbortError } from "./tenmin-range-reply-dust";

test("abort errors", () => {
  assert.equal(isTenMinRangeAbortError("MASSIVE_CREDENTIAL_REJECTED"), true);
  assert.equal(isTenMinRangeAbortError("MASSIVE_API_KEY_MISSING"), true);
  assert.equal(isTenMinRangeAbortError("MASSIVE_HTTP_429"), true);
  assert.equal(isTenMinRangeAbortError("OBJECT_STORE_REQUIRED"), true);
  assert.equal(isTenMinRangeAbortError("OBJECT_STORE_REQUIRED:x"), false);
  assert.equal(isTenMinRangeAbortError("R2_PUT_FAILED"), true);
  assert.equal(isTenMinRangeAbortError("REPLY_DUST_ZSTD_FAILED"), true);
  assert.equal(isTenMinRangeAbortError("MASSIVE_HTTP_500"), false);
});
