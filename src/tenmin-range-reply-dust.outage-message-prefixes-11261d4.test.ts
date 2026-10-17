import assert from "node:assert/strict";
import test from "node:test";
import { isTenMinRangeOutageError } from "./tenmin-range-reply-dust";

test("outage message prefixes", () => {
  assert.equal(isTenMinRangeOutageError("MASSIVE_HTTP_503 upstream unavailable"), true);
  assert.equal(isTenMinRangeOutageError("MASSIVE_HTTP_500"), true);
  assert.equal(isTenMinRangeOutageError("MASSIVE_NETWORK connection reset"), true);
  assert.equal(isTenMinRangeOutageError("MASSIVE_HTTP_404 not found"), false);
  assert.equal(isTenMinRangeOutageError("MASSIVE_HTTP_5000"), false);
});
