/**
 * Offline held-out evaluation over a LOCAL copy of the stored bars. It never touches R2 or the
 * network and writes only the --out file. It prints aggregate metrics only (no symbols or ids).
 *
 *   tsx src/holdout-eval-cli.ts --data <dir> --from YYYY-MM-DD --to YYYY-MM-DD --horizon 1 \
 *     [--draws 1000] [--step 1] [--winsorize 0.01] [--out result.json]
 *
 * <dir> holds permanent/daily-bars/<YYYY-MM>.jsonl, permanent/security-master.json and
 * (optional) permanent/corporate-actions.jsonl, laid out as in the bucket.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { SecurityMasterRecord } from "./contracts";
import { EvalHistory, evaluateSession, summarize, type EvalBar, type SessionOutcome } from "./holdout-eval";

function arg(name: string, fallback?: string): string {
  const k = process.argv.indexOf(`--${name}`);
  const value = k >= 0 ? process.argv[k + 1] : fallback;
  if (value === undefined) throw new Error(`MISSING_ARG:${name}`);
  return value;
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 7) <= to.slice(0, 7)) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const dir = arg("data");
  const from = arg("from");
  const to = arg("to");
  const horizon = Number(arg("horizon", "1"));
  const draws = Number(arg("draws", "1000"));
  const step = Number(arg("step", "1"));
  const winsorize = Number(arg("winsorize", "0"));
  const out = arg("out", "");
  const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
  log(`held-out eval from=${from} to=${to} horizon=${horizon} draws=${draws} step=${step} winsorize=${winsorize}`);

  // Bars: enough before `from` for the scan window and feature lookbacks, and after `to` for outcomes.
  const loadFrom = shiftDays(from, -170);
  const loadTo = shiftDays(to, 45);
  const kept = new Map<string, EvalBar>();
  let lines = 0;
  for (const month of monthsBetween(loadFrom, loadTo)) {
    const path = `${dir}/permanent/daily-bars/${month}.jsonl`;
    if (!existsSync(path)) continue;
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      lines += 1;
      const b = JSON.parse(line) as EvalBar;
      if (b.sessionDate < loadFrom || b.sessionDate > loadTo) continue;
      const key = `${b.securityId}|${b.sessionDate}`;
      const prior = kept.get(key);
      // Same rule as the scanner's latestBars: highest revision; a later line wins a tie.
      if (!prior || b.revision >= prior.revision)
        kept.set(key, { securityId: b.securityId, sessionDate: b.sessionDate, open: b.open, close: b.close, volume: b.volume, revision: b.revision });
    }
    log(`loaded ${month} (lines so far ${lines}, bars kept ${kept.size})`);
  }
  const history = new EvalHistory(kept.values(), 1000);
  kept.clear();
  const master = JSON.parse(readFileSync(`${dir}/permanent/security-master.json`, "utf8")) as SecurityMasterRecord[];

  // Known splits / reverse splits inside (entry, exit] make an unadjusted return meaningless: drop that name-window.
  const splits = new Map<string, Set<string>>();
  const actionsPath = `${dir}/permanent/corporate-actions.jsonl`;
  if (existsSync(actionsPath))
    for (const line of readFileSync(actionsPath, "utf8").split("\n")) {
      if (!line) continue;
      const a = JSON.parse(line) as { securityId: string; actionType: string; effectiveDate: string };
      if (a.actionType !== "SPLIT" && a.actionType !== "REVERSE_SPLIT") continue;
      let set = splits.get(a.securityId);
      if (!set) splits.set(a.securityId, (set = new Set()));
      set.add(a.effectiveDate);
    }
  let droppedForSplit = 0;
  const excluded = (id: string, i: number, h: number) => {
    const dates = splits.get(id);
    if (!dates) return false;
    for (let k = i + 2; k <= i + h; k += 1)
      if (dates.has(history.sessions[k] ?? "")) return (droppedForSplit += 1), true;
    return false;
  };

  const outcomes: SessionOutcome[] = [];
  const indexes = history.sessions.map((d, i) => [d, i] as const).filter(([d]) => d >= from && d <= to);
  log(`sessions stored ${history.sessions.length} (${history.sessions[0]}..${history.sessions.at(-1)}), evaluated candidates ${indexes.length}`);
  for (const [k, [D, i]] of indexes.entries()) {
    if (k % step !== 0) continue;
    const started = Date.now();
    const got = evaluateSession(master, history, i, { horizon, randomDraws: draws, seed: 20261124, excluded, ...(winsorize ? { winsorize } : {}) });
    if (!got) {
      log(`${D}: no outcome window (needs ${horizon} later sessions)`);
      continue;
    }
    outcomes.push(got.outcome);
    const o = got.outcome;
    const fmt = (x: number | undefined) => (x === undefined ? "n/a" : (x * 100).toFixed(3) + "%");
    log(`${D}: universe ${o.universeSize} mean ${fmt(o.universeMean)} spy ${fmt(o.spy)} ic ${o.ic.toFixed(4)} | ${Object.entries(o.lists)
      .map(([t, l]) => `${t} n=${l.size} ${fmt(l.mean)}`)
      .join(" | ")} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
  const summary = summarize(outcomes);
  log(`split-dropped name-windows ${droppedForSplit}`);
  log(`SUMMARY sessions ${summary.sessions} meanIC ${summary.meanIC.toFixed(4)} icT ${summary.icTStat.toFixed(2)}`);
  for (const [type, s] of Object.entries(summary.lists))
    log(`SUMMARY ${type}: sessions ${s.sessions} mean ${(s.meanReturn * 100).toFixed(3)}% universe ${(s.universeMean * 100).toFixed(3)}% random ${(s.randomMean * 100).toFixed(3)}% spy ${s.spyMean === undefined ? "n/a" : (s.spyMean * 100).toFixed(3) + "%"} excess ${(s.meanExcess * 100).toFixed(3)}% t ${s.excessTStat.toFixed(2)} hit ${(s.hitRate * 100).toFixed(1)}% randomP ${s.randomP.toFixed(3)}`);
  if (out)
    writeFileSync(out, JSON.stringify({ from, to, horizon, draws, step, winsorize, sessionsEvaluated: outcomes.map((o) => o.sessionDate), droppedForSplit, summary }, null, 2) + "\n");
}

await main();
