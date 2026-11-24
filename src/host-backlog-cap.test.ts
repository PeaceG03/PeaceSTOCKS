import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { DEFAULT_SCAN_BUDGET_MS, runScannerHost, scanHostBudget } from "./host";

const UNIVERSE: ProviderSecurityRecord[] = [
  { provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true },
];

/** One security with a bar on every requested session, so each session's scan completes. */
class OneSecurityProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return UNIVERSE;
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    return ids.map((id) => ({
      securityId: id,
      sessionDate,
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 1000,
      observedAt: `${sessionDate}T21:00:00Z`,
      ingestedAt: `${sessionDate}T22:00:00Z`,
      dataQuality: "GOOD",
      corporateActionIds: [],
      flags: [],
      schemaVersion: "foundation-d-v0",
      revision: 1,
      provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: "r", ingestionVersion: "t", normalizerVersion: "t" },
    }));
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    return [];
  }
}

async function withSeededHost<T>(lastObserved: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-backlog-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "scheduler-host-state.json"),
    `${JSON.stringify({ schemaVersion: "peaceai-markets-scheduler-host:v1", forwardClockStartedAt: "2026-11-01T05:30:00.000Z", lastObservedSessionDate: lastObserved }, null, 2)}\n`,
  );
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
}

test("host stops starting sessions at its time budget, succeeds, and parks before the backlog", async () => {
  // Last observed Nov 2; due Nov 20 at 05:30Z on Nov 21. Each clock read after the first is 20 min later.
  await withSeededHost("2026-11-02", async (root) => {
    let t = 0;
    const lines: string[] = [];
    const result = await runScannerHost({
      now: new Date("2026-11-21T05:30:00.000Z"),
      storageRoot: root,
      provider: new OneSecurityProvider(),
      completionDelayMinutes: 30,
      env: { PEACESTOCKS_SCAN_BUDGET_MS: String(65 * 60_000) },
      clock: () => (t++) * 20 * 60_000,
      stageSink: (line) => lines.push(line),
    });
    // Reads at 20, 40, 60 min are under 65: three sessions run (Nov 3, 4, 5); 80 min stops.
    assert.deepEqual(result.sessions, ["2026-11-03", "2026-11-04", "2026-11-05"]);
    assert.equal(result.reason, "BACKLOG_REMAINS");
    assert.notEqual(result.status, "FAILED");
    assert.equal(result.backlogRemaining?.[0], "2026-11-06");
    assert.equal(result.backlogRemaining?.at(-1), "2026-11-20");
    assert.ok(
      lines.some((l) => /^SCAN_STAGE:2026-11-06\.\.2026-11-20:BACKLOG_REMAINS:\d+:\d+ms$/u.test(l)),
      lines.filter((l) => l.includes("BACKLOG")).join("\n"),
    );
    const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as { lastObservedSessionDate: string };
    assert.equal(state.lastObservedSessionDate, "2026-11-05");
  });
});

test("host session cap: PEACESTOCKS_SCAN_MAX_SESSIONS=2 runs two sessions and leaves the rest", async () => {
  await withSeededHost("2026-11-02", async (root) => {
    const result = await runScannerHost({
      now: new Date("2026-11-21T05:30:00.000Z"),
      storageRoot: root,
      provider: new OneSecurityProvider(),
      completionDelayMinutes: 30,
      env: { PEACESTOCKS_SCAN_MAX_SESSIONS: "2" },
      clock: () => 0,
      stageSink: () => {},
    });
    assert.deepEqual(result.sessions, ["2026-11-03", "2026-11-04"]);
    assert.equal(result.reason, "BACKLOG_REMAINS");
    assert.equal(result.backlogRemaining?.[0], "2026-11-05");
  });
});

test("scan budget env is strict; default 65 min", () => {
  assert.deepEqual(scanHostBudget({}), { budgetMs: DEFAULT_SCAN_BUDGET_MS, maxSessions: Number.POSITIVE_INFINITY });
  assert.equal(scanHostBudget({ PEACESTOCKS_SCAN_BUDGET_MS: " 60000 " }).budgetMs, 60000);
  assert.throws(() => scanHostBudget({ PEACESTOCKS_SCAN_BUDGET_MS: "80m" }), /PEACESTOCKS_SCAN_BUDGET_MS_INVALID/u);
  assert.throws(() => scanHostBudget({ PEACESTOCKS_SCAN_MAX_SESSIONS: "0" }), /PEACESTOCKS_SCAN_MAX_SESSIONS_INVALID/u);
});

test("scan budget plus the inline refill fit the scan job's 120 min timeout", () => {
  const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const job = yml.slice(yml.indexOf("\n  scan:\n"), yml.indexOf("\n  tenmin_daily:"));
  const jobTimeout = Number(/\n {4}timeout-minutes: (\d+)\n/u.exec(job)?.[1]);
  const refillStep = job.slice(job.indexOf("      - name: Fill daily-bars coverage after the scan"));
  const refillTimeout = Number(/timeout-minutes: (\d+)/u.exec(refillStep)?.[1]);
  const refillBudget = Number(/REFILL_BUDGET_MS: "(\d+)"/u.exec(refillStep)?.[1]);
  assert.equal(jobTimeout, 120);
  // Refill's own fatal timer fires at budget + 10 min, inside its step timeout.
  assert.ok(refillBudget / 60_000 + 10 <= refillTimeout);
  // Setup ~5 min + scan budget + ~5 min for the last session in flight + refill + ~5 min of later steps.
  assert.ok(5 + DEFAULT_SCAN_BUDGET_MS / 60_000 + 5 + refillTimeout + 5 <= jobTimeout, `${DEFAULT_SCAN_BUDGET_MS / 60_000} + ${refillTimeout}`);
});
