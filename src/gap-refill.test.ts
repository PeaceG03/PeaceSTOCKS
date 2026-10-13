import assert from "node:assert/strict";
import test from "node:test";
import { inRefillGuard, netFreezeVerdict, refillPauseReason } from "./gap-refill";

test("frozen config: missing/empty/unreadable/no commit refuse; present + committed passes", () => {
  const b64 = Buffer.from("8d96  frozen.json\n").toString("base64");
  assert.deepEqual(netFreezeVerdict(200, b64, "abc"), { ok: true, commit: "abc" });
  assert.equal(netFreezeVerdict(404, undefined, undefined).ok, false);
  assert.equal(netFreezeVerdict(403, undefined, undefined).ok, false);
  assert.equal(netFreezeVerdict(200, Buffer.from("  \n").toString("base64"), "abc").ok, false);
  assert.equal(netFreezeVerdict(200, b64, undefined).ok, false);
});

test("pause: guard windows (3 min lead), active non-idle scanner run, failed check; restarter runs are idle", () => {
  const t = (h: number, m: number) => new Date(Date.UTC(2026, 9, 13, h, m));
  assert.equal(inRefillGuard(t(5, 12)), true); assert.equal(inRefillGuard(t(5, 11)), false); assert.equal(inRefillGuard(t(10, 15)), false);
  assert.equal(refillPauseReason(t(12, 0), [{ status: "in_progress", display_title: "Scanner" }]), "ACTIVE_SCANNER_RUN");
  assert.equal(refillPauseReason(t(12, 0), [{ status: "in_progress", display_title: "Scanner restarter" }]), undefined);
  assert.equal(refillPauseReason(t(12, 0), [{ status: "completed", display_title: "Scanner" }]), undefined);
  assert.equal(refillPauseReason(t(12, 0), { error: "http-500" }), "RUNS_CHECK_FAILED");
  assert.equal(refillPauseReason(t(5, 30), []), "GUARD_WINDOW");
});

import { MemoryObjectClient } from "./object-store";
import { GuardedClient } from "./gap-refill-lib";
test("write guard: never deletes, never replaces an unrelated stored object, skips identical rewrites, adds new keys", async () => {
  const enc = new TextEncoder();
  const inner = new MemoryObjectClient();
  await inner.put("permanent/other.json", enc.encode("a"));
  const g = new GuardedClient(inner, new Set(["2024-10-14"]));
  await assert.rejects(g.delete("permanent/other.json"), /REFILL_GUARD_REFUSED:delete/u);
  await assert.rejects(g.put("permanent/other.json", enc.encode("b")), /REFILL_GUARD_REFUSED/u);
  await g.put("permanent/other.json", enc.encode("a"));
  assert.deepEqual(g.skippedIdentical, ["permanent/other.json"]);
  await g.put("permanent/new.json", enc.encode("n"));
  assert.deepEqual(g.puts, ["permanent/new.json"]);
  assert.equal(new TextDecoder().decode(await inner.get("permanent/other.json")), "a");
});

import { asOfVerdict } from "./gap-refill";
test("as-of readiness: a trading day needs its Dust stored; a closed day passes", () => {
  assert.equal(asOfVerdict("NORMAL", false), "ASOF_NOT_STORED");
  assert.equal(asOfVerdict("NORMAL", true), "PASS");
  assert.equal(asOfVerdict("EARLY_CLOSE", false), "ASOF_NOT_STORED");
  assert.equal(asOfVerdict("CLOSED", false), "PASS");
});
