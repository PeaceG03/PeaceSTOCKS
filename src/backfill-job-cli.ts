/**
 * The workflow's backfill mode (scanner.yml mode=backfill -> `pnpm backfill` -> here): the resumable, rate-limited, sha-checked backfill job (src/backfill-job.ts), chunked.
 *
 *   --from / --to            the whole range (YYYY-MM-DD, inclusive)
 *   --chunk-sessions N       fixed chunks of N trading sessions from --from (default 150). Each chunk
 *                            is one job run with its own checkpoint and a point-in-time ticker refresh
 *                            as of the chunk's last day; a re-dispatch with the same inputs skips
 *                            finished chunks and resumes the first unfinished one.
 *   --max-sessions N         at most N sessions FETCHED this run (stored sessions do not count), so a
 *                            re-dispatch with the same inputs always makes progress (default: no cap)
 *   --request-spacing-ms N   minimum gap between Massive requests (default 12500, Basic-safe)
 *   --budget-ms N            stop at the next session boundary after N ms (default 6600000 = 110 min)
 *
 * Exit 0: complete, or stopped at a cap/budget/scan yield (resumable: dispatch again unchanged).
 * Exit 2: stopped on a provider/session error (resumable after the cause is fixed).
 * Exit 3: refused (sha mismatch or pack conflict): investigate; nothing was overwritten.
 * Output: one JSON summary line per chunk and a final line; codes, dates and counts only.
 */
import { pathToFileURL } from "node:url";
import { FileReplyDustStore, type ReplyDustStore } from "./intraday-reply-dust";
import { JOB_YIELD_BUDGET, JOB_YIELD_MAX_SESSIONS, classifyStop, runBackfillJob, type BackfillJobReport } from "./backfill-job";
import { tradingSessionsInRange } from "./daily-bars-coverage";
import { reportPart } from "./health-checkins";
import { R2ObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import type { ZstdVersionProbe } from "./reply-dust-pin";
import { createScanYieldCheck } from "./scan-yield";
import { MarketStorage, type MarketStore } from "./storage";

export const DEFAULT_REQUEST_SPACING_MS = 12_500;
export const DEFAULT_CHUNK_SESSIONS = 150;
export const DEFAULT_BUDGET_MS = 6_600_000;

export interface BackfillJobCliOptions {
  from: string;
  to: string;
  chunkSessions: number;
  maxSessions?: number;
  requestSpacingMs: number;
  budgetMs: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function value(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`BACKFILL_ARG_MISSING:${name}`);
  return v;
}

function integer(text: string | undefined, name: string, fallback: number | undefined, min: number, max: number): number | undefined {
  // An empty workflow input means "use the default".
  if (text === undefined || text.trim() === "") return fallback;
  if (!/^\d+$/u.test(text.trim())) throw new Error(`BACKFILL_ARG_INVALID:${name}`);
  const n = Number(text.trim());
  if (n < min || n > max) throw new Error(`BACKFILL_ARG_OUT_OF_RANGE:${name}`);
  return n;
}

export function parseBackfillJobArgs(args: readonly string[], env: NodeJS.ProcessEnv = {}): BackfillJobCliOptions {
  const from = value(args, "from") ?? env.MARKETS_BACKFILL_FROM;
  const to = value(args, "to") ?? env.MARKETS_BACKFILL_TO;
  if (!from || !to) throw new Error("BACKFILL_RANGE_REQUIRED");
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error("BACKFILL_RANGE_INVALID");
  const maxSessions = integer(value(args, "max-sessions"), "max-sessions", undefined, 1, 100_000);
  return {
    from,
    to,
    chunkSessions: integer(value(args, "chunk-sessions"), "chunk-sessions", DEFAULT_CHUNK_SESSIONS, 1, 5_000)!,
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    requestSpacingMs: integer(value(args, "request-spacing-ms"), "request-spacing-ms", DEFAULT_REQUEST_SPACING_MS, 0, 600_000)!,
    budgetMs: integer(value(args, "budget-ms"), "budget-ms", DEFAULT_BUDGET_MS, 1, 86_400_000)!,
  };
}

/** Fixed chunks of the range's trading sessions: [first, last] per chunk. */
export function backfillChunks(from: string, to: string, chunkSessions: number): Array<{ from: string; to: string; sessions: number }> {
  const sessions = tradingSessionsInRange(from, to);
  const out: Array<{ from: string; to: string; sessions: number }> = [];
  for (let k = 0; k < sessions.length; k += chunkSessions) {
    const chunk = sessions.slice(k, k + chunkSessions);
    out.push({ from: chunk[0]!, to: chunk.at(-1)!, sessions: chunk.length });
  }
  return out;
}

export interface BackfillJobCliDeps {
  storage?: MarketStore;
  store?: ReplyDustStore;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  zstdVersionProbe?: ZstdVersionProbe;
  /** Scan-yield check; default: the Actions check on GitHub, none elsewhere. */
  scanYield?: () => Promise<string | undefined>;
  log?: (line: string) => void;
  report?: typeof reportPart;
}

export interface BackfillJobCliResult {
  exitCode: 0 | 2 | 3;
  options: BackfillJobCliOptions;
  chunks: BackfillJobReport[];
  fetchedThisRun: number;
}

export async function backfillJobMain(args: readonly string[], env: NodeJS.ProcessEnv, deps: BackfillJobCliDeps = {}): Promise<BackfillJobCliResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const report = deps.report ?? reportPart;
  const options = parseBackfillJobArgs(args, env);
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_REF !== "refs/heads/main") throw new Error("BACKFILL_MAIN_ONLY");
  const apiKey = env.MASSIVE_API_KEY?.trim();
  if (!apiKey) throw new Error("MASSIVE_API_KEY_REQUIRED");
  let storage = deps.storage;
  let store = deps.store;
  if (!storage || !store) {
    if (env.PEACESTOCKS_R2_BUCKET?.trim()) {
      const client = R2ObjectClient.fromEnv(env);
      storage ??= new ObjectMarketStorage(client);
      store ??= client;
    } else {
      if (env.PEACESTOCKS_REQUIRE_OBJECT_STORE === "1") throw new Error("OBJECT_STORE_REQUIRED");
      const root = env.PEACEAI_MARKETS_ROOT ?? env.MARKETS_STORAGE_ROOT;
      if (!root) throw new Error("MARKETS_ROOT_REQUIRED");
      storage ??= new MarketStorage(root);
      store ??= new FileReplyDustStore(root);
    }
  }
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const scanYield = deps.scanYield ?? (env.GITHUB_ACTIONS === "true" ? createScanYieldCheck({ env }) : async () => undefined);
  // Sessions fetched = grouped-daily requests sent (one per fetched session; a stored session sends none).
  let fetched = 0;
  const baseFetch = deps.fetchImpl ?? fetch;
  let lastRequestAt: number | undefined;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const countingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The provider paces within a chunk; this also preserves the gap across chunk boundaries.
    if (lastRequestAt !== undefined) {
      const wait = lastRequestAt + options.requestSpacingMs - clock();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = clock();
    if (/\/v2\/aggs\/grouped\//u.test(url)) fetched += 1;
    return baseFetch(input, init);
  };
  // The backfill asks this at the start, at ticker-page boundaries and before every session it would
  // fetch: the caps stop at the next boundary, never mid-session.
  const shouldYield = async (): Promise<string | undefined> => {
    if (options.maxSessions !== undefined && fetched >= options.maxSessions) return JOB_YIELD_MAX_SESSIONS;
    if (clock() - started >= options.budgetMs) return JOB_YIELD_BUDGET;
    return scanYield();
  };
  const chunks = backfillChunks(options.from, options.to, options.chunkSessions);
  log(JSON.stringify({ backfill: "start", ...options, chunks: chunks.length, sessions: chunks.reduce((s, c) => s + c.sessions, 0) }));
  const reports: BackfillJobReport[] = [];
  let exitCode: 0 | 2 | 3 = 0;
  try {
    for (const [k, chunk] of chunks.entries()) {
      const r = await runBackfillJob({
        from: chunk.from,
        to: chunk.to,
        storage,
        store,
        fetchImpl: countingFetch,
        apiKey,
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
        minRequestIntervalMs: options.requestSpacingMs,
        clock,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        shouldYield,
        env,
        ...(deps.zstdVersionProbe ? { zstdVersionProbe: deps.zstdVersionProbe } : {}),
      });
      reports.push(r);
      log(JSON.stringify({
        backfill: "chunk", chunk: k + 1, of: chunks.length, from: r.from, to: r.to, status: r.status, stopReason: r.stopReason,
        checkpoint: r.checkpointSessions, sessions: chunk.sessions, fetched: r.completedThisRun, verified: r.sessionsVerified,
        packsWritten: r.packsWritten, packsAlreadySealed: r.packsAlreadySealed, rowsOutsidePack: r.rowsOutsidePack,
        shaMismatches: r.shaMismatches, packConflicts: r.packConflicts, packCheckFailures: r.packCheckFailures,
        failedSessions: Object.fromEntries(Object.entries(r.failedSessions).map(([d, m]) => [d, classifyStop(m)])),
        requests: r.requests, minRequestGapMs: r.minRequestGapMs, survivorship: r.backfill.survivorship,
      }));
      if (r.status === "REFUSED_SHA_MISMATCH" || r.status === "REFUSED_PACK_CONFLICT") {
        exitCode = 3;
        break;
      }
      if (r.status === "STOPPED_RESUMABLE") {
        if (r.stopReason !== "MAX_SESSIONS" && r.stopReason !== "BUDGET" && r.stopReason !== "YIELDED") exitCode = 2;
        break;
      }
    }
  } catch (error) {
    await report(env, "backfill", "ERROR", "BACKFILL_JOB_FAILED");
    throw error;
  }
  const last = reports.at(-1);
  const done = reports.length === chunks.length && last?.status === "COMPLETE";
  log(JSON.stringify({ backfill: "end", exitCode, complete: done, fetchedThisRun: fetched, next: done ? "none" : exitCode === 0 ? "dispatch again with the same inputs" : "fix the cause, then dispatch again with the same inputs" }));
  await report(env, "backfill", exitCode === 0 ? "OK" : "ERROR", exitCode === 0 ? undefined : exitCode === 3 ? "REFUSED" : "STOPPED_ON_ERROR");
  return { exitCode, options, chunks: reports, fetchedThisRun: fetched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await backfillJobMain(process.argv.slice(2), process.env);
  process.exitCode = run.exitCode;
}
