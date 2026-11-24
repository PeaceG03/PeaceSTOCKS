// Ticker resolution by date (symbolOn) and a reused ticker credited to whoever held it that day.
// Symbols here are made-up placeholders, not real tickers.
import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { pointInTimeUniverse, symbolOn } from "./pit-universe";

const sec = (over: Partial<SecurityMasterRecord>): SecurityMasterRecord =>
  ({ securityId: "id", currentSymbol: "T-CUR", assetType: "STOCK", status: "ACTIVE", providerIdentities: [{ provider: "massive", providerSecurityId: over.securityId ?? "id" }], ...over }) as unknown as SecurityMasterRecord;

test("symbolOn: no history -> today's symbol; the earliest entry is open to the past, the latest open to the future", () => {
  assert.equal(symbolOn(sec({}), "2019-01-01"), "T-CUR");
  const s = sec({ historicalSymbols: [
    { symbol: "T-OLD", effectiveFrom: "2020-01-01", effectiveTo: "2022-06-01" },
    { symbol: "T-NEW", effectiveFrom: "2022-06-01", effectiveTo: "2024-01-01" },
  ] } as Partial<SecurityMasterRecord>);
  assert.equal(symbolOn(s, "2019-01-01"), "T-OLD", "before the first entry: the first symbol");
  assert.equal(symbolOn(s, "2022-05-31"), "T-OLD");
  assert.equal(symbolOn(s, "2022-06-01"), "T-NEW", "effectiveTo is exclusive");
  assert.equal(symbolOn(s, "2025-03-03"), "T-NEW", "after the last entry: the last symbol, not today's");
});

test("symbolOn: in a gap the next symbol seen; overlapping entries -> the later one", () => {
  const gap = sec({ historicalSymbols: [
    { symbol: "T-A", effectiveFrom: "2020-01-01", effectiveTo: "2021-01-01" },
    { symbol: "T-B", effectiveFrom: "2021-06-01" },
  ] } as Partial<SecurityMasterRecord>);
  assert.equal(symbolOn(gap, "2021-03-01"), "T-B");
  assert.equal(symbolOn(gap, "2020-12-31"), "T-A");
  assert.equal(symbolOn(gap, "2021-01-01"), "T-B", "effectiveTo is exclusive even with nothing after it yet");
  const overlap = sec({ historicalSymbols: [
    { symbol: "T-A", effectiveFrom: "2020-01-01", effectiveTo: "2023-01-01" },
    { symbol: "T-B", effectiveFrom: "2022-01-01" },
  ] } as Partial<SecurityMasterRecord>);
  assert.equal(symbolOn(overlap, "2022-06-01"), "T-B");
});

test("a reused ticker goes to the company that held it on the date (rename history + delisting), never guessed", () => {
  const old = sec({ securityId: "old-co", status: "INACTIVE", currentSymbol: "T-REUSED", delistedAt: "2022-05-31" } as Partial<SecurityMasterRecord>);
  const renamed = sec({ securityId: "new-co", currentSymbol: "T-REUSED", listingDate: "2022-06-01" } as Partial<SecurityMasterRecord>);
  const before = pointInTimeUniverse([old, renamed], "2022-05-31", "massive");
  assert.equal(before.bySymbol.get("T-REUSED"), "old-co");
  assert.equal(before.ambiguousSymbols, 0);
  const after = pointInTimeUniverse([old, renamed], "2022-06-01", "massive");
  assert.equal(after.bySymbol.get("T-REUSED"), "new-co");
  // No dates at all (today's local master): one ACTIVE claim wins, as before; two INACTIVE are dropped.
  const undated = pointInTimeUniverse([sec({ securityId: "x1", status: "INACTIVE" }), sec({ securityId: "x2" })], "2021-01-04", "massive");
  assert.equal(undated.bySymbol.get("T-CUR"), "x2");
  const twoGone = pointInTimeUniverse([sec({ securityId: "x1", status: "INACTIVE" }), sec({ securityId: "x3", status: "INACTIVE" })], "2021-01-04", "massive");
  assert.equal(twoGone.bySymbol.has("T-CUR"), false);
  assert.equal(twoGone.ambiguousSymbols, 1);
});
