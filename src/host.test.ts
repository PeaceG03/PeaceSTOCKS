import assert from "node:assert/strict";
import test from "node:test";
import { findMissedEligibleSessions } from "./host";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

test("scheduler host catches up eligible sessions but skips weekends and NYSE holidays", () => {
  const missed = findMissedEligibleSessions(
    "2026-07-02",
    "2026-07-06",
    new Set(["2026-07-02"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-07-06"]);
});

test("scheduler host does not requeue completed sessions", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-25",
    "2026-08-26",
    new Set(["2026-08-25", "2026-08-26"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, []);
});

test("scheduler host catch-up excludes the current session before close", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-30",
    "2026-08-31",
    new Set(),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-08-31"]);
});
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScannerHost } from "./host";
import { MassiveMarketProvider } from "./massive-provider";

test("scheduler cursor stays before a provider-not-ready session", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-host-"));
  const previous = process.env.MASSIVE_API_KEY;
  process.env.MASSIVE_API_KEY = "test-key";
  try {
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "Attempted to request today's data before end of day" }),
          { status: 403 },
        ),
    });
    const result = await runScannerHost({
      now: new Date("2026-01-22T21:45:00.000Z"),
      storageRoot: root,
      provider,
      completionDelayMinutes: 30,
    });
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.reason, "PROVIDER_NOT_READY");
    const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as {
      lastObservedSessionDate: string;
    };
    assert.equal(state.lastObservedSessionDate, "2026-01-21");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
