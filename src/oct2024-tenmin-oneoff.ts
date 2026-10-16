// One-off (Peace's Oct 5 re-fetch approval; Architect decision 2026-10-12 ~01:20Z): finish the 2024-10 ten-minute
// Reply Dust fetch in GitHub Actions (.github/workflows/oct2024-tenmin.yml) instead of the box, which freezes while
// no agent runs. Same plan as the box driver (r2-usage/oct2024-tenmin/fetch.mts v3), same chain code path:
//   universeForTenMinRange (stored 2024-10 daily bars + security master) -> writeTenMinRangeReplyDust, range folder
//   permanent/tenmin-reply-dust/2024-09-01_2024-10-31/ (the chain's two-month pairing; AGED_OUT 2024-09-01..floor-1),
//   highest Oct 11-31 2024 dollar volume first, one /range/10/minute/{floor}/2024-10-31 request per security,
//   oldest session first (floor 2024-10-11; a Massive 403 "timeframe" on the floor => GONE, floor advances, replan).
// Resume by verify: every run re-lists the range and verifies stored objects (never re-fetches or overwrites them).
// Guards: PUT only under the range prefix and never over an existing key; 12.5 s request spacing (4.8/min);
// no fetch in 05:15-06:15Z / 09:15-10:15Z; pause while any non-idle scanner.yml run is active (fail closed).
// Chain: each run stops cleanly at BUDGET (default 5 h 15 min) and the workflow dispatches the next run.
// Logs are counts / PASS-FAIL only: no tickers, no bar values, no request URLs, no secrets.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { R2ObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MassiveMarketProvider } from "./massive-provider";
import { universeForTenMinRange, tradingSessionsBetween, addCalendarDays } from "./tenmin-history";
import {
  writeTenMinRangeReplyDust, listStoredTenMinRange, parseFetchIdentityKey, readTenMinRangeManifest,
  verifyStoredTenMinRangeFetch,
  TENMIN_AGED_OUT, TENMIN_DELISTED_COVERAGE_MISSING,
} from "./tenmin-range-reply-dust";
import { assertPinnedZstdForWriting } from "./reply-dust-pin";
import { pickActiveScannerRun, type ScannerRunLike } from "./scan-yield";

export const ONEOFF_CAL_FROM = "2024-09-01";
export const ONEOFF_CAL_TO = "2024-10-31";
export const ONEOFF_FIRST_FLOOR = "2024-10-11";
export const ONEOFF_PREFIX = `permanent/tenmin-reply-dust/${ONEOFF_CAL_FROM}_${ONEOFF_CAL_TO}/`;
export const ONEOFF_SESSIONS = tradingSessionsBetween(ONEOFF_FIRST_FLOOR, ONEOFF_CAL_TO);
export const ONEOFF_DEFAULT_BUDGET_MS = 5 * 3_600_000 + 15 * 60_000;
export const ONEOFF_MAX_CHAIN = 10;
export const ONEOFF_SPACING_MS = 12_500;

/** Same windows as the box driver: 05:15-06:15Z and 09:15-10:15Z (scans at 05:30 / 09:30). */
export function inOneOffGuardWindow(d: Date): boolean {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 315 && m < 375) || (m >= 555 && m < 615);
}

/** Dollar volume per security over sessions >= fromSession, from a permanent/daily-bars month jsonl body. */
export function dollarVolumeBySecurity(monthJsonl: string, fromSession: string): Map<string, number> {
  const dv = new Map<string, number>();
  for (const line of monthJsonl.split("\n")) {
    if (!line) continue;
    const b = JSON.parse(line) as { securityId: string; sessionDate: string; close?: unknown; volume?: unknown };
    if (b.sessionDate < fromSession) continue;
    dv.set(b.securityId, (dv.get(b.securityId) ?? 0) + (Number(b.close) || 0) * (Number(b.volume) || 0));
  }
  return dv;
}

/** Liquidity order exactly as the box driver: dollar volume desc, then securityId (code unit) asc. */
export function liquidityOrder<T extends { securityId: string }>(fetches: readonly T[], dv: ReadonlyMap<string, number>): T[] {
  return [...fetches].sort((a, b) => (dv.get(b.securityId) ?? 0) - (dv.get(a.securityId) ?? 0) || (a.securityId < b.securityId ? -1 : 1));
}

/** Next floor after a GONE session, or undefined when none is left. */
export function nextOneOffFloor(floor: string): string | undefined {
  const i = ONEOFF_SESSIONS.indexOf(floor);
  if (i < 0) throw new Error(`ONEOFF_FLOOR_INVALID:${floor}`);
  return ONEOFF_SESSIONS[i + 1];
}

export function parseOneOffFloor(input: string | undefined): string {
  const f = (input ?? "").trim() || ONEOFF_FIRST_FLOOR;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(f) || !ONEOFF_SESSIONS.includes(f)) throw new Error(`ONEOFF_FLOOR_INVALID:${f}`);
  return f;
}

/** ONEOFF_BUDGET_MS: unset/blank -> default; otherwise plain digits, 1..6h (the Actions job limit). Fail closed. */
export function parseOneOffBudgetMs(input: string | undefined): number {
  const s = input?.trim();
  if (!s) return ONEOFF_DEFAULT_BUDGET_MS;
  if (!/^\d{1,8}$/u.test(s) || Number(s) < 1 || Number(s) > 6 * 3_600_000)
    throw new Error(`ONEOFF_BUDGET_MS_INVALID:${JSON.stringify(s.slice(0, 20))}`);
  return Number(s);
}

export function parseChainIndex(input: string | undefined): number {
  const s = (input ?? "").trim() || "1";
  if (!/^\d{1,3}$/u.test(s) || Number(s) < 1) throw new Error(`ONEOFF_CHAIN_INDEX_INVALID:${s}`);
  return Number(s);
}

export type OneOffResult = "sealed" | "budget" | "fatal" | "refused" | "chain_cap";
/** What the workflow does after a run: dispatch the next run, start the post-seal run, or stop and alert. */
export function decideOneOffNext(result: OneOffResult, chainIndex: number, maxChain = ONEOFF_MAX_CHAIN): "dispatch" | "post_seal" | "alert" {
  if (result === "sealed") return "post_seal";
  if (result === "budget" && chainIndex < maxChain) return "dispatch";
  return "alert";
}

/** Fail-closed pause reason, or undefined to go on. */
export function oneOffPauseReason(now: Date, runs: readonly ScannerRunLike[] | { error: string }): string | undefined {
  if (inOneOffGuardWindow(now)) return "GUARD_WINDOW";
  if ("error" in runs) return `RUNS_CHECK_FAILED:${runs.error}`;
  const waiting = pickActiveScannerRun(runs, -1);
  return waiting ? "ACTIVE_SCANNER_RUN" : undefined;
}

/** Message class only (text before the first ':' or space), so logs never carry tickers, keys or URLs. */
export function errorClass(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  return (m.split(/[:\s]/u)[0] || "ERROR").slice(0, 60);
}

/** Referenced setTimeout + own AbortController raced against the call: always settles at ms (box v3 wrapper). */
export function timedFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  if (!Number.isFinite(ms) || ms < 1) throw new Error("INVALID_TIMEOUT_MS");
  return async (u, i) => {
    const ac = new AbortController();
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => { const e = new Error(`HTTP_TIMEOUT ${ms}ms`); ac.abort(e); rej(e); }, ms); });
    const call = (async () => {
      const res = await base(u, { ...(i ?? {}), signal: ac.signal });
      const body = await res.arrayBuffer();
      return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    })();
    call.catch(() => {});
    try { return await Promise.race([call, timeout]); } finally { clearTimeout(t); }
  };
}

/** Never-overwrite, prefix-only store wrapper (the same guard the box driver used). */
export function guardedStore(r2: { get(k: string): Promise<Uint8Array | undefined>; head(k: string): Promise<unknown>; list(p: string): Promise<string[]>; put(k: string, b: Uint8Array, m?: Record<string, string>): Promise<unknown> }, opts: { dry: boolean; onPut?: () => void }) {
  return {
    get: (k: string) => r2.get(k), head: (k: string) => r2.head(k), list: (p: string) => r2.list(p),
    async put(k: string, b: Uint8Array, m?: Record<string, string>) {
      if (opts.dry) throw new Error("DRY_RUN_PUT");
      if (!k.startsWith(ONEOFF_PREFIX)) throw new Error("GUARD_KEY_NOT_ALLOWED");
      if (await r2.head(k)) throw new Error("GUARD_WOULD_OVERWRITE");
      opts.onPut?.();
      return r2.put(k, b, m);
    },
  };
}

/** Count of stored fetches per fetchFrom (from a range listing). */
export function storedByFetchFrom(stored: ReadonlyMap<string, ReadonlySet<number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of stored.keys()) {
    const id = parseFetchIdentityKey(key) as { fetchFrom?: string } | undefined;
    const f = id?.fetchFrom ?? "?";
    out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
/** Pure post-seal read-back verdict: PASS only when the manifest is sealed and every stored fetch verifies. */
export function readbackVerdict(r: { listed: number; verifiedOk: number; failed: number; sealed: boolean }): "PASS" | "FAIL" {
  return r.sealed && r.listed > 0 && r.failed === 0 && r.verifiedOk === r.listed ? "PASS" : "FAIL";
}

/** Post-seal read-back (read-only: GET/LIST only, no Massive key): every stored fetch decodes and matches. */
async function readback(): Promise<number> {
  const r2 = R2ObjectClient.fromEnv(process.env);
  let sealed = false;
  try { sealed = Boolean(await readTenMinRangeManifest(r2 as never, ONEOFF_CAL_FROM, ONEOFF_CAL_TO, { allowEmpty: true })); } catch { sealed = false; }
  const stored = await listStoredTenMinRange(r2 as never, ONEOFF_CAL_FROM, ONEOFF_CAL_TO);
  let verifiedOk = 0; let failed = 0;
  for (const [key, pages] of stored) {
    const id = parseFetchIdentityKey(key) as never;
    let v: unknown;
    try { v = await verifyStoredTenMinRangeFetch(r2 as never, ONEOFF_CAL_FROM, ONEOFF_CAL_TO, id, { provider: "massive-stocks", storedPages: pages }); } catch { v = undefined; }
    if (v) verifiedOk++; else failed++;
  }
  const verdict = readbackVerdict({ listed: stored.size, verifiedOk, failed, sealed });
  console.log(`READBACK ${verdict} sealed=${sealed} listed=${stored.size} ok=${verifiedOk} failed=${failed}`);
  return verdict === "PASS" ? 0 : 1;
}

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "";
  if (mode === "readback") return readback();
  if (mode === "next") {
    // Workflow helper: RESULT/FETCH_OUTCOME/CHAIN_INDEX -> dispatch | post_seal | alert (anything unknown => alert).
    const ok = process.env.FETCH_OUTCOME === "success";
    const r = ok && ["sealed", "budget"].includes(process.env.RESULT ?? "") ? (process.env.RESULT as OneOffResult) : "fatal";
    const idx = /^\d{1,3}$/u.test(process.env.CHAIN_INDEX ?? "") ? Number(process.env.CHAIN_INDEX) : Number.MAX_SAFE_INTEGER;
    console.log(decideOneOffNext(r, idx));
    return 0;
  }
  const DRY = mode === "dry-plan";
  if (mode !== "run" && !DRY) { console.log("usage: oct2024-tenmin-oneoff.ts run|dry-plan"); return 64; }
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
  const out = (k: string, v: string | number) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const t0 = Date.now();
  const budgetMs = parseOneOffBudgetMs(process.env.ONEOFF_BUDGET_MS);
  let floor = parseOneOffFloor(process.env.ONEOFF_FLOOR);
  const chainIndex = parseChainIndex(process.env.ONEOFF_CHAIN_INDEX);
  const repo = process.env.GITHUB_REPOSITORY ?? "PeaceG03/PeaceSTOCKS";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!DRY) assertPinnedZstdForWriting();

  let puts = 0;
  const r2Fetch: typeof fetch = async (u, i) => {
    for (let attempt = 1; ; attempt++) {
      try { return await timedFetch(120_000)(u, i); }
      catch (e) { if (attempt >= 3) throw e; log(`r2 retry ${attempt}: ${errorClass(e)}`); await new Promise((r) => setTimeout(r, 5_000 * attempt)); }
    }
  };
  const env = process.env;
  const r2 = new R2ObjectClient({ accountId: env.PEACESTOCKS_R2_ACCOUNT_ID ?? "", bucket: env.PEACESTOCKS_R2_BUCKET ?? "", accessKeyId: env.PEACESTOCKS_R2_ACCESS_KEY_ID ?? "", secretAccessKey: env.PEACESTOCKS_R2_SECRET_ACCESS_KEY ?? "", fetchImpl: r2Fetch });
  const store = guardedStore(r2 as never, { dry: DRY, onPut: () => { puts += 1; } });

  const storage = new ObjectMarketStorage(r2 as never);
  const securities = await storage.loadSecurities();
  const dailyBars = await storage.loadDailyBarSessions("2024-10");
  const monthBody = await r2.get("permanent/daily-bars/2024-10.jsonl");
  if (!monthBody) throw new Error("DAILY_BARS_2024_10_MISSING");
  const dv = dollarVolumeBySecurity(new TextDecoder().decode(monthBody), ONEOFF_FIRST_FLOOR);

  // GitHub runs check (cached 60 s while nothing is active; a found run / failed check is re-checked each minute).
  let runsOkAt = 0;
  const scannerRuns = async (): Promise<ScannerRunLike[] | { error: string }> => {
    try {
      const res = await timedFetch(30_000)(`https://api.github.com/repos/${repo}/actions/workflows/scanner.yml/runs?per_page=30`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
      if (!res.ok) return { error: `http-${res.status}` };
      const body = (await res.json()) as { workflow_runs?: { id: number; status: string; event: string; display_title?: string }[] };
      return (body.workflow_runs ?? []).map((r) => ({ id: r.id, status: r.status, event: r.event, display_title: r.display_title ?? null }));
    } catch (e) { return { error: errorClass(e) }; }
  };
  let pauses = 0, written = 0, resumedSeen = 0, requests = 0, http = 0, budgetHit = false;
  const shouldYield = async (): Promise<string | undefined> => {
    let paused: string | undefined;
    for (;;) {
      if (Date.now() - t0 >= budgetMs) { budgetHit = true; return "BUDGET"; }
      const now = new Date();
      let reason = inOneOffGuardWindow(now) ? "GUARD_WINDOW" : undefined;
      if (!reason && Date.now() - runsOkAt >= 60_000) {
        reason = oneOffPauseReason(now, await scannerRuns());
        if (!reason) runsOkAt = Date.now();
      }
      if (!reason) break;
      if (paused !== reason) { if (!paused) pauses += 1; paused = reason; log(`pause: ${reason}`); }
      runsOkAt = 0;
      await new Promise((r) => setTimeout(r, 60_000));
    }
    if (paused) log("resume");
    resumedSeen += 1;
    if (resumedSeen % 500 === 0) log(`items: ${resumedSeen} (stored ones are verified, not re-fetched) fetched=${written} puts=${puts}`);
    return undefined;
  };
  const countingFetch: typeof fetch = async (u, i) => { http += 1; return timedFetch(90_000)(u, i); };
  const provider = new MassiveMarketProvider({ keepRawReplies: true, minRequestIntervalMs: ONEOFF_SPACING_MS, fetchImpl: countingFetch });
  class WindowGone extends Error {}
  let firstFetchAt = 0;
  const fetchPages = async (sec: { securityId: string; symbol: string }, from: string, to: string) => {
    requests += 1;
    try {
      const pages = await provider.getTenMinuteRangeReplies(sec, from, to);
      written += 1;
      if (!firstFetchAt) firstFetchAt = Date.now();
      if (written % 50 === 0) {
        const min = (Date.now() - firstFetchAt) / 60_000;
        log(`progress: fetched=${written} rate=${min > 0 ? (written / min).toFixed(2) : "-"}/min requests=${requests} http=${http} 429s=${provider.rateLimitedResponses} puts=${puts} pauses=${pauses}`);
      }
      return pages;
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (m.startsWith("MASSIVE_HTTP_403")) {
        if (/timeframe|upgrade|plan doesn|entitle/iu.test(m)) { log("403: window (floor session GONE)"); throw new WindowGone("MASSIVE_HTTP_403:TENMIN_WINDOW_GONE"); }
        log("403: per-ticker (recorded as a gap)");
        throw new Error("TENMIN_TICKER_FORBIDDEN");
      }
      throw e;
    }
  };

  out("chain_index", chainIndex);
  const gone: string[] = [];
  for (;;) {
    const u = universeForTenMinRange(securities, dailyBars, floor, ONEOFF_CAL_TO, {});
    const fetches = liquidityOrder(u.fetches, dv);
    const stored = await listStoredTenMinRange(store as never, ONEOFF_CAL_FROM, ONEOFF_CAL_TO);
    const byFrom = storedByFetchFrom(stored);
    log(`plan: floor=${floor} planned=${fetches.length} securities=${u.securities.length} gaps=${u.gaps.length} refusal=${u.refusal ? "yes" : "none"} storedFetches=${stored.size} storedByFetchFrom=${JSON.stringify(byFrom)} remaining~=${Math.max(0, fetches.length - stored.size)} chain=${chainIndex}`);
    out("floor", floor); out("stored_at_start", stored.size); out("stored_from_floor0", byFrom[ONEOFF_FIRST_FLOOR] ?? 0);
    if (u.refusal) { log("RESULT refused (universe refusal)"); out("result", "refused"); return 1; }
    if (DRY) { log(`DRY PASS (no Massive requests, no PUTs; top-5 order hash ${fetches.slice(0, 5).map((f) => f.securityId.slice(-4)).join(",")})`); out("result", "dry"); return 0; }
    try {
      const res = await writeTenMinRangeReplyDust({
        store: store as never, root: `${process.env.RUNNER_TEMP ?? "/tmp"}/oct2024-tenmin-root`, provider: provider.providerName,
        from: ONEOFF_CAL_FROM, to: ONEOFF_CAL_TO, fetches,
        initialGaps: [{ securityId: "", symbol: "", reason: TENMIN_AGED_OUT, at: new Date().toISOString(), fetchFrom: ONEOFF_CAL_FROM, fetchTo: addCalendarDays(floor, -1) }, ...u.gaps],
        securityLink: { status: u.securityLink, source: u.linkSource }, delistedCoverage: TENMIN_DELISTED_COVERAGE_MISSING,
        shouldYield, fetchPages,
      });
      const min = firstFetchAt ? (Date.now() - firstFetchAt) / 60_000 : 0;
      log(`writer: sealed=${res.sealed} alreadySealed=${res.alreadySealed} written=${res.fetchesWritten} resumed=${res.fetchesResumed} stored=${res.fetchesStored} gaps=${res.gaps.length} yielded=${res.yieldedForScan ? errorClass(res.yieldedForScan) : "-"} outage=${res.outageStop ? "yes" : "-"} puts=${puts} rate=${min > 0 ? (res.fetchesWritten / min).toFixed(2) : "-"}/min 429s=${provider.rateLimitedResponses}`);
      out("written", res.fetchesWritten); out("resumed", res.fetchesResumed); out("stored", res.fetchesStored); out("puts", puts);
      if (res.outageStop) { log("outage stop: waiting 10 min, then resuming"); await new Promise((r) => setTimeout(r, 10 * 60_000)); continue; }
      if (res.sealed) {
        // Read-back of the seal itself (read-only): the manifest must parse and name > 0 securities.
        const m = await readTenMinRangeManifest(store as never, ONEOFF_CAL_FROM, ONEOFF_CAL_TO, { allowEmpty: true });
        const ok = !!m && m.securityCount > 0;
        log(`seal read-back: ${ok ? "PASS" : "FAIL"} securities=${m?.securityCount ?? 0} gaps=${m?.gaps?.length ?? 0}`);
        out("result", ok ? "sealed" : "fatal"); out("sealed_at", Math.floor(Date.now() / 1000));
        return ok ? 0 : 1;
      }
      if (budgetHit || res.yieldedForScan === "BUDGET") { log("RESULT budget (clean stop; next run resumes by verify)"); out("result", "budget"); return 0; }
      log("RESULT fatal (writer returned unsealed without a budget stop)"); out("result", "fatal"); return 1;
    } catch (e) {
      if (e instanceof WindowGone || String((e as Error)?.message).includes("TENMIN_WINDOW_GONE") || String((e as Error)?.message).includes("timeframe")) {
        gone.push(floor);
        const next = nextOneOffFloor(floor);
        log(`floor ${floor} GONE; advancing to ${next ?? "none"}`);
        if (!next) { out("result", "fatal"); return 1; }
        floor = next; out("floor", floor);
        continue;
      }
      log(`RESULT fatal: ${errorClass(e)}`); out("result", "fatal"); return 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.log(`${new Date().toISOString()} RESULT fatal: ${errorClass(e)}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "result=fatal\n"); process.exitCode = 1; });
}
