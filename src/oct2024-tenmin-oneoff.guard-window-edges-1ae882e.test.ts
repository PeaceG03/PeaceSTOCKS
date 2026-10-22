import assert from "node:assert/strict";
import test from "node:test";
import { oneOffPauseReason } from "./oct2024-tenmin-oneoff";

test("guard window edges", () => {
  assert.equal(oneOffPauseReason(new Date("2026-10-13T05:14:00Z"), []), undefined);
  assert.equal(oneOffPauseReason(new Date("2026-10-13T05:15:00Z"), []), "GUARD_WINDOW");
  assert.equal(oneOffPauseReason(new Date("2026-10-13T06:15:00Z"), []), undefined);
  assert.equal(oneOffPauseReason(new Date("2026-10-13T10:14:00Z"), []), "GUARD_WINDOW");
  assert.equal(oneOffPauseReason(new Date("2026-10-13T09:20:00Z"), { error: "http-403" }), "GUARD_WINDOW");
  assert.equal(oneOffPauseReason(new Date("2026-10-13T12:00:00Z"), [{ id: 3, status: "waiting", event: "schedule", display_title: "Scanner" }]), "ACTIVE_SCANNER_RUN");
});
