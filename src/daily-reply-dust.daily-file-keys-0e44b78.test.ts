import assert from "node:assert/strict";
import test from "node:test";
import { dailyReplyDustFileKey } from "./daily-reply-dust";

test("daily file keys", () => {
  assert.equal(dailyReplyDustFileKey("2026-10-13"), "permanent/daily-reply-dust/2026-10-13/grouped-daily.rdust");
  assert.throws(() => dailyReplyDustFileKey("2026-10-1"), /INVALID_SESSION_DATE/);
});
