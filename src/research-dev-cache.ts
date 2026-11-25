/**
 * Development-only point-in-time feature and outcome cache (< heldOutStart).
 *
 * Precomputes per-session eligible STOCK features and open(D+1) -> open(D+2) outcomes strictly
 * before `heldOutStart` (default 2026-08-27) so Phase 2 scoring experiments run in seconds without
 * re-streaming ~2.5 GB of raw JSONL bars. Refuses any session, entry, or exit >= heldOutStart,
 * refuses heldOutStart > 2026-08-27, refuses --out inside the repository, and embeds a SHA-256
 * manifest of raw bars, security master, corporate actions, and scanner/floor config so stale
 * pre-#136 caches are refused on read.
 * Offline only: no network, no provider, no live bucket, and no tickers/symbols stored.
 */
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableJson } from "./append-only-log";
import type { CanonicalDailyBar, CorporateAction, SecurityMasterRecord } from "./contracts";
import { ELIGIBILITY_FLOOR, floorExclusion } from "./eligibility-floor";
import { reconstructFeatures } from "./features";
import { EvalHistory, pointInTimeSecurities, scanInputBars, splitActionsKnownAt } from "./holdout-eval";
import { improvementValue, STOCK_LIST_ASSET_TYPE } from "./ranking";
import { dateArg, loadResearchData } from "./research-harness-cli";
import { openToNextOpen, splitDatesById } from "./research-harness-data";
import { scannerConfigHash } from "./research-scanner-label";
import { resolveSpyBenchmarkId, type SessionCalendar } from "./scanner";
import { splitAdjustedBars, splitEventsBySecurity } from "./split-adjust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export const DEV_CACHE_REFUSED_HELDOUT = "DEV_CACHE_REFUSED_HELDOUT";
export const DEV_CACHE_MANIFEST_MISMATCH = "DEV_CACHE_MANIFEST_MISMATCH";
export const DEV_CACHE_OUT_IN_REPO = "DEV_CACHE_OUT_IN_REPO";
export const DEFAULT_HELDOUT_START = "2026-08-27";

const REPO_TOP = fileURLToPath(new URL("..", import.meta.url));
const shift = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export interface DevCacheManifest {
  dailyBars: Array<{ file: string; sha256: string }>;
  securityMasterSha256: string;
  corporateActionsSha256: string;
  scannerConfigHash: string;
  manifestSha256: string;
}

export interface DevCacheExtraFeatures {
  return1d: number | null;
  return10d: number | null;
  overnightGap1d: number | null;
  intradayReturn1d: number | null;
  volumeRatio5v20: number | null;
  volatility60d: number | null;
  upDays20d: number | null;
  spyReturn5d: number | null;
  spyReturn20d: number | null;
  spyVolatility20d: number | null;
}

export interface DevCacheCandidate {
  securityId: string;
  features: Record<string, number | null>;
  improvement: number | null;
  extra: DevCacheExtraFeatures;
  outcome: number | null;
}

export interface DevCacheSession {
  sessionDate: string;
  entryDate: string;
  exitDate: string;
  universeSize: number;
  universeMean: number;
  spy?: number;
  candidates: DevCacheCandidate[];
}

export interface DevCacheMeta {
  kind: "dev-cache-meta";
  version: 3;
  from: string;
  heldOutStart: string;
  sessionCount: number;
  manifest: DevCacheManifest;
}

export function assertBeforeHeldOut(date: string, heldOutStart: string, role: string): void {
  if (date >= heldOutStart) throw new Error(`${DEV_CACHE_REFUSED_HELDOUT}:${role}:${date}>=${heldOutStart}`);
}

function hashFileSync(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n = 0;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function resolveForPathCheck(target: string): string {
  const abs = resolve(target);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent !== abs && existsSync(parent)) return join(realpathSync(parent), abs.slice(parent.length + 1));
  return abs;
}

function assertOutOutsideRepo(outFile: string, repoRoot: string): void {
  const repoReal = resolveForPathCheck(repoRoot);
  const outReal = resolveForPathCheck(outFile);
  const rel = relative(repoReal, outReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`${DEV_CACHE_OUT_IN_REPO}:${outFile}`);
  }
}

export function computeDevDataManifest(dataRoot: string, from: string, heldOutStart: string): DevCacheManifest {
  const loadFromMonth = shift(from, -370).slice(0, 7);
  const beforeMonth = heldOutStart.slice(0, 7);
  const barsDir = join(dataRoot, "permanent/daily-bars");
  const dailyBars = existsSync(barsDir)
    ? readdirSync(barsDir)
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/u.test(f))
        .filter((f) => {
          const ym = f.slice(0, 7);
          return ym >= loadFromMonth && ym <= beforeMonth;
        })
        .sort()
        .map((file) => ({ file, sha256: hashFileSync(join(barsDir, file)) }))
    : [];
  const securityMasterSha256 = hashFileSync(join(dataRoot, "permanent/security-master.json"));
  const corporateActionsSha256 = hashFileSync(join(dataRoot, "permanent/corporate-actions.jsonl"));
  const cfgHash = scannerConfigHash();
  const payload = { dailyBars, securityMasterSha256, corporateActionsSha256, scannerConfigHash: cfgHash };
  const manifestSha256 = createHash("sha256").update(stableJson(payload)).digest("hex");
  return { ...payload, manifestSha256 };
}

function retBack(closes: readonly number[], back: number): number | null {
  if (closes.length <= back) return null;
  const prior = closes[closes.length - 1 - back];
  const curr = closes[closes.length - 1];
  return prior !== undefined && curr !== undefined && prior > 0 ? curr / prior - 1 : null;
}

function sampleVol(closes: readonly number[], days: number): number | null {
  if (closes.length < days + 2) return null;
  const slice = closes.slice(-(days + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]!;
    const curr = slice[i]!;
    if (!(prev > 0)) return null;
    rets.push(curr / prev - 1);
  }
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const varSum = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varSum * 252);
}

function extraFromAdjusted(
  bars: readonly CanonicalDailyBar[],
  spyReturn5d: number | null,
  spyReturn20d: number | null,
  spyVolatility20d: number | null,
): DevCacheExtraFeatures {
  const closes = bars.map((b) => b.close);
  const last = bars.at(-1);
  const prev = bars.length >= 2 ? bars.at(-2) : undefined;
  const overnightGap1d = last && prev && prev.close > 0 && last.open > 0 ? last.open / prev.close - 1 : null;
  const intradayReturn1d = last && last.open > 0 ? last.close / last.open - 1 : null;
  let volumeRatio5v20: number | null = null;
  if (bars.length >= 20) {
    const v20 = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;
    const v5 = bars.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
    volumeRatio5v20 = v20 > 0 ? v5 / v20 : null;
  }
  let upDays20d: number | null = null;
  if (closes.length >= 21) {
    let up = 0;
    const tail = closes.slice(-21);
    for (let k = 1; k < tail.length; k += 1) if (tail[k]! > tail[k - 1]!) up += 1;
    upDays20d = up / 20;
  }
  return {
    return1d: retBack(closes, 1),
    return10d: retBack(closes, 10),
    overnightGap1d,
    intradayReturn1d,
    volumeRatio5v20,
    volatility60d: sampleVol(closes, 60),
    upDays20d,
    spyReturn5d,
    spyReturn20d,
    spyVolatility20d,
  };
}

export function extractDevCacheSession(
  master: readonly SecurityMasterRecord[],
  history: EvalHistory,
  i: number,
  heldOutStart: string,
  options: { splitActions: readonly CorporateAction[]; calendar?: SessionCalendar },
  splitDates: ReadonlyMap<string, ReadonlySet<string>> = splitDatesById(options.splitActions),
): DevCacheSession | undefined {
  const D = history.sessions[i];
  if (!D) return undefined;
  assertBeforeHeldOut(D, heldOutStart, "session");
  const entryDate = history.sessions[i + 1];
  const exitDate = history.sessions[i + 2];
  if (!entryDate || !exitDate) return undefined;
  assertBeforeHeldOut(entryDate, heldOutStart, "entry");
  assertBeforeHeldOut(exitDate, heldOutStart, "exit");

  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const securities = pointInTimeSecurities(master, history, i);
  const bars = scanInputBars(history, i, calendar);
  const spyId = resolveSpyBenchmarkId(securities);
  const benchmark = spyId
    ? bars.filter((b) => b.securityId === spyId && b.sessionDate <= D).sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
    : [];
  const spyCloses = benchmark.map((b) => b.close);
  const spyReturn5d = retBack(spyCloses, 5);
  const spyReturn20d = retBack(spyCloses, 20);
  const spyVolatility20d = sampleVol(spyCloses, 20);

  const bySecurity = new Map<string, CanonicalDailyBar[]>();
  for (const b of bars) {
    if (b.sessionDate > D) continue;
    let list = bySecurity.get(b.securityId);
    if (!list) bySecurity.set(b.securityId, (list = []));
    list.push(b);
  }
  const splits = splitEventsBySecurity(splitActionsKnownAt(options.splitActions, D, calendar));
  const eligible = securities.filter(
    (s) =>
      s.status === "ACTIVE" &&
      (s.eligibility === "LEVEL_2" || s.eligibility === "LEVEL_3") &&
      s.assetType === STOCK_LIST_ASSET_TYPE,
  );
  const outcomeFor = (id: string): number | null => {
    if (splitDates.get(id)?.has(exitDate)) return null;
    const r = openToNextOpen(history, id, i);
    return r === undefined ? null : r;
  };

  const candidates: DevCacheCandidate[] = [];
  const universeOutcomes: number[] = [];
  for (const security of eligible) {
    const byDate = new Map<string, CanonicalDailyBar>();
    const rawOwn = [...(bySecurity.get(security.securityId) ?? [])].sort(
      (a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.revision - b.revision,
    );
    for (const b of rawOwn) byDate.set(b.sessionDate, b);
    const ordered = [...byDate.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
    const adjusted = splitAdjustedBars(ordered, splits.get(security.securityId), D);
    if ("excluded" in adjusted) continue;
    if (floorExclusion(adjusted.bars, ELIGIBILITY_FLOOR, D)) continue;
    const derived = reconstructFeatures(security.securityId, D, adjusted.bars, benchmark);
    const improvement = improvementValue(adjusted.bars.map((b) => b.close));
    const outcome = outcomeFor(security.securityId);
    if (outcome !== null) universeOutcomes.push(outcome);
    candidates.push({
      securityId: security.securityId,
      features: derived.values,
      improvement,
      extra: extraFromAdjusted(adjusted.bars, spyReturn5d, spyReturn20d, spyVolatility20d),
      outcome,
    });
  }
  const spy = spyId ? outcomeFor(spyId) : null;
  return {
    sessionDate: D,
    entryDate,
    exitDate,
    universeSize: universeOutcomes.length,
    universeMean: universeOutcomes.length ? universeOutcomes.reduce((s, v) => s + v, 0) / universeOutcomes.length : 0,
    ...(spy === null ? {} : { spy }),
    candidates,
  };
}

export async function buildDevFeatureCache(options: {
  dataRoot: string;
  outFile: string;
  from?: string;
  heldOutStart?: string;
  minBars?: number;
  repoRoot?: string;
}): Promise<DevCacheMeta> {
  const from = dateArg(options.from ?? "2025-03-03");
  const heldOutStart = dateArg(options.heldOutStart ?? DEFAULT_HELDOUT_START);
  if (heldOutStart > DEFAULT_HELDOUT_START) {
    throw new Error(`${DEV_CACHE_REFUSED_HELDOUT}:heldout-after-${DEFAULT_HELDOUT_START}:${heldOutStart}`);
  }
  assertBeforeHeldOut(from, heldOutStart, "from");
  const minBars = options.minBars ?? 1000;
  if (!(Number.isInteger(minBars) && minBars >= 1)) throw new Error("INVALID_MIN_BARS");
  assertOutOutsideRepo(options.outFile, options.repoRoot ?? REPO_TOP);

  const manifest = computeDevDataManifest(options.dataRoot, from, heldOutStart);
  const { history, master, actions } = await loadResearchData(options.dataRoot, from, heldOutStart, minBars);
  for (const s of history.sessions) assertBeforeHeldOut(s, heldOutStart, "loaded-session");
  const splitDates = splitDatesById(actions);
  const indexes = history.sessions.map((d, i) => [d, i] as const).filter(([d]) => d >= from);
  const sessions: DevCacheSession[] = [];
  for (const [k, [, i]] of indexes.entries()) {
    const got = extractDevCacheSession(master, history, i, heldOutStart, { splitActions: actions }, splitDates);
    if (got) sessions.push(got);
    if (k % 25 === 0) console.log(`dev-cache progress ${k + 1}/${indexes.length}; aggregate only`);
  }
  const meta: DevCacheMeta = { kind: "dev-cache-meta", version: 3, from, heldOutStart, sessionCount: sessions.length, manifest };
  mkdirSync(dirname(options.outFile), { recursive: true });
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const stream = createWriteStream(options.outFile, { encoding: "utf8" });
    stream.on("error", rejectWrite);
    stream.on("finish", resolveWrite);
    stream.write(`${JSON.stringify(meta)}\n`);
    for (const s of sessions) stream.write(`${JSON.stringify({ kind: "session", ...s })}\n`);
    stream.end();
  });
  return meta;
}

export function readDevFeatureCache(
  cachePath: string,
  expectedHeldOutStart: string,
  expectedManifest: DevCacheManifest | string,
): {
  meta: DevCacheMeta;
  sessions: DevCacheSession[];
} {
  if (expectedHeldOutStart > DEFAULT_HELDOUT_START) {
    throw new Error(`${DEV_CACHE_REFUSED_HELDOUT}:heldout-after-${DEFAULT_HELDOUT_START}:${expectedHeldOutStart}`);
  }
  const lines = readFileSync(cachePath, "utf8").split("\n").filter(Boolean);
  if (!lines.length) throw new Error("DEV_CACHE_EMPTY");
  const meta = JSON.parse(lines[0]!) as DevCacheMeta;
  if (meta.kind !== "dev-cache-meta" || meta.version !== 3) throw new Error("DEV_CACHE_INVALID_META");
  if (meta.heldOutStart > expectedHeldOutStart) {
    throw new Error(`${DEV_CACHE_REFUSED_HELDOUT}:meta:${meta.heldOutStart}>${expectedHeldOutStart}`);
  }
  const wantSha = typeof expectedManifest === "string" ? expectedManifest : expectedManifest.manifestSha256;
  const gotSha = meta.manifest?.manifestSha256;
  if (!gotSha || gotSha !== wantSha) {
    throw new Error(`${DEV_CACHE_MANIFEST_MISMATCH}:${gotSha ?? "missing"}!=${wantSha}`);
  }
  const sessions: DevCacheSession[] = [];
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line) as { kind: string } & DevCacheSession;
    if (row.kind !== "session") continue;
    assertBeforeHeldOut(row.sessionDate, expectedHeldOutStart, "cached-session");
    assertBeforeHeldOut(row.entryDate, expectedHeldOutStart, "cached-entry");
    assertBeforeHeldOut(row.exitDate, expectedHeldOutStart, "cached-exit");
    sessions.push({
      sessionDate: row.sessionDate,
      entryDate: row.entryDate,
      exitDate: row.exitDate,
      universeSize: row.universeSize,
      universeMean: row.universeMean,
      ...(row.spy === undefined ? {} : { spy: row.spy }),
      candidates: row.candidates,
    });
  }
  return { meta, sessions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (k: string, fb?: string) => {
    const i = args.indexOf(`--${k}`);
    const v = i < 0 ? fb : args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`MISSING_ARG:${k}`);
    return v;
  };
  const meta = await buildDevFeatureCache({
    dataRoot: get("data"),
    outFile: get("out"),
    from: get("from", "2025-03-03"),
    heldOutStart: get("heldout-from", DEFAULT_HELDOUT_START),
    minBars: Number(get("min-bars", "1000")),
  });
  console.log(`dev-cache built: sessions=${meta.sessionCount} heldOutStart=${meta.heldOutStart} manifest=${meta.manifest.manifestSha256.slice(0, 12)}`);
}
