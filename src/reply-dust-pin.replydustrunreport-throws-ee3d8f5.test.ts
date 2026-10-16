import assert from "node:assert/strict";
import test from "node:test";
import { replyDustRunReport } from "./reply-dust-pin";

test("replyDustRunReport throws INVALID_REPLY_DUST_COUNTS", () => {
  assert.throws(() => replyDustRunReport(1, 2, "1.5.6"), /INVALID_REPLY_DUST_COUNTS/);
  assert.equal(replyDustRunReport(2, 0, "1.5.6").replyDustFilesWritten, 2);
});
