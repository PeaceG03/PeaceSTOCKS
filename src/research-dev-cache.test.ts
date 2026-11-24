import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CorporateAction, SecurityMasterRecord } from "./contracts";
import { EvalHistory, rng, type EvalBar } from "./holdout-eval";
import { buildHarnessSession } from "./research-harness-data";
import {
  buildDevFeatureCache,
  computeDevDataManifest,
  DEV_CACHE_MANIFEST_MISMATCH,
  DEV_CACHE_OUT_IN_REPO,
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

test("dev cache refuses any session or outcome >= heldOutStart, plus DC_READ_NO_META_CHECK and DC_READ_NO_EXIT_CHECK", async () => {
  const days = weekdays(130);
  const { bars, ids } = world(25, days, 11);
  const master = ids.map((id) => rec(id));
  const history = new EvalHistory(bars);
  const heldOutStart = days[120]!;

  assert.throws(
    () => extractDevCacheSession(master, history, 120, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  assert.throws(
    () => extractDevCacheSession(master, history, 122, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  assert.throws(
    () => extractDevCacheSession(master, history, 119, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  assert.throws(
    () => extractDevCacheSession(master, history, 118, heldOutStart, { splitActions: [] }),
    new RegExp(DEV_CACHE_REFUSED_HELDOUT),
  );
  const ok = extractDevCacheSession(master, history, 117, heldOutStart, { splitActions: [] });
  assert.ok(ok && ok.sessionDate === days[117] && ok.exitDate === days[119]);

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
    // Refuses heldOutStart later than 2026-08-27
    await assert.rejects(
      buildDevFeatureCache({
        dataRoot: dir,
        outFile: join(dir, "cache.jsonl"),
        from: "2025-04-01",
        heldOutStart: "2026-08-28",
        minBars: 1,
      }),
      new RegExp(DEV_CACHE_REFUSED_HELDOUT),
    );
    // Refuses non-integer or < 1 minBars
    for (const badMin of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        buildDevFeatureCache({
          dataRoot: dir,
          outFile: join(dir, "cache.jsonl"),
          from: "2025-04-01",
          heldOutStart: "2025-08-01",
          minBars: badMin,
        }),
        /INVALID_MIN_BARS/u,
      );
    }
    // Refuses --out inside repo
    await assert.rejects(
      buildDevFeatureCache({
        dataRoot: dir,
        outFile: join(dir, "repo", "dev-cache", "cache.jsonl"),
        from: "2025-04-01",
        heldOutStart: "2025-08-01",
        minBars: 1,
        repoRoot: join(dir, "repo"),
      }),
      new RegExp(DEV_CACHE_OUT_IN_REPO),
    );

    const cacheFile = join(dir, "cache.jsonl");
    const manifest = computeDevDataManifest(dir, "2025-04-01", "2025-08-01");
    await buildDevFeatureCache({
      dataRoot: dir,
      outFile: cacheFile,
      from: "2025-04-01",
      heldOutStart: "2025-08-01",
      minBars: 1,
    });
    const loaded = readDevFeatureCache(cacheFile, "2025-08-01", manifest);
    assert.ok(loaded.sessions.length > 0);
    assert.equal(loaded.meta.manifest.manifestSha256, manifest.manifestSha256);
    assert.ok(loaded.sessions.every((s) => s.sessionDate < "2025-08-01" && s.exitDate < "2025-08-01"));

    // DC_READ_NO_META_CHECK: empty cache with meta.heldOutStart > expectedHeldOutStart must still be refused
    const emptyCache = join(dir, "empty-cache.jsonl");
    const metaLine = readFileSync(cacheFile, "utf8").split("\n")[0]!;
    writeFileSync(emptyCache, `${metaLine}\n`);
    assert.throws(
      () => readDevFeatureCache(emptyCache, "2025-07-01", manifest),
      new RegExp(`${DEV_CACHE_REFUSED_HELDOUT}:meta`),
    );

    // DC_READ_NO_EXIT_CHECK: meta.heldOutStart <= expected, sessionDate < entryDate < expected <= exitDate -> refused
    const lines = readFileSync(cacheFile, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    const exitContaminated = join(dir, "exit-contaminated.jsonl");
    writeFileSync(
      exitContaminated,
      `${lines.join("\n")}\n${JSON.stringify({ ...last, sessionDate: "2025-07-30", entryDate: "2025-07-31", exitDate: "2025-08-01" })}\n`,
    );
    assert.throws(
      () => readDevFeatureCache(exitContaminated, "2025-08-01", manifest),
      new RegExp(`${DEV_CACHE_REFUSED_HELDOUT}:cached-exit`),
    );

    // B3: changing data (e.g. corporate actions or bars or expected manifest) triggers DEV_CACHE_MANIFEST_MISMATCH
    assert.throws(
      () => readDevFeatureCache(cacheFile, "2025-08-01", "deadbeef".repeat(8)),
      new RegExp(DEV_CACHE_MANIFEST_MISMATCH),
    );
    writeFileSync(join(dir, "permanent/corporate-actions.jsonl"), readFileSync(join(dir, "permanent/corporate-actions.jsonl"), "utf8") + "\n ");
    const changedManifest = computeDevDataManifest(dir, "2025-04-01", "2025-08-01");
    assert.throws(
      () => readDevFeatureCache(cacheFile, "2025-08-01", changedManifest),
      new RegExp(DEV_CACHE_MANIFEST_MISMATCH),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DC_NO_SPLIT_EXIT_NULL: a split taking effect on D+2 nulls that stock's cached outcome and drops it from universeSize", () => {
  const days = weekdays(125);
  const { bars, ids } = world(30, days, 19);
  const master = ids.map((id) => rec(id));
  const history = new EvalHistory(bars);
  const heldOutStart = days[120]!;
  const i = 110;
  const base = extractDevCacheSession(master, history, i, heldOutStart, { splitActions: [] })!;
  const targetId = base.candidates[0]!.securityId;
  assert.notEqual(base.candidates[0]!.outcome, null);

  const splitOnExit = {
    actionId: "split-exit",
    securityId: targetId,
    actionType: "SPLIT",
    effectiveDate: days[i + 2]!,
    details: { split_from: 1, split_to: 2 },
    observedAt: "2020-01-01T00:00:00Z",
  } as unknown as CorporateAction;
  const withSplit = extractDevCacheSession(master, history, i, heldOutStart, { splitActions: [splitOnExit] })!;
  const targetEntry = withSplit.candidates.find((c) => c.securityId === targetId)!;
  assert.equal(targetEntry.outcome, null);
  assert.equal(withSplit.universeSize, base.universeSize - 1);

  const splitOnEntry = { ...splitOnExit, effectiveDate: days[i + 1]! } as CorporateAction;
  const withEntrySplit = extractDevCacheSession(master, history, i, heldOutStart, { splitActions: [splitOnEntry] })!;
  assert.notEqual(withEntrySplit.candidates.find((c) => c.securityId === targetId)!.outcome, null);
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
  assert.ok(cached.candidates.every((c) => c.securityId !== ids[0]));
  assert.ok(cached.candidates.every((c) => typeof c.features.RETURN_20D === "number" && typeof c.extra.return1d === "number"));
});
