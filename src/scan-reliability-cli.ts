/**
 * Read-only scan reliability report from evidence already on disk (no network, no keys):
 *
 *   tsx src/scan-reliability-cli.ts --status <dir of prediction-status/<session>.jsonl> --from YYYY-MM-DD --to YYYY-MM-DD \
 *     [--runs <scanner-jobs.jsonl from gh run view --json ...>] --out <dir>
 *
 * Writes <out>/scan-reliability.json and <out>/scan-reliability.md. Output is dates, counts and
 * reason codes only (no symbols): the prediction-status records carry none, and the Actions input is
 * job names and conclusions.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PredictionStatus } from "./contracts";
import { actionsBySession, scanReliability, type ScannerRunSummary } from "./scan-reliability";

function arg(args: string[], key: string, fallback?: string): string {
  const i = args.indexOf(`--${key}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined || v.startsWith("--")) throw new Error(`MISSING_ARG:${key}`);
  return v;
}

const lines = (text: string) => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export function scanReliabilityMain(args: string[]): void {
  const dir = arg(args, "status");
  const out = arg(args, "out");
  const from = arg(args, "from");
  const to = arg(args, "to");
  const runsPath = args.includes("--runs") ? arg(args, "runs") : undefined;
  const records: PredictionStatus[] = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => lines(readFileSync(join(dir, f), "utf8")) as PredictionStatus[]);
  const report = scanReliability(records, from, to);
  const runs: ScannerRunSummary[] = runsPath ? (lines(readFileSync(runsPath, "utf8")) as Array<ScannerRunSummary & { error?: boolean }>).filter((r) => !r.error) : [];
  const actions = runsPath ? actionsBySession(runs, report.rows.map((r) => r.sessionDate)) : undefined;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "scan-reliability.json"), `${JSON.stringify({ ...report, actions, actionsRunsRead: runs.length }, null, 2)}\n`);
  const md = [
    `# Scan reliability ${from}..${to}`,
    "",
    `Sessions ${report.sessions}, frozen before the next 09:30 ET open: ${report.onTime}. Current streak ${report.currentStreak}, longest ${report.longestStreak}.`,
    "",
    `| session | outcome | min before open | status records${actions ? " | runs in window | scan ran/ok/failed | backstop ok" : ""} |`,
    `|---|---|---|---${actions ? "|---|---|---" : ""}|`,
    ...report.rows.map((r, k) => {
      const a = actions?.[k];
      const extra = a ? ` | ${a.runs} | ${a.scanRan}/${a.scanSucceeded}/${a.scanFailed} | ${a.backstopSucceeded}` : "";
      return `| ${r.sessionDate} | ${r.outcome} | ${r.minutesBeforeOpen === undefined ? "" : Math.round(r.minutesBeforeOpen)} | ${r.records}${extra} |`;
    }),
    "",
  ].join("\n");
  writeFileSync(join(out, "scan-reliability.md"), md);
  console.log(`scan reliability ${from}..${to}: sessions=${report.sessions} onTime=${report.onTime} currentStreak=${report.currentStreak} longestStreak=${report.longestStreak} misses=${report.misses.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) scanReliabilityMain(process.argv.slice(2));
