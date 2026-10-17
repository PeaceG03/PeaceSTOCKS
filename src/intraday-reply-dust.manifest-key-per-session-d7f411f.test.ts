import assert from "node:assert/strict";
import test from "node:test";
import { replyDustManifestKey } from "./intraday-reply-dust";

test("manifest key per session", () => {
  assert.equal(replyDustManifestKey("2026-01-05"), "permanent/intraday-reply-dust/2026-01-05/manifest.json");
  assert.throws(() => replyDustManifestKey("bad"), /INVALID_SESSION_DATE/);
});
