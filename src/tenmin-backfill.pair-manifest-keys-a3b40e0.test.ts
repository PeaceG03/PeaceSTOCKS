import assert from "node:assert/strict";
import test from "node:test";
import { tenMinPairManifestKey } from "./tenmin-backfill";

test("pair manifest keys", () => {
  assert.equal(tenMinPairManifestKey("2024-10-15"), "permanent/tenmin-reply-dust/2024-09-01_2024-10-31/manifest.json");
  assert.equal(tenMinPairManifestKey("2024-01-01"), "permanent/tenmin-reply-dust/2024-01-01_2024-02-29/manifest.json");
  assert.throws(() => tenMinPairManifestKey("bad"), /INVALID_SESSION_DATE/);
});
