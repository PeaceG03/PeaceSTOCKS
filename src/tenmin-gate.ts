// History-chain redispatch gate derived from durable state (no Actions-variable write, no extra token).
// Repo variable TENMIN_AUTO_REDISPATCH:
//   "true"                              -> on
//   "until_oneoff_seal:<workflow file>" -> paused while a one-off fetch owns the Massive key; ON as soon as that
//                                          workflow has a successful post-seal run on main (run-name below). The
//                                          post-seal job only succeeds after a full R2 read-back of a sealed range,
//                                          so the marker is the verified seal itself. Workflow runs do not expire
//                                          like artifacts, and only a person can flip the variable back.
//   anything else / unset               -> off (manual pause)
// Fail closed: any API error while resolving keeps the gate off.
// guard mode (scanner.yml restarter_guard, hourly): gate off/blocked AND no one-off run active AND the newest
// one-off activity ended more than 30 min ago -> one deduped scanner-alert issue. Logs: PASS/FAIL + counts only.
import { pathToFileURL } from "node:url";

export const ONEOFF_GATE_PREFIX = "until_oneoff_seal:";
/** run-name of a one-off workflow's post-seal run (must match the workflow's run-name expression). */
export const ONEOFF_SEALED_RUN_NAME = "One-off ten-minute fetch: sealed (post-seal)";
export const GUARD_IDLE_MS = 30 * 60_000;
export const GUARD_ALERT_TITLE = "History chain redispatch is off with no one-off fetch running";
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export type GateParse = { kind: "on" } | { kind: "off" } | { kind: "until_seal"; workflow: string };

export function parseGate(value: string | undefined): GateParse {
  if (value === "true") return { kind: "on" };
  if (value?.startsWith(ONEOFF_GATE_PREFIX)) {
    const workflow = value.slice(ONEOFF_GATE_PREFIX.length);
    if (WORKFLOW_FILE.test(workflow)) return { kind: "until_seal", workflow };
  }
  return { kind: "off" };
}

export interface RunLike {
  id: number;
  status: string | null;
  conclusion: string | null;
  head_branch?: string | null;
  event?: string;
  display_title?: string;
  name?: string;
  updated_at?: string;
}

/** Pure: does this run list hold a verified post-seal marker? */
export function hasSealedMarker(runs: readonly RunLike[]): boolean {
  return runs.some(
    (r) => r.status === "completed" && r.conclusion === "success" && r.head_branch === "main" &&
      r.event === "workflow_dispatch" && r.display_title === ONEOFF_SEALED_RUN_NAME,
  );
}

/** Pure: effective kill-switch value ("true" or the raw value) for the parsed gate and marker. */
export function effectiveGate(value: string | undefined, sealed: boolean | undefined): string | undefined {
  const g = parseGate(value);
  if (g.kind === "on") return "true";
  if (g.kind === "until_seal" && sealed === true) return "true";
  return value;
}

export type GuardPlan = { action: "none"; why: string } | { action: "alert"; why: string };

/** Pure restarter-guard decision. */
export function planGateGuard(input: {
  effective: string | undefined;
  oneOffRuns: readonly RunLike[] | { error: string };
  now: Date;
  openAlertTitles: readonly string[];
}): GuardPlan {
  if (input.effective === "true") return { action: "none", why: "PASS gate on" };
  if ("error" in input.oneOffRuns) return { action: "alert", why: `gate off; one-off run check failed (${input.oneOffRuns.error})` };
  const active = input.oneOffRuns.filter((r) => r.status !== "completed");
  if (active.length > 0) return { action: "none", why: `PASS one-off active (${active.length})` };
  const last = Math.max(0, ...input.oneOffRuns.map((r) => Date.parse(r.updated_at ?? "") || 0));
  const idle = input.now.getTime() - last;
  if (idle <= GUARD_IDLE_MS) return { action: "none", why: "PASS one-off ended under 30 min ago" };
  if (input.openAlertTitles.includes(GUARD_ALERT_TITLE)) return { action: "none", why: "PASS already alerted (open issue)" };
  return { action: "alert", why: "gate off/blocked, no one-off run for over 30 min" };
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  return fetch(`${api}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN ?? env.GH_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function listRuns(workflow: string, query: string): Promise<RunLike[]> {
  const r = await gh(`/actions/workflows/${workflow}/runs?per_page=50${query}`);
  if (!r.ok) throw new Error(`http-${r.status}`);
  return ((await r.json()) as { workflow_runs?: RunLike[] }).workflow_runs ?? [];
}

/** Workflows whose active run holds the history chain (one Massive key user at a time). */
export const HOLDING_WORKFLOWS = ["gap-refill.yml"] as const;
export const GATE_HELD = "held:gap-refill";

/** Pure: does any listed run hold the key (queued / waiting / in progress)? */
export function holdActive(runs: readonly RunLike[]): boolean {
  return runs.some((r) => r.status !== "completed");
}

/** Effective TENMIN_AUTO_REDISPATCH (fail closed: API errors leave the raw value, which is not "true"). */
export async function resolveRedispatchGate(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const opened = await resolveSealGate(env);
  if (opened !== "true" || !env.GITHUB_REPOSITORY || !(env.GITHUB_TOKEN ?? env.GH_TOKEN)) return opened;
  // A missing holding workflow (404) holds nothing; any other lookup failure holds (fail closed).
  const runsOrNone = async (w: string, q: string) => {
    try { return await listRuns(w, q); } catch (e) { if (e instanceof Error && e.message === "http-404") return []; throw e; }
  };
  try {
    for (const w of HOLDING_WORKFLOWS) if (holdActive(await runsOrNone(w, "&status=in_progress")) || holdActive(await runsOrNone(w, "&status=queued"))) return GATE_HELD;
  } catch {
    return GATE_HELD;
  }
  return opened;
}

async function resolveSealGate(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const raw = env.TENMIN_AUTO_REDISPATCH;
  const g = parseGate(raw);
  if (g.kind !== "until_seal") return effectiveGate(raw, undefined);
  if (!env.GITHUB_REPOSITORY || !(env.GITHUB_TOKEN ?? env.GH_TOKEN)) return raw;
  try {
    return effectiveGate(raw, hasSealedMarker(await listRuns(g.workflow, "&status=success&branch=main&event=workflow_dispatch")));
  } catch {
    return raw;
  }
}

async function guard(): Promise<number> {
  const env = process.env;
  const effective = await resolveRedispatchGate(env);
  const g = parseGate(env.TENMIN_AUTO_REDISPATCH);
  const files = (env.TENMIN_ONEOFF_WORKFLOWS ?? "").split(",").map((s) => s.trim()).filter((s) => WORKFLOW_FILE.test(s));
  if (g.kind === "until_seal" && !files.includes(g.workflow)) files.push(g.workflow);
  let oneOffRuns: RunLike[] | { error: string } = [];
  try {
    for (const f of files) (oneOffRuns as RunLike[]).push(...(await listRuns(f, "")));
  } catch (e) {
    oneOffRuns = { error: e instanceof Error ? e.message.slice(0, 40) : "unknown" };
  }
  let openTitles: string[] = [];
  const open = await gh(`/issues?state=open&labels=scanner-alert&per_page=50`);
  if (open.ok) openTitles = ((await open.json()) as { title: string; pull_request?: unknown }[]).filter((i) => !i.pull_request).map((i) => i.title);
  const plan = planGateGuard({ effective, oneOffRuns, now: new Date(), openAlertTitles: openTitles });
  if (plan.action === "none") { console.log(`gate-guard: ${plan.why}`); return 0; }
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const body = `The ten-minute history chain's redispatch is off or still waiting on a one-off seal (TENMIN_AUTO_REDISPATCH is not on), and no one-off fetch has run for over 30 minutes, so nothing will restart the chain. Check the one-off and set the variable to true when it is safe. Run: ${runUrl}`;
  const r = await gh(`/issues`, { method: "POST", body: JSON.stringify({ title: GUARD_ALERT_TITLE, body, labels: ["scanner-alert"], assignees: [env.GITHUB_REPOSITORY_OWNER ?? "PeaceG03"] }) });
  console.log(`gate-guard: ALERT ${r.ok ? "PASS" : `FAIL http-${r.status}`} (${plan.why})`);
  return r.ok ? 0 : 1;
}

async function main(mode: string | undefined): Promise<number> {
  if (mode === "guard") return guard();
  if (mode === "resolve") { console.log(`gate: ${(await resolveRedispatchGate()) === "true" ? "on" : "off"}`); return 0; }
  console.error("usage: tenmin-gate.ts guard|resolve");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((c) => process.exit(c), () => { console.error("gate: FAIL"); process.exit(1); });
}
