import assert from "node:assert/strict";
import test from "node:test";
import { replyDustFileName } from "./intraday-reply-dust";

test("replyDustFileName throws INVALID_SECURITY_ID", () => {
  assert.throws(() => replyDustFileName(' '), /INVALID_SECURITY_ID/);
  assert.equal(replyDustFileName('AAPL'), 'QUFQTA.rdust');
});
