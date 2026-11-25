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
import { securityId, stableJson } from "./identity";

/** Apply tests inject a local env so a GitHub Actions GITHUB_REF cannot trip the main-only guard. */
const LOCAL_ENV: NodeJS.ProcessEnv = {};

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
  assert.equal(drySummary.tickerReferenceIndex.deletedKeysCount, 0);

  const printed = formatRepairSummary(drySummary);
  for (const forbidden of ["SYNADD", "SYNOUT", "SYNDELIST", "SYNOLD", "SYNNEW", "SYNRB", "SYNUNV", "figi:", "FIGI"]) {
    assert.equal(printed.includes(forbidden), false, `output leaked ${forbidden}`);
  }

  // Apply
  const applySummary = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, env: LOCAL_ENV });
  assert.equal(applySummary.mode, "apply");
  assert.equal(applySummary.securityMaster.wrote, true);
  assert.equal(applySummary.universeMembership.wrote, true);
  assert.equal(applySummary.tickerReferenceIndex.wrote, true);
  assert.equal(store.deletes, 0);

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
  assert.equal(badObjects.length > 0, true, "bad index objects kept as evidence");

  // Idempotent second run: 0 writes, 0 deletes
  store.resetCounters();
  const second = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, env: LOCAL_ENV });
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
      () => repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, baselineMasterPath: baselinePath, env: LOCAL_ENV }),
      /REPAIR_ETAG_DRIFT/u,
    );

    store.onBeforePutIfMatch = undefined;
    await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, baselineMasterPath: baselinePath, env: LOCAL_ENV });
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

  const res = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, env: LOCAL_ENV });
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

test("repairBackfillAsOf: falling back to process.env still refuses apply on refs/pull/*/merge", async () => {
  const store = new MemoryObjectStore();
  const prevActions = process.env.GITHUB_ACTIONS;
  const prevRef = process.env.GITHUB_REF;
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_REF = "refs/pull/137/merge";
  try {
    await assert.rejects(
      () => repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true }),
      /REPAIR_REFUSE_NON_MAIN:refs\/pull\/137\/merge/u,
    );
  } finally {
    if (prevActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prevActions;
    if (prevRef === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = prevRef;
  }
});

test("production CLI does not wire env from argv or config and falls back to process.env", () => {
  const source = readFileSync(new URL("./repair-backfill-asof.ts", import.meta.url), "utf8");
  assert.match(source, /const options = parseCliArgs\(process\.argv\.slice\(2\)\);/u);
  assert.match(source, /repairBackfillAsOf\(store, options\)/u);
  assert.doesNotMatch(source, /options\.env\s*=/u);
  assert.doesNotMatch(source, /arg === "--env"/u);
});

test("repairBackfillAsOf (B1): matches production sec_ IDs, massive-stocks share_class_figi/composite_figi/ticker, uses stableJson, and keeps bad index objects", async () => {
  const store = new MemoryObjectStore();
  const makeProdEntry = (
    pass: "active" | "inactive",
    position: number,
    fields: { ticker: string; type: "CS" | "ETF"; active: boolean; share_class_figi?: string; composite_figi?: string },
  ): TickerReferenceEntry => {
    const payload = {
      ticker: fields.ticker,
      type: fields.type,
      market: "stocks",
      locale: "us",
      active: fields.active,
      ...(fields.share_class_figi ? { share_class_figi: fields.share_class_figi } : {}),
      ...(fields.composite_figi ? { composite_figi: fields.composite_figi } : {}),
    };
    return {
      pass,
      page: 1,
      position,
      raw: JSON.stringify(payload),
      ticker: fields.ticker,
      type: fields.type,
      active: fields.active,
      ...(fields.share_class_figi ? { share_class_figi: fields.share_class_figi } : {}),
      ...(fields.composite_figi ? { composite_figi: fields.composite_figi } : {}),
    };
  };

  // Production IDs: share_class_figi wins over composite_figi; ETF without FIGI uses ticker
  const addId = securityId("massive-stocks", "BBG001SCADD1", "STOCK");
  const etfAddId = securityId("massive-stocks", "SYNETF1", "ETF");
  const reusedOldId = securityId("massive-stocks", "SYNREUSE", "STOCK");
  const reusedNewId = securityId("massive-stocks", "BBG001SCREUS", "STOCK");
  const inactOutId = securityId("massive-stocks", "BBG001SCOUT1", "STOCK");
  const renameId = securityId("massive-stocks", "BBG001SCREN1", "STOCK");

  await writeTickerReferenceIndex(
    store,
    {
      pages: { active: 1, inactive: 0 },
      entries: [
        makeProdEntry("active", 0, { ticker: "SYNOUTP", type: "CS", active: true, share_class_figi: "BBG001SCOUT1", composite_figi: "BBG000CMOUT1" }),
        makeProdEntry("active", 1, { ticker: "SYNOLDP", type: "CS", active: true, share_class_figi: "BBG001SCREN1", composite_figi: "BBG000CMREN1" }),
        makeProdEntry("active", 2, { ticker: "SYNREUSE", type: "CS", active: true }),
      ],
    },
    { provider: "massive-stocks", asOf: "2026-11-24" },
  );

  await writeTickerReferenceIndex(
    store,
    {
      pages: { active: 1, inactive: 0 },
      entries: [
        makeProdEntry("active", 0, { ticker: "SYNNEWP", type: "CS", active: true, share_class_figi: "BBG001SCREN1", composite_figi: "BBG000CMREN9" }),
        makeProdEntry("active", 1, { ticker: "SYNADDP", type: "CS", active: true, share_class_figi: "BBG001SCADD1", composite_figi: "BBG000CMADD1" }),
        makeProdEntry("active", 2, { ticker: "SYNETF1", type: "ETF", active: true }),
        makeProdEntry("active", 3, { ticker: "SYNREUSE", type: "CS", active: true, share_class_figi: "BBG001SCREUS", composite_figi: "BBG000CMREUS" }),
        makeProdEntry("active", 3, { ticker: "SYNREUSE", type: "CS", active: true, share_class_figi: "BBG001SCREUS", composite_figi: "BBG000CMREUS" }),
      ],
    },
    { provider: "massive-stocks", asOf: "2025-05-13" },
  );

  await writeTickerReferenceIndex(
    store,
    {
      pages: { active: 1, inactive: 0 },
      entries: [
        makeProdEntry("active", 0, { ticker: "SYNNEWP", type: "CS", active: true, share_class_figi: "BBG001SCREN1", composite_figi: "BBG000CMREN9" }),
        makeProdEntry("active", 1, { ticker: "SYNADDP", type: "CS", active: true, share_class_figi: "BBG001SCADD1", composite_figi: "BBG000CMADD1" }),
        makeProdEntry("active", 2, { ticker: "SYNETF1", type: "ETF", active: true }),
      ],
    },
    { provider: "massive-stocks", asOf: "2026-11-24" },
  );

  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z" })));

  const securities: SecurityMasterRecord[] = [
    makeSecurity({
      securityId: addId,
      currentSymbol: "SYNADDP",
      firstSeenAt: "2025-05-13",
      lastUniverseSeenAt: "2026-11-24",
      historicalSymbols: [{ symbol: "SYNADDP", effectiveFrom: "2025-05-13", source: "massive-stocks" }],
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001SCADD1" }],
    }),
    makeSecurity({
      securityId: etfAddId,
      currentSymbol: "SYNETF1",
      assetType: "ETF",
      firstSeenAt: "2025-05-13",
      lastUniverseSeenAt: "2026-11-24",
      historicalSymbols: [{ symbol: "SYNETF1", effectiveFrom: "2025-05-13", source: "massive-stocks" }],
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "SYNETF1" }],
    }),
    makeSecurity({
      securityId: inactOutId,
      currentSymbol: "SYNOUTP",
      status: "INACTIVE",
      tradable: false,
      inactiveAt: "2025-05-13",
      lastUniverseSeenAt: "2026-11-23",
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001SCOUT1" }],
    }),
    makeSecurity({
      securityId: reusedOldId,
      currentSymbol: "SYNREUSE",
      status: "INACTIVE",
      tradable: false,
      inactiveAt: "2025-05-13",
      lastUniverseSeenAt: "2026-11-23",
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "SYNREUSE" }],
    }),
    makeSecurity({
      securityId: reusedNewId,
      currentSymbol: "SYNREUSE",
      firstSeenAt: "2025-05-13",
      lastUniverseSeenAt: "2026-11-24",
      historicalSymbols: [{ symbol: "SYNREUSE", effectiveFrom: "2025-05-13", source: "massive-stocks" }],
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001SCREUS" }],
    }),
    makeSecurity({
      securityId: renameId,
      currentSymbol: "SYNNEWP",
      lastUniverseSeenAt: "2026-11-24",
      historicalSymbols: [
        { symbol: "SYNOLDP", effectiveFrom: "2024-01-02", effectiveTo: "2025-05-13", source: "massive-stocks" },
        { symbol: "SYNNEWP", effectiveFrom: "2025-05-13", source: "massive-stocks" },
      ],
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001SCREN1" }],
    }),
  ];
  await store.put("permanent/security-master.json", new TextEncoder().encode(JSON.stringify(securities, null, 2) + "\n"));

  const rows = [
    { securityId: addId, effectiveDate: "2025-05-13", included: true, eligibility: "LEVEL_0", reason: "NEW", provider: "massive-stocks", observedAt: "2025-05-13" },
    { securityId: etfAddId, effectiveDate: "2025-05-13", included: true, eligibility: "LEVEL_0", reason: "NEW", provider: "massive-stocks", observedAt: "2025-05-13" },
    { securityId: inactOutId, effectiveDate: "2025-05-13", included: false, eligibility: "LEVEL_0", reason: "INACTIVE", provider: "universe-diff", observedAt: "2025-05-13" },
    { securityId: reusedOldId, effectiveDate: "2025-05-13", included: false, eligibility: "LEVEL_0", reason: "INACTIVE", provider: "universe-diff", observedAt: "2025-05-13" },
    { securityId: reusedNewId, effectiveDate: "2025-05-13", included: true, eligibility: "LEVEL_0", reason: "NEW", provider: "massive-stocks", observedAt: "2025-05-13" },
  ];
  await store.put("permanent/universe-membership.jsonl", new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  store.resetCounters();

  const res = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, env: LOCAL_ENV });
  assert.equal(res.securityMaster.repairedFirstSeen, 3);
  assert.equal(res.securityMaster.repairedInactiveAt, 2);
  assert.equal(res.securityMaster.repairedHistoricalSymbols, 4);
  assert.equal(res.securityMaster.unverified, 0);
  assert.equal(res.universeMembership.repairedRows, 5);
  assert.equal(res.universeMembership.unverified, 0);
  // Cheap optional: keep bad index objects instead of deleting them (relink only)
  assert.equal(res.tickerReferenceIndex.action, "relink-previous-past-bad");
  assert.equal(res.tickerReferenceIndex.deletedKeysCount, 0);
  assert.equal(store.deletes, 0);
  assert.equal((await store.list("permanent/ticker-reference-index/")).some((k) => k.includes("2025-05")), true);

  // Cheap optional: membership rewrites use stableJson (alphabetical keys)
  const memText = new TextDecoder().decode((await store.get("permanent/universe-membership.jsonl"))!).trimEnd();
  const expectedLine = stableJson({ ...rows[0], effectiveDate: "2026-11-24", observedAt: "2026-11-24" });
  assert.equal(memText.split("\n").includes(expectedLine), true);
});

test("repairBackfillAsOf (B2): default omitted apply option never writes and UTC-midnight updatedAt uses ET date", async () => {
  const store = new MemoryObjectStore();
  // 2026-11-25T00:00:05.102Z is UTC 2026-11-25, ET 2026-11-24
  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z" })));
  await store.put("permanent/security-master.json", new TextEncoder().encode("[]\n"));
  await store.put("permanent/universe-membership.jsonl", new TextEncoder().encode(""));
  store.resetCounters();

  const omittedOpts = await repairBackfillAsOf(store);
  assert.equal(omittedOpts.mode, "dry-run");
  assert.equal(omittedOpts.targetDate, "2026-11-24", "UTC-midnight boundary resolves to ET date");
  assert.equal(store.puts, 0);
  assert.equal(store.deletes, 0);
});

test("repairBackfillAsOf (B2): kills single-evidence-check mutants (new-membership, bad-index-entry, was-active-before, rename prior-ticker, target-date conflict)", async () => {
  const store = new MemoryObjectStore();
  const idNoMem = securityId("massive-stocks", "BBG001NOMEM1", "STOCK");
  const idNoBadIdx = securityId("massive-stocks", "BBG001NOBAD1", "STOCK");
  const idNotActiveBefore = securityId("massive-stocks", "BBG001NOTACT", "STOCK");
  const idBadRenamePrior = securityId("massive-stocks", "BBG001BADREN", "STOCK");

  await writeTickerReferenceIndex(
    store,
    {
      pages: { active: 1, inactive: 1 },
      entries: [
        { pass: "active", page: 1, position: 0, raw: JSON.stringify({ ticker: "SYNWRONG", type: "CS", market: "stocks", locale: "us", active: true, share_class_figi: "BBG001BADREN" }), ticker: "SYNWRONG", type: "CS", active: true, share_class_figi: "BBG001BADREN" },
        { pass: "inactive", page: 1, position: 0, raw: JSON.stringify({ ticker: "SYNNOTACT", type: "CS", market: "stocks", locale: "us", active: false, share_class_figi: "BBG001NOTACT" }), ticker: "SYNNOTACT", type: "CS", active: false, share_class_figi: "BBG001NOTACT" },
      ],
    },
    { provider: "massive-stocks", asOf: "2026-11-24" },
  );

  await writeTickerReferenceIndex(
    store,
    {
      pages: { active: 1, inactive: 1 },
      entries: [
        { pass: "active", page: 1, position: 0, raw: JSON.stringify({ ticker: "SYNNOMEM", type: "CS", market: "stocks", locale: "us", active: true, share_class_figi: "BBG001NOMEM1" }), ticker: "SYNNOMEM", type: "CS", active: true, share_class_figi: "BBG001NOMEM1" },
        { pass: "active", page: 1, position: 1, raw: JSON.stringify({ ticker: "SYNRENNEW", type: "CS", market: "stocks", locale: "us", active: true, share_class_figi: "BBG001BADREN" }), ticker: "SYNRENNEW", type: "CS", active: true, share_class_figi: "BBG001BADREN" },
        { pass: "inactive", page: 1, position: 0, raw: JSON.stringify({ ticker: "SYNNOTACT", type: "CS", market: "stocks", locale: "us", active: false, share_class_figi: "BBG001NOTACT" }), ticker: "SYNNOTACT", type: "CS", active: false, share_class_figi: "BBG001NOTACT" },
      ],
    },
    { provider: "massive-stocks", asOf: "2025-05-13" },
  );

  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z" })));
  await store.put(
    "permanent/security-master.json",
    new TextEncoder().encode(
      JSON.stringify([
        makeSecurity({
          securityId: idNoMem,
          currentSymbol: "SYNNOMEM",
          firstSeenAt: "2025-05-13",
          lastUniverseSeenAt: "2026-11-24",
          historicalSymbols: [{ symbol: "SYNNOMEM", effectiveFrom: "2025-05-13", source: "massive-stocks" }],
          providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001NOMEM1" }],
        }),
        makeSecurity({
          securityId: idNoBadIdx,
          currentSymbol: "SYNNOBAD",
          firstSeenAt: "2025-05-13",
          lastUniverseSeenAt: "2026-11-24",
          historicalSymbols: [{ symbol: "SYNNOBAD", effectiveFrom: "2025-05-13", source: "massive-stocks" }],
          providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001NOBAD1" }],
        }),
        makeSecurity({
          securityId: idNotActiveBefore,
          currentSymbol: "SYNNOTACT",
          status: "INACTIVE",
          tradable: false,
          inactiveAt: "2025-05-13",
          lastUniverseSeenAt: "2026-11-24",
          providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001NOTACT" }],
        }),
        makeSecurity({
          securityId: idBadRenamePrior,
          currentSymbol: "SYNRENNEW",
          lastUniverseSeenAt: "2026-11-24",
          historicalSymbols: [
            { symbol: "SYNRENOLD", effectiveFrom: "2024-01-01", effectiveTo: "2025-05-13", source: "massive-stocks" },
            { symbol: "SYNRENNEW", effectiveFrom: "2025-05-13", source: "massive-stocks" },
          ],
          providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "BBG001BADREN" }],
        }),
      ]),
    ),
  );
  await store.put(
    "permanent/universe-membership.jsonl",
    new TextEncoder().encode(
      JSON.stringify({
        securityId: idNoBadIdx,
        effectiveDate: "2025-05-13",
        included: true,
        eligibility: "LEVEL_0",
        reason: "NEW",
        provider: "massive-stocks",
        observedAt: "2025-05-13",
      }) + "\n",
    ),
  );

  // Target-date conflict rejection
  await assert.rejects(
    () => repairBackfillAsOf(store, { badDate: "2025-05-13", targetDate: "2026-11-23", apply: false }),
    /REPAIR_TARGET_DATE_CONFLICT/u,
  );
  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-26T00:00:05.102Z" })));
  await assert.rejects(
    () => repairBackfillAsOf(store, { badDate: "2025-05-13", apply: false }),
    /REPAIR_TARGET_DATE_CONFLICT/u,
  );
  await store.put("backfill-reopen-state.json", new TextEncoder().encode(JSON.stringify({ updatedAt: "2026-11-25T00:00:05.102Z" })));

  // All 4 missing-evidence cases must remain untouched & unverified
  const res = await repairBackfillAsOf(store, { badDate: "2025-05-13", apply: true, env: LOCAL_ENV });
  assert.equal(res.securityMaster.repairedFirstSeen, 0);
  assert.equal(res.securityMaster.repairedInactiveAt, 0);
  assert.equal(res.securityMaster.repairedHistoricalSymbols, 0);
  assert.equal(res.securityMaster.unverified, 4);
  assert.equal(res.universeMembership.repairedRows, 0);
  assert.equal(res.universeMembership.unverified, 1);
});
