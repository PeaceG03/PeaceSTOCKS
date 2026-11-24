import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar } from "./contracts";
import { ObjectMarketStorage } from "./object-storage";
import { MemoryObjectClient } from "./object-store";
import { FakeMarket } from "./paper-fakes.test-helper";
import { PAPER_LEDGER_PREFIX } from "./paper-ledger";
import { ledgerObjectClient, paperMain, PAPER_KILL_FILE, readOnlyObjectClient } from "./paper-trading-cli";

const ON = { PAPER_TRADING_ENABLED: "true", PEACESTOCKS_R2_BUCKET: "test-bucket" };
const noClient = () => {
  throw new Error("CLIENT_MADE");
};
const emptyRoot = () => mkdtempSync(join(tmpdir(), "paper-root-"));

test("cli: off by default and killed by the repo-root file, without making a storage client", async () => {
  const now = new Date("2026-12-08T11:15:00.000Z");
  assert.equal(await paperMain({ env: {}, now, repoRoot: emptyRoot(), makeClient: noClient }), "paper-trading: DISABLED");
  assert.equal(await paperMain({ env: { ...ON, PAPER_TRADING_ENABLED: "True" }, now, repoRoot: emptyRoot(), makeClient: noClient }), "paper-trading: DISABLED");
  const root = emptyRoot();
  writeFileSync(join(root, PAPER_KILL_FILE), "");
  assert.equal(await paperMain({ env: ON, now, repoRoot: root, makeClient: noClient }), "paper-trading: KILLED killed-by=FILE");
  assert.equal(await paperMain({ env: { ...ON, PAPER_TRADING_KILL: "true" }, now, repoRoot: emptyRoot(), makeClient: noClient }), "paper-trading: KILLED killed-by=VARIABLE");
  await assert.rejects(paperMain({ env: { PAPER_TRADING_ENABLED: "true" }, now, repoRoot: emptyRoot(), makeClient: noClient }), /PAPER_R2_NOT_CONFIGURED/u);
});

test("cli: scanner data is read-only; the ledger view has no delete", async () => {
  const client = new MemoryObjectClient();
  const ro = readOnlyObjectClient(client);
  await assert.rejects(ro.put("permanent/x", new Uint8Array()), /PAPER_MARKET_READ_ONLY/u);
  await assert.rejects(ro.delete("permanent/x"), /PAPER_MARKET_READ_ONLY/u);
  assert.deepEqual(await client.list(""), []);
  assert.equal("delete" in ledgerObjectClient(client), false);
  assert.equal("put" in ledgerObjectClient(client), false);
  await assert.rejects(ro.putIfAbsent!("permanent/x", new Uint8Array()), /PAPER_MARKET_READ_ONLY/u);
});

test("cli: end to end over the scanner's real storage layout, writing only paper/v1/ keys, logging no symbols", async () => {
  const client = new MemoryObjectClient();
  const store = new ObjectMarketStorage(client);
  const fake = new FakeMarket();
  fake.security("sec_spy", { symbol: "SPY", assetType: "ETF", eligibility: "LEVEL_3" });
  fake.security("sec_aaa", { symbol: "ZZTOP" });
  fake.bar("sec_spy", "2026-12-07", 500);
  fake.bar("sec_aaa", "2026-12-07", 10);
  fake.freeze("2026-12-07", "2026-12-08", ["sec_aaa"]);
  await store.saveSecurities(fake.securities);
  await store.appendBars(fake.bars.map((bar) => ({ ...bar, provenance: { provider: "t" }, ingestedAt: "x" }) as unknown as CanonicalDailyBar));
  await store.writePredictions(fake.sets);
  await store.writePredictionStatus(fake.statuses[0]!);
  const before = new Map([...(await client.list(""))].map((key) => [key, true]));
  const line = await paperMain({ env: ON, now: new Date("2026-12-08T11:15:00.000Z"), repoRoot: emptyRoot(), makeClient: () => client });
  assert.equal(line, "paper-trading: ON filled=0 pending=0 days=0 intents=2026-12-08:WRITTEN entries=1 exits=0 refused=-");
  assert.ok(!line.includes("ZZTOP") && !line.includes("sec_aaa"));
  const added = (await client.list("")).filter((key) => !before.has(key));
  assert.deepEqual(added, [`${PAPER_LEDGER_PREFIX}intents/2026-12-08.json`]);
});

const workflow = readFileSync(new URL("../.github/workflows/paper-trading.yml", import.meta.url), "utf8");

test("workflow: off by default, main only, no push/PR trigger, read-only token, runs only before the open", () => {
  assert.match(workflow, /^\s+if: \$\{\{ github\.ref == 'refs\/heads\/main' && vars\.PAPER_TRADING_ENABLED == 'true' \}\}$/mu);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/mu);
  assert.match(workflow, /^permissions:\n {2}contents: read\n(?! )/mu);
  assert.doesNotMatch(workflow, /:\s*write\b/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /PAPER_TRADING_ENABLED: \$\{\{ vars\.PAPER_TRADING_ENABLED \}\}/u);
  assert.match(workflow, /PAPER_TRADING_KILL: \$\{\{ vars\.PAPER_TRADING_KILL \}\}/u);
  // Only the R2 secrets the scanner already uses; no broker or other secret.
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]).sort();
  assert.deepEqual(secrets, ["PEACESTOCKS_R2_ACCESS_KEY_ID", "PEACESTOCKS_R2_ACCOUNT_ID", "PEACESTOCKS_R2_BUCKET", "PEACESTOCKS_R2_SECRET_ACCESS_KEY"]);
  // Every scheduled minute is before 13:30 UTC (09:30 EDT; 08:30 EST), on weekdays.
  const crons = [...workflow.matchAll(/cron: "([^"]+)"/gu)].map((m) => m[1]!);
  assert.equal(crons.length, 1);
  for (const cron of crons) {
    const [minute, hours, , , days] = cron.split(" ");
    assert.equal(days, "1-5");
    for (const hour of hours!.split(",")) assert.ok(Number(hour) * 60 + Number(minute) < 13 * 60 + 30, cron);
  }
  // No other workflow starts the paper run.
  const dir = new URL("../.github/workflows/", import.meta.url);
  const others = readdirSync(dir).filter((name) => name !== "paper-trading.yml" && readFileSync(new URL(name, dir), "utf8").includes("paper-trading"));
  assert.deepEqual(others, []);
});
