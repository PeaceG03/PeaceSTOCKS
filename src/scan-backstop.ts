// Missed-scheduled-scan backstop (scanner.yml scan_backstop, on the reliable hourly :47 restarter cron).
// GitHub sometimes drops scheduled runs: the 05:30 UTC scan (and its 09:30 UTC backup slot) can silently
// never start. At the first :47 tick 30-89 min after a slot on Tue-Sat, if no scheduled "Scanner" run was
// created since that slot, dispatch scanner.yml mode=scan once. A redundant scan is harmless: the scan
// job only collects when collectionDue says the previous ET trading day is still missing, and it queues
// behind any R2 writer (peacestocks-r2-writer group). Fail closed: an API error dispatches nothing.
// Logs: PASS/FAIL + reason only.
import { pathToFileURL } from "node:url";

/** Scheduled scan slots in UTC minutes after midnight (scanner.yml crons "30 5" and "30 9", Tue-Sat). */
export const SCAN_SLOTS_UTC_MIN = [5 * 60 + 30, 9 * 60 + 30] as const;
export const SCAN_SLOT_DAYS = [2, 3, 4, 5, 6] as const;
/** A tick checks a slot only when it lands this many minutes after it (one hourly tick per slot). */
export const BACKSTOP_WINDOW_MIN = { from: 30, to: 89 } as const;
export const SCAN_RUN_NAME = "Scanner";

export interface ScanRunLike { event?: string; display_title?: string; created_at?: string }
export type BackstopPlan = { action: "none" | "dispatch"; why: string; slot?: string };

/** The slot this tick is responsible for, or null when the tick is outside every slot window. */
export function dueSlot(now: Date): Date | null {
  if (!(SCAN_SLOT_DAYS as readonly number[]).includes(now.getUTCDay())) return null;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const s of SCAN_SLOTS_UTC_MIN) {
    const after = mins - s;
    if (after >= BACKSTOP_WINDOW_MIN.from && after <= BACKSTOP_WINDOW_MIN.to) {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(s / 60), s % 60));
    }
  }
  return null;
}

export function planMissedScan(input: { now: Date; scanRuns: readonly ScanRunLike[] | { error: string } }): BackstopPlan {
  const slot = dueSlot(input.now);
  if (!slot) return { action: "none", why: "PASS no scan slot due on this tick" };
  const iso = slot.toISOString();
  if ("error" in input.scanRuns) return { action: "none", why: `FAIL run check failed (${input.scanRuns.error}); not dispatching`, slot: iso };
  const started = input.scanRuns.some((r) => r.event === "schedule" && r.display_title === SCAN_RUN_NAME
    && (Date.parse(r.created_at ?? "") || 0) >= slot.getTime() - 5 * 60_000);
  if (started) return { action: "none", why: "PASS scheduled scan started", slot: iso };
  return { action: "dispatch", why: "scheduled scan missing", slot: iso };
}

/** Plain-value form for tests and logs: ISO tick time + created_at of scheduled "Scanner" runs -> action. */
export function planMissedScanAt(nowIso: string, scheduledScanCreatedAt: readonly string[]): BackstopPlan["action"] {
  const scanRuns = scheduledScanCreatedAt.map((created_at) => ({ event: "schedule", display_title: SCAN_RUN_NAME, created_at }));
  return planMissedScan({ now: new Date(nowIso), scanRuns }).action;
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  return fetch(`${api}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

async function main(): Promise<number> {
  const now = new Date();
  if (!dueSlot(now)) { console.log("scan-backstop: PASS no scan slot due on this tick"); return 0; }
  let scanRuns: ScanRunLike[] | { error: string };
  try {
    const r = await gh(`/actions/workflows/scanner.yml/runs?event=schedule&per_page=50`);
    scanRuns = r.ok ? (((await r.json()) as { workflow_runs?: ScanRunLike[] }).workflow_runs ?? []) : { error: `http-${r.status}` };
  } catch { scanRuns = { error: "fetch" }; }
  const plan = planMissedScan({ now, scanRuns });
  if (plan.action === "none") { console.log(`scan-backstop: ${plan.why}`); return plan.why.startsWith("FAIL") ? 1 : 0; }
  const d = await gh(`/actions/workflows/scanner.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { mode: "scan" } }) });
  console.log(`scan-backstop: DISPATCH ${d.ok ? "PASS" : `FAIL http-${d.status}`} (${plan.why}, slot ${plan.slot})`);
  return d.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), () => { console.error("scan-backstop: FAIL"); process.exit(1); });
}
