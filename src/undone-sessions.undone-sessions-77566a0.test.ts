import assert from "node:assert/strict";
import test from "node:test";
import { undoneSessions } from "./undone-sessions";

test("undoneSessions: the examples from the issue", () => {
  assert.deepEqual(undoneSessions([]), []);
  assert.deepEqual(undoneSessions([{ date: "2026-10-13", done: false }]), ["2026-10-13"]);
  assert.deepEqual(undoneSessions([{ date: "2026-10-13", done: true }]), []);
  assert.deepEqual(undoneSessions([{ date: "2026-10-13", done: true }, { date: "2026-10-14", done: false }, { date: "2026-10-15", done: false }]), ["2026-10-14", "2026-10-15"]);
  assert.deepEqual(undoneSessions([{ date: "2026-10-20", done: false }, { date: "2026-10-21", done: true }, { date: "2026-10-22", done: false }]), ["2026-10-20", "2026-10-22"]);
  assert.deepEqual(undoneSessions([{ date: "a", done: true }, { date: "b", done: true }, { date: "c", done: true }]), []);
  assert.deepEqual(undoneSessions([{ date: "z", done: false }, { date: "y", done: false }, { date: "x", done: true }]), ["z", "y"]);
});
