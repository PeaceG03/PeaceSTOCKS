import assert from "node:assert/strict";
import test from "node:test";
import { datedTickerPageFileName } from "./ticker-reference-dated";

test("page file names", () => {
  assert.equal(datedTickerPageFileName(1), "page-001.rdust");
  assert.equal(datedTickerPageFileName(42), "page-042.rdust");
  assert.equal(datedTickerPageFileName(1000), "page-1000.rdust");
  assert.throws(() => datedTickerPageFileName(0), /INVALID_DATED_TICKER_PAGE/);
});
