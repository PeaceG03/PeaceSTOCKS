import assert from "node:assert/strict";
import test from "node:test";
import { incompleteNames } from "./incomplete-names";

test("incompleteNames: the examples from the issue", () => {
  assert.deepEqual(incompleteNames([]), []);
  assert.deepEqual(incompleteNames([{ securityId: "a", complete: true }]), []);
  assert.deepEqual(incompleteNames([{ securityId: "a", complete: false }]), ["a"]);
  assert.deepEqual(incompleteNames([{ securityId: "a", complete: true }, { securityId: "b", complete: false }, { securityId: "c", complete: true }]), ["b"]);
  assert.deepEqual(incompleteNames([{ securityId: "a", complete: true }, { securityId: "b", complete: true }, { securityId: "c", complete: true }]), []);
  assert.deepEqual(incompleteNames([{ securityId: "x", complete: false }, { securityId: "y", complete: false }, { securityId: "z", complete: true }]), ["x", "y"]);
});
