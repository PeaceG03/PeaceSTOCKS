import assert from "node:assert/strict";
import test from "node:test";
import { silentParts } from "./health-silent-parts";

test("silentParts: the examples from the issue", () => {
  assert.deepEqual(silentParts([]), []);
  assert.deepEqual(silentParts([{ name: "r2", silent: true }]), ["r2"]);
  assert.deepEqual(silentParts([{ name: "r2", silent: false }]), []);
  assert.deepEqual(silentParts([{ name: "a", silent: true }, { name: "b", silent: false }, { name: "c", silent: true }]), ["a", "c"]);
  assert.deepEqual(silentParts([{ name: "x", silent: false }, { name: "y", silent: false }, { name: "z", silent: false }]), []);
  assert.deepEqual(silentParts([{ name: "p", silent: true }, { name: "q", silent: true }, { name: "s", silent: false }]), ["p", "q"]);
  assert.deepEqual(silentParts([{ name: "zeta", silent: true }, { name: "beta", silent: false }, { name: "alpha", silent: true }]), ["zeta", "alpha"]);
  assert.deepEqual(silentParts([{ name: "r2", silent: true }, { name: "bars", silent: true }, { name: "r2", silent: true }]), ["r2", "bars", "r2"]);
});
