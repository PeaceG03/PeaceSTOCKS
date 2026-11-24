// A failed catch-up session stays in the backlog, is counted in BACKLOG_REMAINS, and is retried first
// by the next run; it is never counted as done. Live scan 45310223847: Oct 13-21 failed and the line
// read "2026-10-22..:BACKLOG_REMAINS:22" although 29 sessions were still to do.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { hostExitCode, runScannerHost } from "./host";
import { scanCheckin } from "./health-behind";

class FlakyProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  failing = new Set<string>();
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return [{ provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true }];
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    if (this.failing.has(sessionDate)) throw new Error("MASSIVE_HTTP_503");
    return ids.map((id) => ({ securityId: id, sessionDate, open: 99, high: 101, low: 98, close: 100, volume: 1000, observedAt: `${sessionDate}T21:00:00Z`, ingestedAt: `${sessionDate}T22:00:00Z`, dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "foundation-d-v0", revision: 1, provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: "r", ingestionVersion: "t", normalizerVersion: "t" } }));
  }
  async getCorporateActions(): Promise<CorporateAction[]> { return []; }
}

test("a failed session is in BACKLOG_REMAINS, keeps the cursor, and is retried first next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-retry-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "scheduler-host-state.json"),
      `${JSON.stringify({ schemaVersion: "peaceai-markets-scheduler-host:v1", forwardClockStartedAt: "2026-11-01T05:30:00.000Z", lastObservedSessionDate: "2026-11-02" }, null, 2)}\n`);
    const provider = new FlakyProvider();
    provider.failing.add("2026-11-03");
    const run = async () => {
      const lines: string[] = [];
      const result = await runScannerHost({
        now: new Date("2026-11-21T05:30:00.000Z"), storageRoot: root, provider, completionDelayMinutes: 30,
        env: { PEACESTOCKS_SCAN_MAX_SESSIONS: "2" }, clock: () => 0, stageSink: (l) => lines.push(l),
      });
      const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as { lastObservedSessionDate: string };
      return { result, lines, cursor: state.lastObservedSessionDate };
    };

    const first = await run();
    assert.deepEqual(first.result.sessions, ["2026-11-03", "2026-11-04"]);
    assert.equal(first.result.status, "FAILED");
    assert.equal(first.cursor, "2026-11-02", "the failed session is not counted as done");
    // Capped run with a failed session: exit 2 and an ERROR check-in (not BEHIND, not OK).
    assert.equal(hostExitCode(first.result), 2);
    assert.equal(scanCheckin(first.result).state, "ERROR");
    const remaining = first.result.backlogRemaining ?? [];
    assert.equal(remaining[0], "2026-11-03", "the failed session is still to do");
    assert.ok(!remaining.includes("2026-11-04"), "the completed session is not");
    assert.ok(remaining.includes("2026-11-05") && remaining.at(-1) === "2026-11-20");
    const line = first.lines.find((l) => l.includes("BACKLOG_REMAINS"));
    assert.ok(line?.startsWith(`SCAN_STAGE:2026-11-03..2026-11-20:BACKLOG_REMAINS:${remaining.length}:`), line);

    provider.failing.clear();
    const second = await run();
    assert.equal(second.result.sessions[0], "2026-11-03", "retried before later sessions");
    assert.ok(!second.result.sessions.includes("2026-11-04"), "a completed session is not redone");
    assert.notEqual(second.result.status, "FAILED");
    assert.equal(hostExitCode(second.result), 0);
    assert.equal(scanCheckin(second.result).state, "BEHIND");
    assert.ok(second.cursor >= "2026-11-03");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});
