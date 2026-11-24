/** Offline only. No provider, object store, network client or credentials. See docs/RESEARCH_HARNESS.md. */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CorporateAction, SecurityMasterRecord } from "./contracts";
import { AppendOnlyLog } from "./append-only-log";
import { EvalHistory, type EvalBar } from "./holdout-eval";
import { buildHarnessSession, splitDatesById } from "./research-harness-data";
import type { HarnessSession } from "./research-costs";
import { HeldOutSeal, walkForwardFolds, type FoldConfig } from "./research-folds";
import { evaluateStrategy, type StrategyConfig, type VariantRecord } from "./research-variants";
import { holmAdjusted } from "./research-stats";
import { assertCostFloor, verdictFor } from "./research-verdict";

export function dateArg(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    throw new Error("INVALID_DATE");
  return value;
}
const shift = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function arg(args: string[], key: string, fallback?: string): string {
  const i = args.indexOf(`--${key}`);
  const v = i < 0 ? fallback : args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`MISSING_ARG:${key}`);
  return v;
}

/** Local JSONL only; held-out prices are never retained or used in a development run. */
export async function loadResearchData(root: string, from: string, before: string, minBars = 1000): Promise<{
  history: EvalHistory; master: SecurityMasterRecord[]; actions: CorporateAction[];
}> {
  const loadFrom = shift(from, -370); // full year for eligibility, not today's all-time count
  const kept = new Map<string, EvalBar>();
  const cursor = new Date(`${loadFrom.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= before.slice(0, 7)) {
    const path = join(root, "permanent/daily-bars", `${cursor.toISOString().slice(0, 7)}.jsonl`);
    if (existsSync(path)) {
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const b = JSON.parse(line) as EvalBar;
        if (b.sessionDate < loadFrom || b.sessionDate >= before) continue;
        const key = `${b.securityId}|${b.sessionDate}`;
        if (!kept.has(key) || b.revision >= kept.get(key)!.revision)
          kept.set(key, { securityId: b.securityId, sessionDate: b.sessionDate, open: b.open, close: b.close, volume: b.volume, revision: b.revision });
      }
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const history = new EvalHistory(kept.values(), minBars);
  kept.clear();
  const master = JSON.parse(readFileSync(join(root, "permanent/security-master.json"), "utf8")) as SecurityMasterRecord[];
  // Required: a missing split source fails closed (never silently evaluate raw prices).
  const actions = readFileSync(join(root, "permanent/corporate-actions.jsonl"), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s) as CorporateAction);
  return { history, master, actions };
}

export async function researchMain(args: string[]): Promise<void> {
  const out = arg(args, "out");
  mkdirSync(out, { recursive: true });
  const seal = new HeldOutSeal(join(out, "heldout.jsonl"));
  if (args[0] === "unseal") {
    // Deliberately unavailable to automated jobs. No unseal is performed by the baseline command.
    if (!process.stdin.isTTY) throw new Error("HUMAN_TTY_REQUIRED");
    seal.unseal(arg(args, "strategy"), arg(args, "by"), arg(args, "reason"));
    return;
  }
  if (args[0] !== "baseline") throw new Error("EXPECTED_BASELINE_OR_UNSEAL");
  const root = arg(args, "data");
  const from = dateArg(arg(args, "from", "2025-03-03"));
  const heldOut = { from: dateArg(arg(args, "heldout-from", "2026-08-27")), to: dateArg(arg(args, "heldout-to", "2026-11-20")) };
  if (!(from < heldOut.from && heldOut.from < heldOut.to)) throw new Error("INVALID_RESEARCH_RANGE");
  // Cost floor (docs/RESEARCH_HARNESS.md): refused before any data is read or any strategy registered.
  const bps = assertCostFloor(Number(arg(args, "bps", "10")));
  const foldsConfig: FoldConfig = {
    trainSessions: Number(arg(args, "train", "63")), testSessions: Number(arg(args, "test", "63")),
    embargoSessions: Number(arg(args, "embargo", "2")), mode: arg(args, "mode", "rolling") === "expanding" ? "expanding" : "rolling",
  };
  const scanner = arg(args, "scanner"); // exact head/tree supplied by caller, makes the experiment reproducible
  const lists = ["TOP_15_OVERALL", "TOP_50_OVERALL", "STRONGEST_MOMENTUM", "FASTEST_IMPROVING", "DEFENSIVE_LOW_RISK"];
  const strategies: StrategyConfig[] = lists.map((list) => ({
    name: list, candidates: [{ kind: "scanner-list", list, scanner }], costs: { slippageBpsPerSide: bps },
    folds: foldsConfig, outcome: "open-to-next-open", splits: "as-known",
  }));
  // REGISTER before opening prices. Baseline never calls evaluateOnce; the period stays sealed.
  for (const strategy of strategies) seal.register(strategy, heldOut);
  console.log(`loading development data before ${heldOut.from}; held-out reserved, not evaluated`);
  const { history, master, actions } = await loadResearchData(root, from, heldOut.from);
  const indexes = history.sessions.map((d, i) => [d, i] as const).filter(([d]) => d >= from);
  if (indexes.length < 3) throw new Error("INSUFFICIENT_DEVELOPMENT_DATA");
  const splitDates = splitDatesById(actions);
  const sessions: HarnessSession[] = [];
  let excluded = 0;
  for (const [k, [d, i]] of indexes.entries()) {
    const got = buildHarnessSession(master, history, i, { splitActions: actions }, splitDates);
    // Trailing two dates retained as empty placeholders so fold guard can embargo outcomes.
    sessions.push(got?.session ?? { sessionDate: d, universeSize: 0, universeMean: 0, lists: {} });
    excluded += got?.excludedBySplitAdjust ?? 0;
    if (k % 25 === 0) console.log(`development progress ${k + 1}/${indexes.length}; aggregate only`);
  }
  const folds = walkForwardFolds(sessions.length, foldsConfig);
  const log = new AppendOnlyLog<VariantRecord>(join(out, "variants.jsonl"));
  const evaluations = strategies.map((s) => evaluateStrategy(sessions, folds, s, log));
  // Recompute the correction AFTER all five variants were registered/evaluated, not incrementally.
  const all = log.entries();
  const latest = new Map<string, VariantRecord>();
  for (const entry of all) latest.set(entry.strategyHash, entry);
  const family = [...latest.values()];
  const variantsTried = new Set(all.flatMap((r) => r.candidateHashes)).size;
  const familySize = Math.max(variantsTried, family.length);
  const adjusted = holmAdjusted(family.map((r) => r.pooledP), familySize);
  const results = evaluations.map((evaluation) => {
    evaluation.variantsTried = variantsTried;
    evaluation.familySize = familySize;
    evaluation.adjustedP = adjusted[family.findIndex((r) => r.strategyHash === evaluation.record.strategyHash)]!;
    const result = { ...evaluation, daily: undefined, verdict: verdictFor(evaluation, undefined) };
    const file = `${evaluation.record.name}.json`;
    writeFileSync(join(out, file), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${evaluation.record.name}: sessions=${evaluation.record.pooled.sessions} meanNet=${evaluation.record.pooled.meanNet} excessUniverse=${evaluation.record.pooled.excessUniverse.mean} excessSpy=${evaluation.record.pooled.excessSpy.mean} correctedP=${evaluation.adjustedP} positiveFolds=${evaluation.foldsPositive}/${folds.length} verdict=${result.verdict.verdict}`);
    return { file, ...result };
  });
  // No symbols or security IDs written to logs/results.
  const report = {
    scanner, from, developmentTo: sessions.at(-1)!.sessionDate, heldOut, heldOutEvaluated: false,
    contaminationWarning: "Reserved for this harness only. These dates were examined by earlier holdout-eval work; they are NOT a pristine final holdout. A genuinely untouched future period is required before improvement claims.",
    dataWarning: "Local bars were collected by the pre-fix ACTIVE-only backfill. Missing historical inactive bars cannot be recovered offline. This is a diagnostic baseline, not survivorship-free performance proof. No backfill was run.",
    splitKnowledge: "as-known", revisions: "latest stored revisions (not original publication vintages)",
    variantsTried, foldsConfig, folds, excludedBySplitAdjust: excluded, results,
  };
  writeFileSync(join(out, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await researchMain(process.argv.slice(2));
