import assert from "node:assert/strict";
import test from "node:test";
import { scanGroupedReplyDustEnabled } from "./scan-grouped-reply-dust";

test("flag whitespace", () => {
  assert.equal(scanGroupedReplyDustEnabled({ SCAN_GROUPED_REPLY_DUST: "true", TICKER_INDEX_DATED: "false" }), true);
  assert.equal(scanGroupedReplyDustEnabled({ SCAN_GROUPED_REPLY_DUST: " true" }), false);
  assert.equal(scanGroupedReplyDustEnabled({ SCAN_GROUPED_REPLY_DUST: "true " }), false);
  assert.equal(scanGroupedReplyDustEnabled({ TICKER_INDEX_DATED: "true" }), false);
  assert.equal(scanGroupedReplyDustEnabled({}), false);
});
