import assert from "node:assert/strict";
import test from "node:test";
import { strictPeacestocksRequireObjectStore } from "./tenmin-history";

test("strictPeacestocksRequireObjectStore: strict PEACESTOCKS_REQUIRE_OBJECT_STORE, fail closed", () => {
  assert.equal(strictPeacestocksRequireObjectStore(undefined), false);
  assert.equal(strictPeacestocksRequireObjectStore(""), false);
  assert.equal(strictPeacestocksRequireObjectStore("0"), false);
  assert.equal(strictPeacestocksRequireObjectStore("1"), true);
  for (const bad of ["true","yes","2","on"]) assert.throws(() => strictPeacestocksRequireObjectStore(bad), /PEACESTOCKS_REQUIRE_OBJECT_STORE_INVALID/, bad);
});
