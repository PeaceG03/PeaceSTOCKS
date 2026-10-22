import assert from "node:assert/strict";
import test from "node:test";
import { replyDustObjectMetadata } from "./intraday-reply-dust";

test("object metadata", () => {
  assert.deepEqual(replyDustObjectMetadata("massive-stocks", "2026-10-13", { securityId: "sec_a", symbol: "AAA", dataset: "stocks-aggregates-10m", request: "/v2/aggs/x", fetchedAt: "2026-10-13T21:00:00Z", observedAt: "2026-10-13T21:00:01Z", relativePath: "a.rdust", byteLength: 10, version: 1, replySha256: "ab", replyByteLength: 20, fileSha256: "cd" }), { "rd-schema": "intraday-reply-dust-object-v1", "rd-provider": "massive-stocks", "rd-session-date": "2026-10-13", "rd-security-id": "sec_a", "rd-symbol": "AAA", "rd-request": "/v2/aggs/x", "rd-fetched-at": "2026-10-13T21:00:00Z", "rd-observed-at": "2026-10-13T21:00:01Z", "rd-version": "1", "rd-reply-sha256": "ab", "rd-reply-length": "20" });
});
