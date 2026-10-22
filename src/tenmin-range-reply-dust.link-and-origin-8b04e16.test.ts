import assert from "node:assert/strict";
import test from "node:test";
import { tenMinRangeObjectMetadata } from "./tenmin-range-reply-dust";

test("link and origin", () => {
  assert.throws(() => tenMinRangeObjectMetadata({ provider: "p", calendarFrom: "2024-11-01", calendarTo: "2024-12-31", securityId: "s", symbol: "S", fetchFrom: "2024-11-01", fetchTo: "2024-12-31", observedAt: "t", pageCount: 2, file: { page: 1, request: "/r", fetchedAt: "f", version: 1, replySha256: "h", replyByteLength: 9 }, link: "Bad" }), /TENMIN_RANGE_LINK_INVALID/);
  assert.throws(() => tenMinRangeObjectMetadata({ provider: "p", calendarFrom: "2024-11-01", calendarTo: "2024-12-31", securityId: "s", symbol: "S", fetchFrom: "2024-11-01", fetchTo: "2024-12-31", observedAt: "t", pageCount: 2, file: { page: 1, request: "/r", fetchedAt: "f", version: 1, replySha256: "h", replyByteLength: 9 }, origin: "-x" }), /TENMIN_RANGE_ORIGIN_INVALID/);
  assert.deepEqual(tenMinRangeObjectMetadata({ provider: "p", calendarFrom: "2024-11-01", calendarTo: "2024-12-31", securityId: "s", symbol: "S", fetchFrom: "2024-11-01", fetchTo: "2024-12-31", observedAt: "t", pageCount: 2, file: { page: 1, request: "/r", fetchedAt: "f", version: 1, replySha256: "h", replyByteLength: 9 }, link: "m-1", origin: "daily-close" }), { "rd-schema": "tenmin-range-reply-dust-object-v2", "rd-provider": "p", "rd-security-id": "s", "rd-symbol": "S", "rd-request": "/r", "rd-fetched-at": "f", "rd-observed-at": "t", "rd-version": "1", "rd-reply-length": "9", "rd-reply-sha256": "h", "rd-range-from": "2024-11-01", "rd-range-to": "2024-12-31", "rd-fetch-from": "2024-11-01", "rd-fetch-to": "2024-12-31", "rd-page": "1", "rd-page-count": "2", "rd-link": "m-1", "rd-origin": "daily-close" });
});
