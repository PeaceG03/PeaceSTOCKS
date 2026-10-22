import assert from "node:assert/strict";
import test from "node:test";
import { dailyReplyDustHashedFileKey } from "./daily-reply-dust";

test("hashed file keys", () => {
  assert.equal(dailyReplyDustHashedFileKey("2026-10-13", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), "permanent/daily-reply-dust/2026-10-13/grouped-daily-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.rdust");
  assert.throws(() => dailyReplyDustHashedFileKey("2026-10-13", "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"), /INVALID_REPLY_SHA256/);
  assert.throws(() => dailyReplyDustHashedFileKey("2026-10-13", "abc"), /INVALID_REPLY_SHA256/);
  assert.throws(() => dailyReplyDustHashedFileKey("2026-10-1", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), /INVALID_SESSION_DATE/);
});
