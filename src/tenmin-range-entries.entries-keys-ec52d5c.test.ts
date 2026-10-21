import assert from "node:assert/strict";
import test from "node:test";
import { tenMinRangeEntriesObjectKey } from "./tenmin-range-entries";

test("entries keys", () => {
  assert.equal(tenMinRangeEntriesObjectKey("2024-09-01", "2024-10-31", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "permanent/tenmin-reply-dust/2024-09-01_2024-10-31/entries-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin.zst");
  assert.throws(() => tenMinRangeEntriesObjectKey("2024-09-01", "2024-10-31", "ABC"), /INVALID_ENTRIES_SHA256/);
  assert.throws(() => tenMinRangeEntriesObjectKey("2024-10-31", "2024-09-01", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), /INVALID_RANGE/);
});
