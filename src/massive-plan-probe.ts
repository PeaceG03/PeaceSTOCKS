// Massive plan probe (1 request): can the key reach one session older than the current history window? A 200 with
// bars => the plan's history window grew (older history is reachable); a 403 => same plan. Also reads a rate-limit
// header when Massive sends one. Logs only PASS/FAIL + booleans; never the URL (it carries the key).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { addCalendarDays, effectiveHistoryWindowStart, lastCompletedSessionDate } from "./tenmin-history";
import { backfillProbeDates } from "./tenmin-backfill";

export interface PlanProbe { olderReachable: boolean | undefined; ratePerMin: number | undefined; probedFrom: string; status: number | "error" }

export function classifyPlanProbe(status: number | "error", body: string, rateHeader: string | null, probedFrom: string): PlanProbe {
  let olderReachable: boolean | undefined;
  if (status === 200) {
    try { olderReachable = Number((JSON.parse(body) as { resultsCount?: number }).resultsCount ?? 0) > 0; } catch { olderReachable = undefined; }
  } else if (status === 403) olderReachable = false;
  const r = rateHeader ? Number(rateHeader) : NaN;
  return { olderReachable, ratePerMin: Number.isFinite(r) && r > 0 ? r : undefined, probedFrom, status };
}

/** Probe window: the 10 calendar days ending 30 days before the current window start. */
export function probeDates(windowStart: string): { from: string; to: string } {
  return { from: addCalendarDays(windowStart, -40), to: addCalendarDays(windowStart, -30) };
}

/** Deeper probe: below the earliest stored pair when known (TENMIN_EARLIEST_STORED), else below the window. */
export function probeRange(now: Date, earliestStored?: string): { from: string; to: string } {
  if (earliestStored && /^\d{4}-\d{2}-\d{2}$/u.test(earliestStored)) return backfillProbeDates(earliestStored);
  return probeDates(effectiveHistoryWindowStart(lastCompletedSessionDate(now)));
}

export async function probeMassivePlan(apiKey: string, now = new Date(), f: typeof fetch = fetch, base = "https://api.massive.com", earliestStored?: string): Promise<PlanProbe> {
  const { from, to } = probeRange(now, earliestStored);
  const url = new URL(`${base}/v2/aggs/ticker/SPY/range/1/day/${from}/${to}`);
  url.searchParams.set("apiKey", apiKey);
  try {
    const r = await f(url, { signal: AbortSignal.timeout(30_000) });
    return classifyPlanProbe(r.status, await r.text(), r.headers.get("x-ratelimit-limit"), from);
  } catch {
    return classifyPlanProbe("error", "", null, from);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeMassivePlan(process.env.MASSIVE_API_KEY ?? "", new Date(), fetch, "https://api.massive.com", process.env.TENMIN_EARLIEST_STORED || undefined).then((p) => {
    if (process.env.TENMIN_PLAN_FILE) writeFileSync(process.env.TENMIN_PLAN_FILE, `${JSON.stringify(p)}\n`);
    console.log(`plan-probe: status=${p.status} olderReachable=${p.olderReachable} rate=${p.ratePerMin ?? "n/a"}`);
  }, () => console.log("plan-probe: FAIL"));
}
