import assert from "node:assert/strict";
import test from "node:test";
import { disabledScanGroupedReplyDustReport } from "./scan-grouped-reply-dust";

test("disabled report", () => {
  assert.deepEqual(disabledScanGroupedReplyDustReport("SCAN_GROUPED_REPLY_DUST_OFF"), { enabled: false, reason: "SCAN_GROUPED_REPLY_DUST_OFF", extraMassiveRequests: 0, copies: [], warnings: [] });
  assert.deepEqual(disabledScanGroupedReplyDustReport(""), { enabled: false, reason: "", extraMassiveRequests: 0, copies: [], warnings: [] });
});
