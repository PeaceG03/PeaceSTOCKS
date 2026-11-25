// The workflow's backfill mode must go through the tested job: scanner.yml mode=backfill ->
// `pnpm backfill` -> src/backfill-job-cli.ts (backfillJobMain) -> runBackfillJob.
// No network here: the functional tests use the in-process fake Massive and a memory store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backfillChunks, backfillJobMain, parseBackfillJobArgs, type BackfillJobCliDeps } from "./backfill-job-cli";
import { FAKE_MASSIVE_BASE_URL, fakeMassive, syntheticMarket } from "./fake-massive";
import { dailyBarsSidecarFileKey } from "./daily-bars-sidecar";
import { writeDailyReplyDust } from "./daily-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { refreshUniverse } from "./universe";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
const backfillJob = (() => {
  const start = yml.indexOf("\n  backfill:\n");
  assert.ok(start >= 0, "backfill job present");
  const next = yml.slice(start + 1).search(/\n  [a-z_]+:\n/u);
  return yml.slice(start, start + 1 + next);
})();
const step = (name: RegExp) => {
  const parts = backfillJob.split(/\n      - /u);
  const found = parts.find((p) => name.test(p.split("\n")[0] ?? ""));
  assert.ok(found, `step ${name} present`);
  return found;
};
const runStep = step(/^name: Daily historical backfill into R2/u);
const runLine = /\n        run: (.+)\n?/u.exec(runStep)?.[1] ?? "";

test("workflow: backfill mode runs `pnpm backfill` with the spacing, chunk, cap and budget inputs", () => {
  assert.match(runLine, /^pnpm backfill /u);
  for (const flag of ["--from", "--to", "--max-sessions", "--request-spacing-ms", "--chunk-sessions", "--budget-ms"]) assert.ok(runLine.includes(`${flag} `), flag);
  assert.match(runStep, /BACKFILL_REQUEST_SPACING_MS: \$\{\{ github\.event\.inputs\.backfill_request_spacing_ms \}\}/u);
  assert.match(runStep, /BACKFILL_CHUNK_SESSIONS: \$\{\{ github\.event\.inputs\.backfill_chunk_sessions \}\}/u);
  assert.match(runStep, /BACKFILL_MAX_SESSIONS: \$\{\{ github\.event\.inputs\.max_sessions \}\}/u);
  // Inputs never interpolated straight into the shell line.
  assert.doesNotMatch(runLine, /\$\{\{/u);
  assert.match(yml, /backfill_request_spacing_ms:\n {8}description: [^\n]+\n {8}required: false\n {8}default: "12500"\n/u);
  assert.match(yml, /backfill_chunk_sessions:\n {8}description: [^\n]+\n {8}required: false\n {8}default: "150"\n/u);
  // The job writes Reply Dust: the pinned zstd build and PATH steps block in this job.
  for (const name of [/^name: Build pinned zstd 1\.5\.7/u, /^name: Use pinned zstd 1\.5\.7/u]) assert.doesNotMatch(step(name), /continue-on-error/u);
  assert.match(backfillJob, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.mode == 'backfill' && github\.ref == 'refs\/heads\/main' \}\}/u);
});

test("workflow: backfill step keeps 12 GB NODE_OPTIONS heap safety net", () => {
  assert.match(runStep, /\n {10}NODE_OPTIONS: --max-old-space-size=12288\n/u);
});

test("`pnpm backfill` is the job CLI; the old direct entry point refuses to run", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts.backfill ?? "";
  assert.match(script, /^tsx (src\/[a-z-]+\.ts)$/u);
  const entry = /^tsx (src\/[a-z-]+\.ts)$/u.exec(script)![1]!;
  // Run the script's entry point as `pnpm backfill` would: an invalid spacing is rejected by
  // backfillJobMain's parser before any store or network is opened.
  const root = mkdtempSync(join(tmpdir(), "bf-entry-"));
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const cwd = new URL("..", import.meta.url).pathname;
  const childEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PEACEAI_MARKETS_ROOT: root };
  const out = spawnSync(tsx, [entry, "--from", "2026-01-20", "--to", "2026-01-21", "--request-spacing-ms", "fast"], { cwd, env: childEnv, encoding: "utf8" });
  assert.notEqual(out.status, 0);
  assert.match(`${out.stderr}${out.stdout}`, /BACKFILL_ARG_INVALID:request-spacing-ms/u);
  const old = spawnSync(tsx, ["src/backfill.ts", "--from", "2026-01-20", "--to", "2026-01-21"], { cwd, env: childEnv, encoding: "utf8" });
  assert.notEqual(old.status, 0);
  assert.match(`${old.stderr}${old.stdout}`, /BACKFILL_ENTRY_MOVED/u);
});

test("arguments: empty workflow inputs mean defaults; bad values are refused", () => {
  const o = parseBackfillJobArgs(["--from", "2021-11-29", "--to", "2024-10-04", "--max-sessions", "", "--request-spacing-ms", "", "--chunk-sessions", ""]);
  assert.deepEqual(o, { from: "2021-11-29", to: "2024-10-04", chunkSessions: 150, requestSpacingMs: 12_500, budgetMs: 6_600_000 });
  assert.equal(parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--request-spacing-ms", "1000"]).requestSpacingMs, 1000);
  assert.throws(() => parseBackfillJobArgs(["--from", "2026-01-21", "--to", "2026-01-20"]), /BACKFILL_RANGE_INVALID/u);
  assert.throws(() => parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--chunk-sessions", "0"]), /OUT_OF_RANGE/u);
  assert.throws(() => parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--max-sessions", "-1"]), /INVALID/u);
  const chunks = backfillChunks("2021-11-29", "2024-10-04", 150);
  assert.deepEqual(chunks.map((c) => c.sessions), [150, 150, 150, 150, 117]);
  assert.deepEqual([chunks[0]!.from, chunks[0]!.to, chunks[4]!.to], ["2021-11-29", "2022-07-05", "2024-10-04"]);
});

// The workflow's exact run line, with its env vars set to these values.
function workflowArgs(vars: Record<string, string>): string[] {
  const words = runLine.replace(/^pnpm backfill /u, "").match(/"[^"]*"|\S+/gu) ?? [];
  return words.map((w) => w.replace(/^"|"$/gu, "").replace(/\$([A-Z_]+)/gu, (_, name: string) => vars[name] ?? ""));
}

function rig(spacing: number) {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const market = syntheticMarket(4);
  const fake = fakeMassive({ tickers: market.tickers, grouped: market.grouped });
  let now = Date.parse("2026-11-24T12:00:00Z");
  const lines: string[] = [];
  const sentAt: number[] = [];
  const deps: BackfillJobCliDeps = {
    storage, store: client, fetchImpl: async (input, init) => { sentAt.push(now); return fake.fetchImpl(input, init); }, baseUrl: FAKE_MASSIVE_BASE_URL,
    clock: () => now, sleep: async (ms) => { await new Promise((r) => setImmediate(r)); now += ms; }, now: () => new Date(now).toISOString(),
    zstdVersionProbe: () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***",
    scanYield: async () => undefined, log: (l) => lines.push(l), report: async () => "SKIPPED",
  };
  const vars = (max: string, chunk: string) => ({
    MARKETS_BACKFILL_FROM: "2026-01-20", MARKETS_BACKFILL_TO: "2026-01-26",
    BACKFILL_MAX_SESSIONS: max, BACKFILL_REQUEST_SPACING_MS: String(spacing), BACKFILL_CHUNK_SESSIONS: chunk,
  });
  return { client, fake, deps, vars, lines, sentAt, advance: (ms: number) => { now += ms; } };
}
const env = { MASSIVE_API_KEY: "fake-key-not-real" };

test("the workflow's run line drives the verified job: chunked, spaced, every session packed and sha-checked", async () => {
  const { fake, deps, vars, lines, sentAt } = rig(2_000);
  const run = await backfillJobMain(workflowArgs(vars("", "2")), env, deps);
  assert.equal(run.exitCode, 0);
  assert.equal(run.options.requestSpacingMs, 2_000);
  // 2026-01-20..01-26 = 5 sessions -> chunks of 2, 2, 1, each its own job run.
  assert.deepEqual(run.chunks.map((c) => [c.from, c.to, c.status]), [["2026-01-20", "2026-01-21", "COMPLETE"], ["2026-01-22", "2026-01-23", "COMPLETE"], ["2026-01-26", "2026-01-26", "COMPLETE"]]);
  assert.deepEqual(run.chunks.map((c) => c.sessionsVerified), [2, 2, 1]);
  assert.deepEqual(run.chunks.map((c) => c.packsWritten), [2, 2, 1]);
  for (const c of run.chunks) assert.ok(c.minRequestGapMs !== null && c.minRequestGapMs >= 2_000);
  // Across chunk boundaries too (each chunk has its own provider).
  assert.ok(sentAt.slice(1).every((t, k) => t - sentAt[k]! >= 2_000), "spacing held across chunks");
  assert.equal(fake.calls.grouped.length, 5);
  assert.match(lines.at(-1)!, /"complete":true/u);
});

test("--max-sessions caps sessions FETCHED, so re-dispatching the same inputs keeps making progress", async () => {
  const { fake, deps, vars } = rig(0);
  const first = await backfillJobMain(workflowArgs(vars("3", "2")), env, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(first.fetchedThisRun, 3);
  assert.equal(first.chunks.at(-1)!.stopReason, "MAX_SESSIONS");
  const second = await backfillJobMain(workflowArgs(vars("3", "2")), env, deps);
  assert.equal(second.exitCode, 0);
  assert.equal(second.fetchedThisRun, 2);
  assert.equal(second.chunks.at(-1)!.status, "COMPLETE");
  assert.deepEqual(fake.calls.grouped, ["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", "2026-01-26"]);
});

test("the time budget stops at a session boundary (resumable, exit 0); a plan-window 403 exits 2", async () => {
  const { deps, vars } = rig(12_500);
  const budget = await backfillJobMain([...workflowArgs(vars("", "5")).slice(0, -2), "--budget-ms", "60000"], env, deps);
  assert.equal(budget.exitCode, 0);
  assert.equal(budget.chunks[0]!.stopReason, "BUDGET");
  assert.ok(budget.fetchedThisRun >= 1 && budget.fetchedThisRun < 5);
  const plan = rig(0);
  const refused = fakeMassive({ tickers: syntheticMarket(4).tickers, grouped: syntheticMarket(4).grouped, planFrom: "2026-01-22" });
  const stopped = await backfillJobMain(workflowArgs(plan.vars("", "5")), env, { ...plan.deps, fetchImpl: refused.fetchImpl });
  assert.equal(stopped.exitCode, 2);
  assert.equal(stopped.chunks[0]!.stopReason, "PLAN_WINDOW");
});

test("a tampered sealed pack refuses the run with exit 3 and is never rewritten", async () => {
  const { client, deps, vars } = rig(0);
  assert.equal((await backfillJobMain(workflowArgs(vars("", "2")), env, deps)).exitCode, 0);
  const key = dailyBarsSidecarFileKey("2026-01-22");
  const bad = Uint8Array.from((await client.get(key))!);
  bad.set([bad.at(-1)! ^ 0xff], bad.length - 1);
  await client.put(key, bad);
  const refused = await backfillJobMain(workflowArgs(vars("", "2")), env, deps);
  assert.equal(refused.exitCode, 3);
  assert.equal(refused.chunks.at(-1)!.status, "REFUSED_SHA_MISMATCH");
  assert.equal(refused.chunks.length, 2, "stops at the refusing chunk");
  assert.deepEqual(Uint8Array.from((await client.get(key))!), bad);
});

test("no key, or no object store when one is required: refused before anything runs", async () => {
  await assert.rejects(backfillJobMain(["--from", "2026-01-20", "--to", "2026-01-21"], {}, {}), /MASSIVE_API_KEY_REQUIRED/u);
  await assert.rejects(
    backfillJobMain(["--from", "2026-01-20", "--to", "2026-01-21"], { MASSIVE_API_KEY: "k", PEACESTOCKS_REQUIRE_OBJECT_STORE: "1" }, {}),
    /OBJECT_STORE_REQUIRED/u,
  );
});

test("main only: on Actions the job refuses any ref but main (even with a key); locally the guard does not apply", async () => {
  const args = ["--from", "2026-01-20", "--to", "2026-01-21"];
  for (const ref of ["refs/heads/builder/x", "refs/tags/v1", "", undefined])
    await assert.rejects(backfillJobMain(args, { GITHUB_ACTIONS: "true", MASSIVE_API_KEY: "k", ...(ref === undefined ? {} : { GITHUB_REF: ref }) }, {}), /BACKFILL_MAIN_ONLY/u, String(ref));
  // Past the guard on main (stops at the next refusal: no key).
  await assert.rejects(backfillJobMain(args, { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" }, {}), /MASSIVE_API_KEY_REQUIRED/u);
  await assert.rejects(backfillJobMain(args, {}, {}), /MASSIVE_API_KEY_REQUIRED/u);
});

test("workflow wires backfill_reopen_inactive_tails (default false) to --reopen-inactive-tails", () => {
  assert.match(runStep, /BACKFILL_REOPEN_INACTIVE_TAILS: \$\{\{ github\.event\.inputs\.backfill_reopen_inactive_tails \}\}/u);
  assert.ok(runLine.includes("--reopen-inactive-tails "), "runLine passes --reopen-inactive-tails");
  assert.match(
    yml,
    /backfill_reopen_inactive_tails:\n {8}description: [^\n]+\n {8}required: false\n {8}default: false\n {8}type: boolean\n/u,
  );
  assert.equal(parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--reopen-inactive-tails", "false"]).reopenInactiveTails, undefined);
  assert.equal(parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--reopen-inactive-tails", "true"]).reopenInactiveTails, true);
  assert.equal(parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--reopen-inactive-tails"]).reopenInactiveTails, true);
  assert.throws(() => parseBackfillJobArgs(["--from", "2026-01-20", "--to", "2026-01-21", "--reopen-inactive-tails", "maybe"]), /BACKFILL_ARG_INVALID:reopen-inactive-tails/u);
});

test("CLI --reopen-inactive-tails counts Dust-cached reopened sessions toward --max-sessions across chunks", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const market = syntheticMarket(4);
  const tickers = [...market.tickers, { ticker: "GONE", figi: "FIGI0000GONE", type: "CS" as const, active: false, delistedDate: "2026-01-27" }];
  const grouped = (day: string) => [...market.grouped(day), { T: "GONE", o: 5, h: 5.5, l: 4.5, c: 4.8, v: 500 }];
  const seedFake = fakeMassive({ tickers, grouped });
  const seedProvider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: seedFake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-28T00:00:00.000Z",
  });
  await refreshUniverse(seedProvider, storage, "2026-01-26");
  const activeIds = (await storage.loadSecurities()).filter((s) => s.status === "ACTIVE").map((s) => s.securityId);
  for (const d of ["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", "2026-01-26"]) {
    const bars = await seedProvider.getDailyBars(d, activeIds);
    const raw = seedProvider.takeRawReplies()[0]!;
    await writeDailyReplyDust(client, raw, { provider: seedProvider.providerName, observedAt: bars[0]!.observedAt });
    await storage.appendBars(bars);
  }
  const fake = fakeMassive({ tickers, grouped });
  let now = Date.parse("2026-11-24T12:00:00Z");
  const lines: string[] = [];
  const deps: BackfillJobCliDeps = {
    storage,
    store: client,
    fetchImpl: fake.fetchImpl,
    baseUrl: FAKE_MASSIVE_BASE_URL,
    clock: () => now,
    sleep: async (ms) => { await new Promise((r) => setImmediate(r)); now += ms; },
    now: () => new Date(now).toISOString(),
    zstdVersionProbe: () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***",
    scanYield: async () => undefined,
    log: (l) => lines.push(l),
    report: async () => "SKIPPED",
  };
  const runArgs = workflowArgs({
    MARKETS_BACKFILL_FROM: "2026-01-20",
    MARKETS_BACKFILL_TO: "2026-01-26",
    BACKFILL_MAX_SESSIONS: "3",
    BACKFILL_REQUEST_SPACING_MS: "0",
    BACKFILL_CHUNK_SESSIONS: "2",
    BACKFILL_REOPEN_INACTIVE_TAILS: "true",
  });
  const first = await backfillJobMain(runArgs, env, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(fake.calls.grouped.length, 0, "0 grouped calls with Reply Dust");
  assert.equal(first.chunks.length, 2);
  assert.equal(first.chunks[0]!.completedThisRun, 2);
  assert.equal(first.chunks[1]!.completedThisRun, 1);
  assert.equal(first.chunks[1]!.stopReason, "MAX_SESSIONS");
  const second = await backfillJobMain(runArgs, env, deps);
  assert.equal(second.exitCode, 0);
  assert.equal(second.chunks[0]!.requests, 0, "chunk 1 skipped before refreshUniverse");
  assert.equal(second.chunks[1]!.completedThisRun, 1);
  assert.equal(second.chunks[2]!.completedThisRun, 1);
  assert.equal(second.chunks[2]!.status, "COMPLETE");
});
