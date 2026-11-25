import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { excludedTickerDateKeys } from "./pit-universe";
import { loadResearchData } from "./research-harness-cli";
import { buildHarnessSession, openToNextOpen } from "./research-harness-data";

function rec(overrides: Partial<SecurityMasterRecord> & { securityId: string; currentSymbol: string; status: "ACTIVE" | "INACTIVE" }): SecurityMasterRecord {
  return {
    historicalSymbols: [],
    providerIdentities: [{ provider: "massive-stocks", providerSecurityId: `figi:${overrides.securityId}` }],
    assetType: "STOCK",
    country: "US",
    exchange: "XNAS",
    tradable: overrides.status === "ACTIVE",
    eligibility: "LEVEL_3",
    barCount: 0,
    firstSeenAt: "2024-01-01",
    lastUniverseSeenAt: "2026-11-25",
    ...(overrides.status === "INACTIVE" ? { inactiveAt: "2026-11-01" } : {}),
    ...overrides,
  };
}

const DAYS = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"];

test("research loader excludes both sides of a ticker-date collision and leaves other dates alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-ticker-coll-"));
  try {
    mkdirSync(join(root, "permanent/daily-bars"), { recursive: true });
    const master: SecurityMasterRecord[] = [
      rec({ securityId: "sec_active_AAA", currentSymbol: "AAA", status: "ACTIVE" }),
      rec({
        securityId: "sec_inactive_OLD",
        currentSymbol: "REU",
        status: "INACTIVE",
        inactiveAt: "2026-10-14",
        historicalSymbols: [{ symbol: "REU", effectiveFrom: "2024-01-01", source: "massive-stocks" }],
      }),
      rec({
        securityId: "sec_inactive_NEW",
        currentSymbol: "REU",
        status: "INACTIVE",
        listingDate: "2026-10-15",
        inactiveAt: "2026-11-01",
        historicalSymbols: [{ symbol: "REU", effectiveFrom: "2026-10-15", source: "massive-stocks" }],
      }),
    ];
    writeFileSync(join(root, "permanent/security-master.json"), `${JSON.stringify(master)}\n`);
    writeFileSync(join(root, "permanent/corporate-actions.jsonl"), "");
    const rows = DAYS.flatMap((sessionDate, k) =>
      ["sec_active_AAA", "sec_inactive_OLD"].map((securityId, n) => ({
        securityId,
        sessionDate,
        open: 10 + k + n,
        close: 10 + k + n,
        volume: 1_000_000,
        revision: 1,
      })),
    );
    writeFileSync(join(root, "permanent/daily-bars/2026-10.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const loaded = await loadResearchData(root, "2026-10-14", "2026-10-21", 1);
    // On 2026-10-14 OLD is still a PIT member and NEW is not yet listed: no collision.
    // From 2026-10-15 on, stored OLD uses currentSymbol fallback and NEW is the PIT member: both sides drop.
    assert.ok(loaded.history.bar("sec_inactive_OLD", "2026-10-14"));
    assert.ok(loaded.history.bar("sec_active_AAA", "2026-10-14"));
    for (const date of ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]) {
      assert.equal(loaded.history.bar("sec_inactive_OLD", date), undefined, date);
      assert.equal(loaded.history.bar("sec_inactive_NEW", date), undefined, date);
      assert.ok(loaded.history.bar("sec_active_AAA", date), date);
    }
    assert.equal(loaded.tickerDateCollisions.collidingTickerDates, 4);
    assert.equal(loaded.tickerDateCollisions.excludedSecurityDates, 8);
    assert.equal(loaded.tickerDateCollisions.excludedBars, 4);
    const serialized = JSON.stringify(loaded.tickerDateCollisions);
    for (const forbidden of ["sec_inactive_OLD", "sec_inactive_NEW", "REU", "AAA"]) {
      assert.ok(!serialized.includes(forbidden), `collision summary leaked ${forbidden}`);
    }

    const i = loaded.history.sessions.indexOf("2026-10-14");
    assert.ok(i >= 0);
    // Outcome from 2026-10-14 uses opens on 2026-10-15 and 2026-10-16; the colliding entry bar is gone.
    assert.equal(openToNextOpen(loaded.history, "sec_inactive_OLD", i), undefined);
    assert.ok(openToNextOpen(loaded.history, "sec_active_AAA", i) !== undefined);

    const sessionI = loaded.history.sessions.indexOf("2026-10-15");
    assert.ok(sessionI >= 0);
    const session = buildHarnessSession(master, loaded.history, sessionI, { splitActions: [] });
    assert.ok(session);
    const ids = Object.values(session.session.lists).flatMap((list) => list.ids);
    assert.ok(!ids.includes("sec_inactive_OLD"));
    assert.ok(!ids.includes("sec_inactive_NEW"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("excludedTickerDateKeys: currentSymbol fallback only applies to stored bars, not to a later listing on earlier dates", () => {
  const master: SecurityMasterRecord[] = [
    rec({
      securityId: "sec_inactive_OLD",
      currentSymbol: "REU",
      status: "INACTIVE",
      inactiveAt: "2026-10-14",
      historicalSymbols: [{ symbol: "REU", effectiveFrom: "2024-01-01", source: "massive-stocks" }],
    }),
    rec({
      securityId: "sec_inactive_NEW",
      currentSymbol: "REU",
      status: "INACTIVE",
      listingDate: "2026-10-15",
      inactiveAt: "2026-11-01",
      historicalSymbols: [{ symbol: "REU", effectiveFrom: "2026-10-15", source: "massive-stocks" }],
    }),
  ];
  const bars = new Set(["sec_inactive_OLD|2026-10-14", "sec_inactive_OLD|2026-10-15"]);
  const hasBar = (id: string, date: string) => bars.has(`${id}|${date}`);
  const got = excludedTickerDateKeys(master, hasBar, ["2026-10-14", "2026-10-15"]);
  assert.equal(got.collidingTickerDates, 1);
  assert.ok(got.keys.has("sec_inactive_OLD|2026-10-15"));
  assert.ok(got.keys.has("sec_inactive_NEW|2026-10-15"));
  assert.ok(!got.keys.has("sec_inactive_OLD|2026-10-14"));
  assert.ok(!got.keys.has("sec_inactive_NEW|2026-10-14"));
});
