import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { CanonicalDailyBar } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

function sampleBar(securityId: string, sessionDate: string, revision = 1, close = 10): CanonicalDailyBar {
  return {
    securityId,
    sessionDate,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    observedAt: `${sessionDate}T21:00:00Z`,
    ingestedAt: `${sessionDate}T22:00:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: "r-1",
      ingestionVersion: "t",
      normalizerVersion: "t",
    },
  };
}

test("appendBars rejects duplicate existing keys (shrunk / line-lost) and records revision corrections", async () => {
  const key = "permanent/daily-bars/2026-10.jsonl";

  // Identical duplicate existing line + appending new key => DAILY_BARS_MONTH_SHRUNK
  const clientShrunk = new MemoryObjectClient();
  const storageShrunk = new ObjectMarketStorage(clientShrunk);
  const lineA = JSON.stringify(sampleBar("sec_a", "2026-10-01", 1, 10));
  await clientShrunk.put(key, new TextEncoder().encode(`${lineA}\n${lineA}\n`));
  await assert.rejects(
    () => storageShrunk.appendBars([sampleBar("sec_b", "2026-10-01", 1, 20)]),
    /DAILY_BARS_MONTH_SHRUNK/,
  );

  // Differing duplicate-key existing lines + appending new key => DAILY_BARS_MONTH_LINE_LOST
  const clientLost = new MemoryObjectClient();
  const storageLost = new ObjectMarketStorage(clientLost);
  const lineA2 = JSON.stringify(sampleBar("sec_a", "2026-10-01", 1, 11));
  await clientLost.put(key, new TextEncoder().encode(`${lineA}\n${lineA2}\n`));
  await assert.rejects(
    () => storageLost.appendBars([sampleBar("sec_b", "2026-10-01", 1, 20)]),
    /DAILY_BARS_MONTH_LINE_LOST/,
  );

  // Superseding revision 2 against existing revision 1 writes a CorrectionRecord while keeping rev 1 line untouched.
  const clientCorr = new MemoryObjectClient();
  const storageCorr = new ObjectMarketStorage(clientCorr);
  const rawRev1 = lineA.replace(":", ": ");
  await clientCorr.put(key, new TextEncoder().encode(`${rawRev1}\n`));
  await storageCorr.appendBars([sampleBar("sec_a", "2026-10-01", 2, 12)]);
  const corrRaw = new TextDecoder().decode((await clientCorr.get("permanent/corrections.jsonl"))!);
  assert.match(corrRaw, /"supersedesRevision":1/u);
  assert.match(corrRaw, /"replacementRevision":2/u);
  const monthAfter = new TextDecoder().decode((await clientCorr.get(key))!).split("\n").filter(Boolean);
  assert.equal(monthAfter.length, 2);
  assert.equal(monthAfter[0], rawRev1);
});

test("loadBars + appendBars + tallyBarCounts on a 233k-line (146 MiB) month succeeds within --max-old-space-size=224", () => {
  const storeUrl = pathToFileURL(new URL("./object-store.ts", import.meta.url).pathname).href;
  const storageUrl = pathToFileURL(new URL("./object-storage.ts", import.meta.url).pathname).href;
  const script = `
    import { MemoryObjectClient } from ${JSON.stringify(storeUrl)};
    import { ObjectMarketStorage } from ${JSON.stringify(storageUrl)};
    const pad = "x".repeat(160);
    const chunks = [];
    for (let s = 0; s < 10_600; s += 1) {
      const id = "sec_" + String(s).padStart(24, "0");
      let block = "";
      for (let d = 1; d <= 22; d += 1) {
        const day = "2026-10-" + String(d).padStart(2, "0");
        block += '{"securityId":"' + id + '","sessionDate":"' + day + '","open":10,"high":11,"low":9,"close":10.5,"volume":1000,"observedAt":"' + day + 'T21:00:00Z","ingestedAt":"' + day + 'T22:00:00Z","dataQuality":"GOOD","corporateActionIds":[],"flags":[],"schemaVersion":"foundation-d-v0","revision":1,"provenance":{"provider":"fixture-provider","dataset":"daily-ohlcv","retrievalId":"' + pad + '","ingestionVersion":"t","normalizerVersion":"t"}}\\n';
      }
      chunks.push(Buffer.from(block));
    }
    const monthBytes = new Uint8Array(Buffer.concat(chunks));
    chunks.length = 0;
    (async () => {
      const client = new MemoryObjectClient();
      await client.put("permanent/daily-bars/2026-10.jsonl", monthBytes);
      const storage = new ObjectMarketStorage(client);
      const existing = await storage.loadBars("2026-10-01");
      const sample = existing[0];
      const newBars = Array.from({ length: 500 }, (_, k) => ({
        ...sample,
        securityId: "sec_inactive_" + k + "_" + "0".repeat(12),
        sessionDate: "2026-10-01",
      }));
      await storage.appendBars(newBars);
      const counts = await storage.tallyBarCounts();
      if (counts.get("sec_" + "0".repeat(24)) !== 22) throw new Error("BAD_EXISTING_COUNT");
      if (counts.get("sec_inactive_0_" + "0".repeat(12)) !== 1) throw new Error("BAD_ADDED_COUNT");
      console.log("APPEND_MEM_OK heapMB=" + Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
    })();
  `;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const out = spawnSync(tsx, ["--input-type=module", "-e", script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_OPTIONS: "--max-old-space-size=224",
    },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, `expected exit 0 under 224 MiB heap, got ${out.status}:\n${out.stderr}\n${out.stdout}`);
  assert.match(out.stdout, /APPEND_MEM_OK heapMB=/u);
});
