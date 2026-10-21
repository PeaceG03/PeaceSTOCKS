import assert from "node:assert/strict";
import test from "node:test";
import { tenMinDailyIndexKey } from "./tenmin-daily-liquid";

test("daily index keys", () => {
  assert.equal(tenMinDailyIndexKey("2024-01-15"), "permanent/tenmin-reply-dust/2024-01-01_2024-02-29/daily/2024-01-15.json");
  assert.throws(() => tenMinDailyIndexKey("2024-1-15"), /INVALID_SESSION_DATE/);
});
