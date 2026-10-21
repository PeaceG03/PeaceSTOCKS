import assert from "node:assert/strict";
import test from "node:test";
import { inRefillGuard } from "./gap-refill";

test("refill guard edges", () => {
  assert.equal(inRefillGuard(new Date("2026-10-13T09:12:00Z")), true);
  assert.equal(inRefillGuard(new Date("2026-10-13T09:11:00Z")), false);
  assert.equal(inRefillGuard(new Date("2026-10-13T06:14:00Z")), true);
  assert.equal(inRefillGuard(new Date("2026-10-13T06:15:00Z")), false);
  assert.equal(inRefillGuard(new Date("2026-10-13T10:14:00Z")), true);
});
