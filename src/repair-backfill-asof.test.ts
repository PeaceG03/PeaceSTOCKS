import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ObjectClient, ObjectHead, ObjectMetadata } from "./object-store";
import {
  listTickerReferenceIndexHistory,
  loadTickerReferenceIndex,
  writeTickerReferenceIndex,
  type TickerReferenceCapture,
  type TickerReferenceEntry,
} from "./ticker-reference-index";
import { formatRepairSummary, repairBackfillAsOf } from "./repair-backfill-asof";
import type { SecurityMasterRecord } from "./contracts";

class MemoryObjectStore implements ObjectClient {
  readonly objects = new Map<string, { body: Uint8Array; etag: string; metadata: ObjectMetadata }>();
  private seq = 0;
  puts = 0;
  deletes = 0;
  onBeforePutIfMatch?: ((key: string, store: MemoryObjectStore) => void) | undefined;

  async get(key: string): Promise<Uint8Array | undefined> {
    const entry = this.objects.get(key);
    return entry ? new Uint8Array(entry.body) : undefined;
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}): Promise<void> {
    this.puts += 1;
    this.seq += 1;
    this.objects.set(key, { body: new Uint8Array(body), etag: `"etag-${this.seq}"`, metadata: { ...metadata } });
  }

  async putIfAbsent(key: string, body: Uint8Array): Promise<boolean> {
    if (this.objects.has(key)) return false;
    await this.put(key, body);
    return true;
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    const entry = this.objects.get(key);
    return entry ? { size: entry.body.byteLength, metadata: { ...entry.metadata } } : undefined;
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async getWithEtag(key: string): Promise<{ body: Uint8Array; etag: string } | undefined> {
    const entry = this.objects.get(key);
    return entry ? { body: new Uint8Array(entry.body), etag: entry.etag } : undefined;
  }

  async putIfMatch(key: string, body: Uint8Array, etag: string): Promise<boolean> {
    this.onBeforePutIfMatch?.(key, this);
    const entry = this.objects.get(key);
    if (!entry || entry.etag !== etag) return false;
    await this.put(key, body, entry.metadata);
    return true;
  }

  resetCounters(): void {
    this.puts = 0;
    this.deletes = 0;
  }
}

function makeIdxEntry(pass: "active" | "inactive", position: number, ticker: string, figi: string, active: boolean): TickerReferenceEntry {
  const payload = { ticker, composite_figi: figi, active, market: "stocks", locale: "us" };
  return {
    pass,
    page: 1,
    position,
    raw: JSON.stringify(payload),
    ticker,
    composite_figi: figi,
    active,
  };
}

function makeSecurity(overrides: Partial<SecurityMasterRecord> & Pick<SecurityMasterRecord, "securityId" | "currentSymbol">): SecurityMasterRecord {
  const figi = overrides.securityId.replace(/^figi:/u, "");
  return {
    exchange: "XNAS",
    country: "US",
    assetType: "STOCK",
    status: "ACTIVE",
    eligibility: "LEVEL_0",
    tradable: true,
    barCount: 0,
    firstSeenAt: "2024-01-02",
    lastUniverseSeenAt: "2026-11-24",
    historicalSymbols: [{ symbol: overrides.currentSymbol, effectiveFrom: "2024-01-02", source: "massive" }],
    providerIdentities: [{ provider: "massive", providerSecurityId: figi }],
    ...overrides,
  };
}

async function seedPostScanFixture(store: MemoryObjectStore) {
  // 1. Morning 2026-11-24 index
  const morningCapture: TickerReferenceCapture = {
    pages: { active: 1, inactive: 1 },
    entries: [
      makeIdxEntry("active", 0, "SYNDELIST", "FIGIDELIST", true),
      makeIdxEntry("active", 1, "SYNOUT", "FIGIOUT", true),
      makeIdxEntry("active", 2, "SYNOLD", "FIGIRENAME", true),
      makeIdxEntry("active", 3, "SYNRB1", "FIGIRB1", true),
      makeIdxEntry("inactive", 0, "SYNRB2", "FIGIRB2", false),
    ],
  };
  await writeTickerReferenceIndex(store, morningCapture, { provider: "massive", asOf: "2026-11-24" });

  // 2. Aborted 2025-05-13 index (captures 23 new, 1 delisted, 1 renamed, omits SYNOUT, keeps SYNRB1, omits SYNRB2)
  const addEntries = Array.from({ length: 23 }, (_, i) =>
    makeIdxEntry("active", i + 2, `SYNADD${String(i + 1).padStart(2, "0")}`, `FIGIADD${String(i + 1).padStart(2, "0")}`, true),
  );
  const badCapture: TickerReferenceCapture = {
    pages: { active: 1, inactive: 1 },
    entries: [
      makeIdxEntry("active", 0, "SYNNEW", "FIGIRENAME", true),
      makeIdxEntry("active", 1, "SYNRB1", "FIGIRB1", true),
      ...addEntries,
      makeIdxEntry("inactive", 0, "SYNDELIST", "FIGIDELIST", false),
    ],
  };
  await writeTickerReferenceIndex(store, badCapture, { provider: "massive", asOf: "2025-05-13" });

  // 3. Tonight's 2026-11-24 scan index (rotates base past 2025-05-13)
  const tonightCapture: TickerReferenceCapture = {
    pages: { active: 1, inactive: 1 },
    entries: [
      makeIdxEntry("active", 0, "SYNNEW", "FIGIRENAME", true),
      makeIdxEntry("active", 1, "SYNRB1", "FIGIRB1", true),
      ...addEntries,
      makeIdxEntry("inactive", 0, "SYNDELIST", "FIGIDELIST", false),
      makeIdxEntry("inactive", 1, "SYNRB2", "FIGIRB2", false),
    ],
  };
  await writeTickerReferenceIndex(store, tonightCapture, { provider: "massive", asOf: "2026-11-24" });

  await store.put(
    "backfill-reopen-state.json",
    new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z", completedSessions: [] }, null, 2)),
  );

  const securities: SecurityMasterRecord[] = [
    ...Array.from({ length: 23 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return makeSecurity({
        securityId: `figi:FIGIADD${n}`,
        currentSymbol: `SYNADD${n}`,
        firstSeenAt: "2025-05-13",
        lastUniverseSeenAt: "2026-11-24",
        historicalSymbols: [{ symbol: `SYNADD${n}`, effectiveFrom: "2025-05-13", source: "massive" }],
      });
    }),
    makeSecurity({
      securityId: "figi:FIGIOUT",
      currentSymbol: "SYNOUT",
      status: "INACTIVE",
      tradable: false,
      inactiveAt: "2025-05-13",
      // No delistedAt!
      lastUniverseSeenAt: "2026-11-23",
    }),
    makeSecurity({
      securityId: "figi:FIGIDELIST",
      currentSymbol: "SYNDELIST",
      status: "INACTIVE",
      tradable: false,
      inactiveAt: "2025-05-13",
      delistedAt: "2026-11-23",
      lastUniverseSeenAt: "2026-11-24",
    }),
    makeSecurity({
      securityId: "figi:FIGIRENAME",
      currentSymbol: "SYNNEW",
      lastUniverseSeenAt: "2026-11-24",
      historicalSymbols: [
        { symbol: "SYNOLD", effectiveFrom: "2024-01-02", effectiveTo: "2025-05-13", source: "massive" },
        { symbol: "SYNNEW", effectiveFrom: "2025-05-13", source: "massive" },
      ],
    }),
    makeSecurity({
      securityId: "figi:FIGIRB1",
      currentSymbol: "SYNRB1",
      lastUniverseSeenAt: "2025-05-13",
    }),
    makeSecurity({
      securityId: "figi:FIGIRB2",
      currentSymbol: "SYNRB2",
      status: "INACTIVE",
      tradable: false,
      inactiveAt: "2026-10-13",
      lastUniverseSeenAt: "2025-05-13",
    }),
    // Unverified record: stamped 2025-05-13 with zero evidence in indexes or membership
    makeSecurity({
      securityId: "figi:FIGIUNV",
      currentSymbol: "SYNUNV",
      firstSeenAt: "2025-05-13",
      lastUniverseSeenAt: "2025-05-13",
      historicalSymbols: [{ symbol: "SYNUNV", effectiveFrom: "2025-05-13", source: "massive" }],
    }),
  ];
  await store.put("permanent/security-master.json", new TextEncoder().encode(JSON.stringify(securities.sort((a, b) => a.securityId.localeCompare(b.securityId)), null, 2) + "\n"));

  // Preserve custom spacing on pre-existing lines to verify line-preservation!
  const verbatimOldLine = '{"securityId":"figi:FIGIDELIST",  "effectiveDate":"2026-10-02","included":true,"eligibility":"ELIGIBLE","reason":"NEW","provider":"massive","observedAt":"2026-10-02"}';
  const tonightDupLine = JSON.stringify({
    securityId: "figi:FIGIADD01",
    effectiveDate: "2026-11-24",
    included: true,
    eligibility: "LEVEL_0",
    reason: "NEW",
    provider: "massive",
    observedAt: "2026-11-24",
  });
  const badRows = [
    ...Array.from({ length: 23 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return JSON.stringify({
        securityId: `figi:FIGIADD${n}`,
        effectiveDate: "2025-05-13",
        included: true,
        eligibility: "LEVEL_0",
        reason: "NEW",
        provider: "massive",
        observedAt: "2025-05-13",
      });
    }),
    JSON.stringify({
      securityId: "figi:FIGIOUT",
      effectiveDate: "2025-05-13",
      included: false,
      eligibility: "LEVEL_0",
      reason: "INACTIVE",
      provider: "universe-diff",
      observedAt: "2025-05-13",
    }),
    JSON.stringify({
      securityId: "figi:FIGIDELIST",
      effectiveDate: "2025-05-13",
      included: false,
      eligibility: "LEVEL_0",
      reason: "INACTIVE",
      provider: "massive",
      observedAt: "2025-05-13",
    }),
    JSON.stringify({
      securityId: "figi:FIGIMYSTERY",
      effectiveDate: "2025-05-13",
      included: true,
      eligibility: "LEVEL_0",
      reason: "NEW",
      provider: "massive",
      observedAt: "2025-05-13",
    }),
  ];
  await store.put("permanent/universe-membership.jsonl", new TextEncoder().encode([verbatimOldLine, tonightDupLine, ...badRows].join("\n") + "\n"));
  store.resetCounters();
  return { verbatimOldLine, tonightDupLine };
}

test("repairBackfillAsOf: dry-run performs zero writes, leaks no tickers, and apply surgically fixes post-scan R2 state idempotently", async () => {
  const store = new MemoryObjectStore();
  const { verbatimOldLine, tonightDupLine } = await seedPostScanFixture(store);

  const drySummary = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: false });
  assert.equal(drySummary.mode, "dry-run");
  assert.equal(drySummary.targetDate, "2026-11-24");
  assert.equal(store.puts, 0);
  assert.equal(store.deletes, 0);
  assert.equal(drySummary.securityMaster.repairedFirstSeen, 23);
  assert.equal(drySummary.securityMaster.repairedInactiveAt, 2);
  assert.equal(drySummary.securityMaster.repairedHistoricalSymbols, 24); // 23 new + 1 rename
  assert.equal(drySummary.securityMaster.repairedLastUniverseSeenAt, 1); // FIGIRB1 via badIdx; FIGIRB2 has no baseline so unverified
  assert.equal(drySummary.securityMaster.unverified, 2); // FIGIRB2 + FIGIUNV
  assert.equal(drySummary.universeMembership.repairedRows, 24);
  assert.equal(drySummary.universeMembership.deduplicatedRows, 1);
  assert.equal(drySummary.universeMembership.unverified, 1);
  assert.equal(drySummary.tickerReferenceIndex.action, "relink-previous-past-bad");
  assert.equal(drySummary.tickerReferenceIndex.deletedKeysCount, 2);

  const printed = formatRepairSummary(drySummary);
  for (const forbidden of ["SYNADD", "SYNOUT", "SYNDELIST", "SYNOLD", "SYNNEW", "SYNRB", "SYNUNV", "figi:", "FIGI"]) {
    assert.equal(printed.includes(forbidden), false, `output leaked ${forbidden}`);
  }

  // Apply
  const applySummary = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true });
  assert.equal(applySummary.mode, "apply");
  assert.equal(applySummary.securityMaster.wrote, true);
  assert.equal(applySummary.universeMembership.wrote, true);
  assert.equal(applySummary.tickerReferenceIndex.wrote, true);
  assert.equal(store.deletes, 2);

  const master = JSON.parse(new TextDecoder().decode((await store.get("permanent/security-master.json"))!)) as SecurityMasterRecord[];
  const byId = new Map(master.map((r) => [r.securityId, r]));
  assert.equal(byId.get("figi:FIGIADD01")?.firstSeenAt, "2026-11-24");
  assert.equal(byId.get("figi:FIGIADD01")?.historicalSymbols[0]?.effectiveFrom, "2026-11-24");
  assert.equal(byId.get("figi:FIGIOUT")?.inactiveAt, "2026-11-24");
  assert.equal(byId.get("figi:FIGIOUT")?.delistedAt, undefined);
  assert.equal(byId.get("figi:FIGIDELIST")?.inactiveAt, "2026-11-24");
  assert.deepEqual(byId.get("figi:FIGIRENAME")?.historicalSymbols, [
    { symbol: "SYNOLD", effectiveFrom: "2024-01-02", effectiveTo: "2026-11-24", source: "massive" },
    { symbol: "SYNNEW", effectiveFrom: "2026-11-24", source: "massive" },
  ]);
  assert.equal(byId.get("figi:FIGIRB1")?.lastUniverseSeenAt, "2026-11-24");
  // Unverified records remain untouched
  assert.equal(byId.get("figi:FIGIRB2")?.lastUniverseSeenAt, "2025-05-13");
  assert.equal(byId.get("figi:FIGIUNV")?.firstSeenAt, "2025-05-13");

  // Line preservation + deduplication in universe-membership.jsonl
  const membershipLines = new TextDecoder().decode((await store.get("permanent/universe-membership.jsonl"))!).trimEnd().split("\n");
  assert.equal(membershipLines.includes(verbatimOldLine), true, "prior line kept verbatim");
  assert.equal(membershipLines.includes(tonightDupLine), true, "tonight line kept verbatim");
  assert.equal(membershipLines.filter((l) => l.includes("figi:FIGIADD01")).length, 1, "duplicate collapsed");
  assert.equal(membershipLines.some((l) => l.includes("figi:FIGIMYSTERY") && l.includes("2025-05-13")), true, "unverified row untouched");

  // Ticker reference index history chain verified clean
  const history = await listTickerReferenceIndexHistory(store);
  assert.equal(history.every((m) => (m.manifest?.asOf ?? "") !== "2025-05-13"), true);
  assert.equal(history.length, 2);
  const badObjects = (await store.list("permanent/ticker-reference-index/")).filter((k) => k.includes("2025-05"));
  assert.deepEqual(badObjects, []);

  // Idempotent second run: 0 writes, 0 deletes
  store.resetCounters();
  const second = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true });
  assert.equal(second.securityMaster.wrote, false);
  assert.equal(second.universeMembership.wrote, false);
  assert.equal(second.tickerReferenceIndex.wrote, false);
  assert.equal(store.puts, 0);
  assert.equal(store.deletes, 0);
});

test("repairBackfillAsOf: uses --baseline-master to restore exact pre-incident lastUniverseSeenAt and rejects ETag drift", async () => {
  const store = new MemoryObjectStore();
  await seedPostScanFixture(store);
  const dir = mkdtempSync(join(tmpdir(), "repair-baseline-"));
  try {
    const baselinePath = join(dir, "security-master.json");
    writeFileSync(
      baselinePath,
      JSON.stringify([
        makeSecurity({
          securityId: "figi:FIGIRB2",
          currentSymbol: "SYNRB2",
          status: "INACTIVE",
          tradable: false,
          inactiveAt: "2026-10-13",
          lastUniverseSeenAt: "2026-10-13",
        }),
      ]),
    );

    // ETag drift test
    let injected = false;
    store.onBeforePutIfMatch = (key, s) => {
      if (!injected && key === "permanent/security-master.json") {
        injected = true;
        const cur = s.objects.get(key)!;
        s.objects.set(key, { ...cur, etag: '"etag-stale"' });
      }
    };
    await assert.rejects(
      () => repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, baselineMasterPath: baselinePath }),
      /REPAIR_ETAG_DRIFT/u,
    );

    store.onBeforePutIfMatch = undefined;
    await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, baselineMasterPath: baselinePath });
    const master = JSON.parse(new TextDecoder().decode((await store.get("permanent/security-master.json"))!)) as SecurityMasterRecord[];
    assert.equal(master.find((r) => r.securityId === "figi:FIGIRB2")?.lastUniverseSeenAt, "2026-10-13");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repairBackfillAsOf: pre-scan state restores morning manifest to live and workflow enforces main + dry-run default", async () => {
  const store = new MemoryObjectStore();
  await writeTickerReferenceIndex(
    store,
    { pages: { active: 1, inactive: 0 }, entries: [makeIdxEntry("active", 0, "SYNRB1", "FIGIRB1", true)] },
    { provider: "massive", asOf: "2026-11-24" },
  );
  await writeTickerReferenceIndex(
    store,
    { pages: { active: 1, inactive: 0 }, entries: [makeIdxEntry("active", 0, "SYNRB1", "FIGIRB1", true)] },
    { provider: "massive", asOf: "2025-05-13" },
  );
  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z" })));
  await store.put("permanent/security-master.json", new TextEncoder().encode("[]\n"));
  await store.put("permanent/universe-membership.jsonl", new TextEncoder().encode(""));

  const res = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true });
  assert.equal(res.tickerReferenceIndex.action, "restore-previous-to-live");
  const live = await loadTickerReferenceIndex(store);
  assert.equal(live?.manifest.asOf, "2026-11-24");

  const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  assert.match(yml, /- repair_backfill_asof\b/u);
  assert.match(yml, /repair_apply:[\s\S]*default:\s*false/u);
  assert.match(yml, /repair_backfill_asof:[\s\S]*environment:\s*scanner-data/u);
  assert.match(yml, /repair_backfill_asof:[\s\S]*github\.ref == 'refs\/heads\/main'/u);
});

test("repairBackfillAsOf: refuses --apply on non-main GitHub Actions ref", async () => {
  const store = new MemoryObjectStore();
  await assert.rejects(
    () =>
      repairBackfillAsOf(store, {
        badDate: "2025-05-13",
        apply: true,
        env: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/topic-branch" },
      }),
    /REPAIR_REFUSE_NON_MAIN/u,
  );
});
