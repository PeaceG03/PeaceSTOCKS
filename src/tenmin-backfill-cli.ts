// Auto-backfill detection CLI (read-only: R2 HEADs only, no Massive call, no writes to the store).
//   floor:  earliest stored ten-minute pair start -> $GITHUB_OUTPUT earliest_stored=YYYY-MM-DD
//   decide: plan file (massive-plan-probe) + earliest -> $GITHUB_OUTPUT backfill_action=dispatch|hold|daily
// Dispatching the history chain for older ranges is not wired yet (the chain's range planner, the dated ticker
// index 2-year clamp and the daily-bars window all stop at the current window); "dispatch" is logged only.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { R2ObjectClient } from "./object-store";
import { decideBackfill, earliestStoredPairStart, planBackfillRanges, tenMinPairManifestKey } from "./tenmin-backfill";

function output(k: string, v: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

export function backfillDecisionFromPlan(planJson: string | undefined, earliest: string, keyBusy: boolean) {
  let plan: { olderReachable?: boolean; probedFrom?: string } = {};
  try { plan = planJson ? JSON.parse(planJson) : {}; } catch { plan = {}; }
  const floor = plan.olderReachable === true && plan.probedFrom ? plan.probedFrom : earliest;
  const pending = planBackfillRanges(earliest, floor).length;
  return { action: decideBackfill(plan.olderReachable, pending, keyBusy), pending, floor };
}

async function main(cmd: string | undefined): Promise<void> {
  const e = process.env;
  if (cmd === "floor") {
    const c = R2ObjectClient.fromEnv(e);
    const earliest = await earliestStoredPairStart(async (p) => (await c.head(tenMinPairManifestKey(p))) !== undefined);
    output("earliest_stored", earliest);
    console.log(`backfill-floor: earliest_stored=${earliest}`);
    return;
  }
  if (cmd === "decide") {
    const f = e.TENMIN_PLAN_FILE;
    const d = backfillDecisionFromPlan(f && existsSync(f) ? readFileSync(f, "utf8") : undefined, e.TENMIN_EARLIEST_STORED || "2024-09-01", e.TENMIN_KEY_BUSY === "true");
    output("backfill_action", d.action);
    console.log(`backfill-decide: action=${d.action} pending=${d.pending} floor=${d.floor}`);
    return;
  }
  throw new Error("TENMIN_BACKFILL_CLI_USAGE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((err: unknown) => { console.log(`backfill-cli: FAIL ${(err as Error).message}`); process.exitCode = 1; });
}
