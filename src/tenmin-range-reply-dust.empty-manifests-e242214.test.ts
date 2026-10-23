import assert from "node:assert/strict";
import test from "node:test";
import { isEmptyTenMinRangeManifest } from "./tenmin-range-reply-dust";

test("empty manifests", () => {
  assert.equal(isEmptyTenMinRangeManifest({ schemaVersion: "tenmin-range-reply-dust-manifest-v2", format: "REPLY_DUST_V1_ZSTD19_DICT4K", provider: "p", rangeFrom: "2024-11-01", rangeTo: "2024-12-31", securityCount: 0, fileCount: 0, fallbackFileCount: 0, securities: [], days: [], gaps: [], checksum: "c" }), true);
  assert.equal(isEmptyTenMinRangeManifest({ schemaVersion: "tenmin-range-reply-dust-manifest-v2", format: "REPLY_DUST_V1_ZSTD19_DICT4K", provider: "p", rangeFrom: "2024-11-01", rangeTo: "2024-12-31", securityCount: 2, fileCount: 0, fallbackFileCount: 0, securities: [], days: [], gaps: [], checksum: "c" }), true);
  assert.equal(isEmptyTenMinRangeManifest({ schemaVersion: "tenmin-range-reply-dust-manifest-v2", format: "REPLY_DUST_V1_ZSTD19_DICT4K", provider: "p", rangeFrom: "2024-11-01", rangeTo: "2024-12-31", securityCount: 1, fileCount: 0, fallbackFileCount: 0, securities: [{ securityId: "s", dataset: "stocks-aggregates-10m", fetches: [], sessionDates: [] }], days: [], gaps: [], checksum: "c" }), false);
});
