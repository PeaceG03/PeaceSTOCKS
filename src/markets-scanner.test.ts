import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  ProviderSecurityRecord,
} from "./contracts";
import { fingerprint, securityId } from "./identity";
import { FEATURE_RECIPES } from "./recipes";
import { MARKET_STORAGE_LAYOUT } from "./index";
import { reconstructFeatures } from "./features";
import { refreshEligibility, refreshUniverse } from "./universe";
import { DEFAULT_SCANNER_CONFIG, rankSecurities } from "./ranking";
import { MarketStorage } from "./storage";
import { finalizeDailyPartition, MarketsScanner, US_EQUITY_CALENDAR } from "./scanner";
import { FileMarketProvider } from "./file-provider";

const oldId = "old-stock";
const providerRecord = (
  providerSecurityId: string,
  symbol: string,
  assetType: "STOCK" | "ETF" = "STOCK",
): ProviderSecurityRecord => ({
  provider: "fixture-provider",
  providerSecurityId,
  symbol,
  assetType,
  country: "US",
  exchange: "NYSE",
  active: true,
  tradable: true,
});

function bar(
  securityIdValue: string,
  date: string,
  close: number,
  revision = 1,
): CanonicalDailyBar {
  return {
    securityId: securityIdValue,
    sessionDate: date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    observedAt: `${date}T21:00:00Z`,
    ingestedAt: `${date}T22:00:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: `retrieval-${date}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

class FixtureProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  constructor(
    private readonly universe: ProviderSecurityRecord[],
    private readonly bars: CanonicalDailyBar[],
    private readonly actions: CorporateAction[] = [],
  ) {}
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return this.universe;
  }
  async getDailyBars(sessionDate: string, securityIds: string[]): Promise<CanonicalDailyBar[]> {
    return this.bars.filter(
      (item) => item.sessionDate === sessionDate && securityIds.includes(item.securityId),
    );
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    return this.actions;
  }
}

class FailingProvider extends FixtureProvider {
  override async getDailyBars(): Promise<CanonicalDailyBar[]> {
    throw new Error("MASSIVE_HTTP_403");
  }
}
async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "peaceai-markets-"));
}

test("security identity is stable across ticker changes and scope excludes non-US assets", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const first = await refreshUniverse(
      new FixtureProvider([providerRecord("issuer-1", "AAA")], []),
      storage,
      "2026-01-02",
    );
    const renamed = await refreshUniverse(
      new FixtureProvider(
        [
          providerRecord("issuer-1", "BBB"),
          { ...providerRecord("foreign", "INT"), country: "CA" },
          {
            ...providerRecord("option", "OPT"),
            assetType: "OPTION",
          } as unknown as ProviderSecurityRecord,
        ],
        [],
      ),
      storage,
      "2026-01-05",
    );
    assert.equal(
      first.securities[0]?.securityId,
      renamed.securities.find((item) => item.currentSymbol === "BBB")?.securityId,
    );
    assert.deepEqual(
      renamed.securities
        .find((item) => item.currentSymbol === "BBB")
        ?.historicalSymbols.map((item) => item.symbol),
      ["AAA", "BBB"],
    );
    assert.equal(renamed.rejected, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("universe refresh is idempotent and preserves inactive history", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const provider = new FixtureProvider(
      [providerRecord("issuer-1", "AAA"), providerRecord("issuer-2", "BBB", "ETF")],
      [],
    );
    await refreshUniverse(provider, storage, "2026-01-02");
    const repeat = await refreshUniverse(provider, storage, "2026-01-02");
    assert.equal(repeat.membershipEvents.length, 0);
    const afterRemoval = await refreshUniverse(
      new FixtureProvider([providerRecord("issuer-1", "AAA")], []),
      storage,
      "2026-01-03",
    );
    assert.equal(afterRemoval.inactivated, 1);
    assert.equal((await storage.loadSecurities()).length, 2);
    assert.equal(
      (await storage.loadSecurities()).find((item) => item.currentSymbol === "BBB")?.status,
      "INACTIVE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eligibility ladder never fabricates history", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    await refreshUniverse(
      new FixtureProvider([providerRecord("issuer-1", "AAA")], []),
      storage,
      "2026-01-02",
    );
    assert.equal((await refreshEligibility(storage))[0]?.eligibility, "LEVEL_0");
    await storage.appendBars(
      Array.from({ length: 20 }, (_, index) =>
        bar(
          securityId("fixture-provider", "issuer-1", "STOCK"),
          `2026-01-${String(index + 1).padStart(2, "0")}`,
          100 + index,
        ),
      ),
    );
    assert.equal((await refreshEligibility(storage))[0]?.eligibility, "LEVEL_2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical bars preserve precision, provenance, and correction lineage without duplication", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const original = bar(oldId, "2026-01-02", 100.123456789);
    const correction = bar(oldId, "2026-01-02", 100.223456789, 2);
    await storage.appendBars([original, original, correction]);
    const stored = await storage.loadBars("2026-01-02");
    assert.equal(stored.length, 2);
    assert.equal(stored[0]?.close, 100.123456789);
    assert.equal(stored[1]?.revision, 2);
    assert.equal(stored[0]?.provenance.provider, "fixture-provider");
    assert.equal(
      (await readFile(join(root, "permanent", "corrections.jsonl"), "utf8")).includes(
        "provider-revision",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calendar distinguishes closed weekends from normal sessions", () => {
  assert.equal(US_EQUITY_CALENDAR.getSession("2026-01-03").kind, "CLOSED");
  assert.equal(US_EQUITY_CALENDAR.getSession("2026-01-05").kind, "NORMAL");
});

test("feature recipes are versioned and derived features are reconstructable only in memory", () => {
  assert.ok(FEATURE_RECIPES.some((recipe) => recipe.featureId === "RETURN_20D"));
  const features = reconstructFeatures(
    oldId,
    "2026-01-22",
    Array.from({ length: 22 }, (_, index) =>
      bar(oldId, `2026-01-${String(index + 1).padStart(2, "0")}`, 100 + index),
    ),
  );
  assert.equal(features.values.RETURN_20D, 121 / 101 - 1);
  assert.equal(features.recipeVersions.RETURN_20D, "1");
});

test("ranking is deterministic, versioned, and stores no future outcomes", () => {
  const securities = [
    {
      securityId: oldId,
      currentSymbol: "AAA",
      historicalSymbols: [],
      assetType: "STOCK" as const,
      country: "US" as const,
      exchange: "NYSE",
      firstSeenAt: "2025-01-01",
      status: "ACTIVE" as const,
      tradable: true,
      providerIdentities: [],
      eligibility: "LEVEL_2" as const,
      barCount: 21,
      lastUniverseSeenAt: "2026-01-22",
    },
  ];
  const bars = Array.from({ length: 22 }, (_, index) =>
    bar(oldId, `2026-01-${String(index + 1).padStart(2, "0")}`, 100 + index),
  );
  const first = rankSecurities(securities, bars, [], "2026-01-22", DEFAULT_SCANNER_CONFIG);
  const second = rankSecurities(securities, bars, [], "2026-01-22", DEFAULT_SCANNER_CONFIG);
  assert.deepEqual(first.beliefs, second.beliefs);
  assert.equal(first.beliefs[0]?.scannerVersion, "scanner-v0.1");
  assert.equal("return20d" in first.beliefs[0]!, false);
  assert.equal(
    first.predictions.every((prediction) => prediction.securityIds.length <= 15),
    true,
  );
});

test("daily scanner run finalizes the permanent partition manifest", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const records = [providerRecord("issuer-1", "AAA")];
    const trackedId = securityId("fixture-provider", "issuer-1", "STOCK");
    const bars = [bar(trackedId, "2026-01-22", 121)];
    const report = await new MarketsScanner(new FixtureProvider(records, bars), storage).run(
      "2026-01-22",
    );
    assert.equal(report.status, "COMPLETE");
    const manifest = JSON.parse(
      await readFile(join(root, "permanent", "partitions", "daily-bars-2026-01.json"), "utf8"),
    ) as { quality: string; rowCount: number };
    assert.equal(manifest.quality, "GOOD");
    assert.equal(manifest.rowCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("failed/partial provider runs are not reported as complete", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const scanner = new MarketsScanner(
      new FixtureProvider([providerRecord("issuer-1", "AAA")], []),
      storage,
    );
    const report = await scanner.run("2026-01-05");
    assert.equal(report.status, "FAILED");
    assert.equal(report.incompleteSecurities, 1);
    assert.equal(report.validSecurities, 0);
    assert.ok(report.storage.permanentBytesToday > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart/retry rehydrates durable records without duplicate history", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const record = bar(oldId, "2026-01-05", 100);
    await storage.appendBars([record]);
    const restarted = new MarketStorage(root);
    await restarted.initialize();
    await restarted.appendBars([record]);
    assert.equal((await restarted.loadBars()).length, 1);
    const content = await readFile(join(root, "permanent", "daily-bars", "2026-01.jsonl"), "utf8");
    assert.equal(content.split("\n").filter(Boolean).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corporate actions are ledger evidence and do not rewrite source prices", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    const action: CorporateAction = {
      actionId: "action-1",
      securityId: oldId,
      actionType: "SPLIT",
      effectiveDate: "2026-01-05",
      details: { ratio: 2 },
      observedAt: "2026-01-05T22:00:00Z",
      provenance: {
        provider: "fixture-provider",
        dataset: "actions",
        retrievalId: "r1",
        ingestionVersion: "test",
        normalizerVersion: "test",
      },
    };
    const source = bar(oldId, "2026-01-05", 100);
    await storage.appendBars([source]);
    await storage.appendActions([action]);
    assert.equal((await storage.loadBars())[0]?.close, 100);
    assert.equal(
      (await readFile(join(root, "permanent", "corporate-actions.jsonl"), "utf8")).includes(
        "SPLIT",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permanent, cache, and transient storage classes are explicit", () => {
  assert.equal(MARKET_STORAGE_LAYOUT.permanentEvidence, "permanent/");
  assert.equal(MARKET_STORAGE_LAYOUT.derivedCache, "cache/");
  assert.equal(MARKET_STORAGE_LAYOUT.transientWorkspace, "transient/");
  assert.equal(MARKET_STORAGE_LAYOUT.canonicalBars, "permanent/daily-bars/YYYY-MM.jsonl");
});

test("fingerprints are stable for reproducible config/evidence identities", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
});

test("finalized partition records actual bytes and detects corruption", async () => {
  const root = await fixtureRoot();
  try {
    const storage = new MarketStorage(root);
    await storage.appendBars([bar(oldId, "2026-01-05", 100)]);
    await finalizeDailyPartition(storage, "2026-01-05", "fixture-provider", "GOOD");
    const path = join(root, "permanent", "daily-bars", "2026-01.jsonl");
    const text = await readFile(
      join(root, "permanent", "partitions", "daily-bars-2026-01.json"),
      "utf8",
    );
    const manifest = JSON.parse(text) as { sha256: string; byteSize: number; rowCount: number };
    assert.equal(manifest.rowCount, 1);
    assert.equal(manifest.byteSize, (await readFile(path)).byteLength);
    assert.equal(await storage.verifyPartition(path, manifest.sha256), true);
    assert.equal(await storage.verifyPartition(path, "0".repeat(64)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalized file provider is explicit, bounded, and usable without network access", async () => {
  const root = await fixtureRoot();
  try {
    const providerRoot = join(root, "source");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(providerRoot, "bars"), { recursive: true });
    await mkdir(join(providerRoot, "actions"), { recursive: true });
    await writeFile(
      join(providerRoot, "universe.json"),
      JSON.stringify([providerRecord("issuer-1", "AAA")]),
    );
    const id = securityId("fixture-provider", "issuer-1", "STOCK");
    await writeFile(
      join(providerRoot, "bars", "2026-01-05.jsonl"),
      JSON.stringify(bar(id, "2026-01-05", 100)) + "\n",
    );
    await writeFile(join(providerRoot, "actions", "2026-01-05.jsonl"), "");
    const provider = new FileMarketProvider(providerRoot, "fixture-provider");
    assert.equal((await provider.listApprovedSecurities()).length, 1);
    assert.equal((await provider.getDailyBars("2026-01-05", [id])).length, 1);
    await assert.rejects(() => provider.getDailyBars("not-a-date", [id]), /INVALID_SESSION_DATE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed source collection records unavailable prediction status and no ordinary prediction", async () => {
  const root = await fixtureRoot();
  try {
    const provider = new FailingProvider([providerRecord("issuer-1", "AAA")], []);
    const report = await new MarketsScanner(provider, new MarketStorage(root)).run("2026-01-02");
    assert.equal(report.status, "FAILED");
    assert.equal(report.predictionStatus, "UNAVAILABLE");
    assert.equal(report.predictionReason, "SOURCE_COLLECTION_FAILED");
    await assert.rejects(
      readFile(join(root, "permanent", "predictions", "2026-01-02.jsonl"), "utf8"),
    );
    const status = JSON.parse(
      await readFile(join(root, "permanent", "prediction-status", "2026-01-02.jsonl"), "utf8"),
    ) as { status: string; reason: string };
    assert.equal(status.status, "UNAVAILABLE");
    assert.equal(status.reason, "SOURCE_COLLECTION_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid scan with no qualifying candidates is frozen as a valid empty result", async () => {
  const root = await fixtureRoot();
  try {
    const id = securityId("fixture-provider", "issuer-1", "STOCK");
    const provider = new FixtureProvider(
      [providerRecord("issuer-1", "AAA")],
      [bar(id, "2026-01-02", 100)],
    );
    const report = await new MarketsScanner(provider, new MarketStorage(root)).run("2026-01-02");
    assert.equal(report.predictionStatus, "FROZEN");
    assert.equal(report.predictionReason, "NO_QUALIFYING_CANDIDATES");
    const status = JSON.parse(
      await readFile(join(root, "permanent", "prediction-status", "2026-01-02.jsonl"), "utf8"),
    ) as { status: string; reason: string };
    assert.equal(status.status, "FROZEN");
    assert.equal(status.reason, "NO_QUALIFYING_CANDIDATES");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
