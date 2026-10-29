import assert from "node:assert/strict";
import test from "node:test";
import { attentionParts } from "./health-attention-parts";

test("attentionParts: the examples from the issue", () => {
  assert.deepEqual(attentionParts([]), []);
  assert.deepEqual(attentionParts([{ name: "r2", attention: true }]), ["r2"]);
  assert.deepEqual(attentionParts([{ name: "r2", attention: false }]), []);
  assert.deepEqual(attentionParts([{ name: "a", attention: true }, { name: "b", attention: false }, { name: "c", attention: true }]), ["a", "c"]);
  assert.deepEqual(attentionParts([{ name: "x", attention: false }, { name: "y", attention: false }, { name: "z", attention: false }]), []);
  assert.deepEqual(attentionParts([{ name: "p", attention: true }, { name: "q", attention: true }, { name: "s", attention: false }]), ["p", "q"]);
  assert.deepEqual(attentionParts([{ name: "zeta", attention: true }, { name: "beta", attention: false }, { name: "alpha", attention: true }]), ["zeta", "alpha"]);
  assert.deepEqual(attentionParts([{ name: "r2", attention: true }, { name: "bars", attention: true }, { name: "r2", attention: true }]), ["r2", "bars", "r2"]);
});
