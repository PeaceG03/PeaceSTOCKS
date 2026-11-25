import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ObjectClient } from "./object-store";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

function buildSyntheticMonth(securities: number, days: number, month = "2026-10"): Uint8Array {
  const pad = "x".repeat(160);
  const chunks: Buffer[] = [];
  for (let s = 0; s < securities; s += 1) {
    const id = `sec_${String(s).padStart(24, "0")}`;
    const figi = `FIGI${String(s).padStart(8, "0")}`;
    let block = "";
    for (let d = 1; d <= days; d += 1) {
      const day = `${month}-${String(d).padStart(2, "0")}`;
      block += `{"securityId":"${id}","sessionDate":"${day}","open":10,"high":11,"low":9,"close":10.5,"volume":1000,"observedAt":"${day}T21:00:00Z","ingestedAt":"${day}T22:00:00Z","dataQuality":"GOOD","corporateActionIds":[],"flags":[],"schemaVersion":"foundation-d-v0","revision":1,"provenance":{"provider":"fixture-provider","dataset":"daily-ohlcv","retrievalId":"${pad}","ingestionVersion":"t","normalizerVersion":"${figi}"}}\n`;
    }
    chunks.push(Buffer.from(block));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

test("loadBars(sessionDate) caches at most one active month across sessions and drops it on month change or appendBars", async () => {
  const base = new MemoryObjectClient();
  const octBytes = buildSyntheticMonth(20, 5, "2026-10");
  const novBytes = buildSyntheticMonth(20, 3, "2026-11");
  await base.put("permanent/daily-bars/2026-10.jsonl", octBytes);
  await base.put("permanent/daily-bars/2026-11.jsonl", novBytes);
  let octReads = 0;
  let novReads = 0;
  const client: ObjectClient = {
    get: async (k) => {
      if (k === "permanent/daily-bars/2026-10.jsonl") octReads += 1;
      if (k === "permanent/daily-bars/2026-11.jsonl") novReads += 1;
      return base.get(k);
    },
    getWithEtag: (k) => base.getWithEtag(k),
    put: (k, b, m) => base.put(k, b, m),
    putIfAbsent: (k, b) => base.putIfAbsent(k, b),
    putIfMatch: (k, b, e) => base.putIfMatch(k, b, e),
    head: (k) => base.head(k),
    delete: (k) => base.delete(k),
    list: (p) => base.list(p),
  };
  const storage = new ObjectMarketStorage(client);
  for (let d = 1; d <= 5; d += 1) {
    const rows = await storage.loadBars(`2026-10-0${d}`);
    assert.equal(rows.length, 20);
  }
  assert.equal(octReads, 1, "all 5 sessions in 2026-10 share 1 month GET");

  // Switching to 2026-11 evicts 2026-10 so at most one month buffer is retained.
  assert.equal((await storage.loadBars("2026-11-01")).length, 20);
  assert.equal(novReads, 1);
  assert.equal((await storage.loadBars("2026-10-01")).length, 20);
  assert.equal(octReads, 2);

  // Appending to 2026-10 invalidates the cache so subsequent loadBars sees the appended row.
  const sample = (await storage.loadBars("2026-10-01"))[0]!;
  await storage.appendBars([{ ...sample, securityId: "sec_new_999999999999999999" }]);
  assert.equal((await storage.loadBars("2026-10-01")).length, 21);
  assert.equal(octReads, 3);
});

test("tallyBarCounts and loadBars stream 26 synthetic months (~1 GiB) and 220k-line month within --max-old-space-size=256", () => {
  const modUrl = pathToFileURL(new URL("./object-storage.ts", import.meta.url).pathname).href;
  const script = `
    import { ObjectMarketStorage } from ${JSON.stringify(modUrl)};
    const pad = "x".repeat(160);
    const chunks = [];
    for (let s = 0; s < 3500; s += 1) {
      const id = "sec_" + String(s).padStart(24, "0");
      let block = "";
      for (let d = 1; d <= 20; d += 1) {
        const day = "2026-10-" + String(d).padStart(2, "0");
        block += '{"securityId":"' + id + '","sessionDate":"' + day + '","open":10,"high":11,"low":9,"close":10.5,"volume":1000,"observedAt":"' + day + 'T21:00:00Z","ingestedAt":"' + day + 'T22:00:00Z","dataQuality":"GOOD","corporateActionIds":[],"flags":[],"schemaVersion":"foundation-d-v0","revision":1,"provenance":{"provider":"fixture-provider","dataset":"daily-ohlcv","retrievalId":"' + pad + '","ingestionVersion":"t","normalizerVersion":"t"}}\\n';
      }
      chunks.push(Buffer.from(block));
    }
    const tpl = new Uint8Array(Buffer.concat(chunks));
    const keys = Array.from({ length: 26 }, (_, i) => {
      const yr = 2024 + Math.floor((9 + i) / 12);
      const mo = String(((9 + i) % 12) + 1).padStart(2, "0");
      return "permanent/daily-bars/" + yr + "-" + mo + ".jsonl";
    });
    const client = {
      list: async (p) => (p.startsWith("permanent/daily-bars") ? keys : []),
      get: async (k) => (k.startsWith("permanent/daily-bars/") ? new Uint8Array(tpl) : undefined),
      put: async () => {},
      head: async () => undefined,
      delete: async () => {},
    };
    (async () => {
      const storage = new ObjectMarketStorage(client);
      const counts = await storage.tallyBarCounts();
      if (counts.size !== 3500) throw new Error("BAD_COUNT_SIZE:" + counts.size);
      if (counts.get("sec_" + "0".repeat(24)) !== 26 * 20) throw new Error("BAD_COUNT_VAL");
      const dayBars = await storage.loadBars("2026-10-01");
      if (dayBars.length !== 3500) throw new Error("BAD_DAY_BARS:" + dayBars.length);
      console.log("MEM_OK heapMB=" + Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
    })();
  `;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const out = spawnSync(tsx, ["--input-type=module", "-e", script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_OPTIONS: "--max-old-space-size=256",
    },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, `expected exit 0 under 256 MiB heap, got ${out.status}:\n${out.stderr}\n${out.stdout}`);
  assert.match(out.stdout, /MEM_OK heapMB=/u);
});
