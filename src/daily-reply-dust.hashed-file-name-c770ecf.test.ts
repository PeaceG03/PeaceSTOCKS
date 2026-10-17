import assert from "node:assert/strict";
import test from "node:test";
import { dailyReplyDustHashedFileName } from "./daily-reply-dust";

test("hashed file name", () => {
  assert.equal(dailyReplyDustHashedFileName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "grouped-daily-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.rdust");
  assert.throws(() => dailyReplyDustHashedFileName("ABC"), /INVALID_REPLY_SHA256/);
});
