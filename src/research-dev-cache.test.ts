import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { EvalHistory, rng, type EvalBar } from "./holdout-eval";
import { buildHarnessSession } from "./research-harness-data";
import {
  buildDevFeatureCache,
  DEV_CACHE_REFUSED_HELDOUT,
  extractDevCacheSession,
  readDevFeatureCache,
} from "./research-dev-cache";
import { writeSyntheticStore } from "./research-fixture";

function weekdays(n: number, first = "2026-03-02"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  return out;
}

const rec = (id: string, assetType: "STOCK" | "ETF" = "STOCK") =>
  ({ securityId: id, currentSymbol: id, assetType, status: "ACTIVE", eligibility: "LEVEL_3", providerIdentities: [] }) as unknown as SecurityMasterRecord;

function world(n: number, days: string[], seed: number) {
  const r = rng(seed);
  const bars: EvalBar[] = [];
  const ids = Array.from({ length: n }, (_, k) => `s${String(k).padStart(3, "0")}`);
  for (const id of ids) {
    let close = 20 + r() * 50;
    for (const day of days) {
      const open = close * (1 + (r() - 0.5) * 0.002);
      close = open * (1 + (r() - 0.5) * 0.02);
      bars.push({ securityId: id, sessionDate: day, open, close, volume: 1e6 + r() * 1e5, revision: 1 });
    }
  }
  return { bars, ids };
}

test("dev cache refuses any session or outcome >= heldOutStart", async () => {
  const days = weekdays(130);
  const { bars, ids } = world(25, days, 11);
  const master = ids.map((id) => rec(id));
  const history = new EvalHistory(bars);
  const heldOutStart = days[120]!;

  // Session D == heldOutStart -> refused
  assert.throws(
    () => extractDevCacheSession(master, history, 120, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  // Session D > heldOutStart -> refused
  assert.throws(
    () => extractDevCacheSession(master, history, 122, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  // Session D is heldOutStart - 1: entry (D+1) is heldOutStart -> refused
  assert.throws(
    () => extractDevCacheSession(master, history, 119, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  // Session D is heldOutStart - 2: exit (D+2) is heldOutStart -> refused
  assert.throws(
    () => extractDevCacheSession(master, history, 118, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  // Session D is heldOutStart - 3: exit (D+2) is heldOutStart - 1 (< heldOutStart) -> allowed
  const ok = extractDevCacheSession(master, history, 117, heldOutStart, { splitActions: [] });
  assert.ok(ok && ok.sessionDate === days[117] && ok.exitDate === days[119]);

  // buildDevFeatureCache refuses from >= heldOutStart or tampered cache files on read
  const dir = mkdtempSync(join(tmpdir(), "dev-cache-refuse-"));
  try {
    writeSyntheticStore(dir, { from: "2025-01-01", to: "2025-08-29" });
    await assert.rejects(
      buildDevFeatureCache({
        dataRoot: dir,
        outFile: join(dir, "cache.jsonl"),
        from: "2025-08-01",
        heldOutStart: "2025-08-01",
        minBars: 1,
      }),
      new RegExp(DEV_CACHE_REFUSED_HELDOUT),
    );
    const cacheFile = join(dir, "cache.jsonl");
    await buildDevFeatureCache({
      dataRoot: dir,
      outFile: cacheFile,
      from: "2025-04-01",
      heldOutStart: "2025-08-01",
      minBars: 1,
    });
    const loaded = readDevFeatureCache(cacheFile, "2025-08-01");
    assert.ok(loaded.sessions.length > 0);
    assert.ok(loaded.sessions.every((s) => s.sessionDate < "2025-08-01" && s.exitDate < "2025-08-01"));

    // Reading with an earlier heldOutStart refuses contaminated cached rows
    assert.throws(
      () => readDevFeatureCache(cacheFile, loaded.sessions[0]!.exitDate),
      new RegExp(DEV_CACHE_REFUSED_HELDOUT),
    );

    // Injecting a held-out session line into the cache file is refused on read
    const lines = readFileSync(cacheFile, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    writeFileSync(cacheFile, `${lines.join("\n")}\n${JSON.stringify({ ...last, sessionDate: "2025-08-01", entryDate: "2025-08-04", exitDate: "2025-08-05" })}\n`);
    assert.throws(() => readDevFeatureCache(cacheFile, "2025-08-01"), new RegExp(DEV_CACHE_REFUSED_HELDOUT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev cache matches buildHarnessSession universeSize, universeMean, and outcomes point-in-time", () => {
  const days = weekdays(125);
  const { bars, ids } = world(35, days, 42);
  const master = ids.map((id, idx) => rec(id, idx === 0 ? "ETF" : "STOCK"));
  const history = new EvalHistory(bars);
  const heldOutStart = days[120]!;
  const i = 110;
  const cached = extractDevCacheSession(master, history, i, heldOutStart, { splitActions: [] })!;
  const harness = buildHarnessSession(master, history, i, { splitActions: [] })!;
  assert.equal(cached.sessionDate, harness.session.sessionDate);
  assert.equal(cached.universeSize, harness.session.universeSize);
  assert.ok(Math.abs(cached.universeMean - harness.session.universeMean) < 1e-12);
  assert.equal(cached.candidates.length, harness.session.universeSize);
  assert.ok(cached.candidates.every((c) => c.securityId !== ids[0])); // ETF excluded
  assert.ok(cached.candidates.every((c) => typeof c.features.RETURN_20D === "number" && typeof c.extra.return1d === "number"));
});
