// Daily-bars gap refill in Actions (.github/workflows/gap-refill.yml); replaces the box watcher + refill-run.
// Plan = sessions the coverage check reports missing right now (never touches stored ones; GuardedClient never
// replaces or deletes). Start requires Net's frozen config committed on PeaceSTOCKS-Net main. One Massive key user:
// while this workflow has a run in progress the history gate reads as held (src/tenmin-gate.ts), and every Massive
// request / write waits while any other non-idle scanner.yml run is active or a guard window is near. The workflow
// re-dispatches tenmin_history when done (release). Logs: counts and PASS/FAIL only.
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { R2ObjectClient, type ObjectClient } from "./object-store";
import { MassiveMarketProvider } from "./massive-provider";
import { checkDailyBarsCoverage } from "./daily-bars-coverage";
import { isIdleScannerRun } from "./scan-yield";
import { refill, verifySessions } from "./gap-refill-lib";

export type NetFreeze = { ok: true; commit: string } | { ok: false; reason: string };

/** Pure: frozen-config verdict from the contents + commits API responses. */
export function netFreezeVerdict(contentStatus: number, contentB64: string | undefined, commitSha: string | undefined): NetFreeze {
  if (contentStatus === 404) return { ok: false, reason: "NET_FREEZE_MISSING" };
  if (contentStatus !== 200) return { ok: false, reason: `NET_FREEZE_CHECK_FAILED:http-${contentStatus}` };
  if (!Buffer.from(contentB64 ?? "", "base64").toString("utf8").trim()) return { ok: false, reason: "NET_FREEZE_EMPTY" };
  if (!commitSha) return { ok: false, reason: "NET_FREEZE_NO_COMMIT" };
  return { ok: true, commit: commitSha };
}

/** Pure: guard windows 05:12–06:15Z / 09:12–10:15Z (3 min lead). */
export function inRefillGuard(d: Date): boolean {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 312 && m < 375) || (m >= 552 && m < 615);
}

/** Pure: the reason to pause before a Massive request / write, or undefined. */
export function refillPauseReason(now: Date, runs: readonly { status: string; display_title?: string }[] | { error: string }): string | undefined {
  if (inRefillGuard(now)) return "GUARD_WINDOW";
  if ("error" in runs) return "RUNS_CHECK_FAILED";
  return runs.some((r) => r.status !== "completed" && !isIdleScannerRun(r)) ? "ACTIVE_SCANNER_RUN" : undefined;
}

const api = (path: string, token: string | undefined) =>
  fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token ?? ""}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });

async function netFreeze(): Promise<NetFreeze> {
  const t = process.env.NET_READ_TOKEN;
  if (!t) return { ok: false, reason: "NET_READ_TOKEN_ABSENT" };
  try {
    const c = await api("repos/PeaceG03/PeaceSTOCKS-Net/contents/config/frozen.sha256?ref=main", t);
    const body = c.ok ? ((await c.json()) as { content?: string }) : {};
    const k = await api("repos/PeaceG03/PeaceSTOCKS-Net/commits?path=config/frozen.sha256&sha=main&per_page=1", t);
    const commits = k.ok ? ((await k.json()) as { sha: string }[]) : [];
    return netFreezeVerdict(c.status, body.content, commits[0]?.sha);
  } catch { return { ok: false, reason: "NET_FREEZE_CHECK_FAILED:network" }; }
}

async function scannerRuns(): Promise<{ status: string; display_title?: string }[] | { error: string }> {
  try {
    const r = await api(`repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/scanner.yml/runs?per_page=30`, process.env.GITHUB_TOKEN);
    if (!r.ok) return { error: `http-${r.status}` };
    return ((await r.json()) as { workflow_runs: { status: string; display_title?: string }[] }).workflow_runs;
  } catch { return { error: "network" }; }
}

function noDelete(c: ObjectClient): ObjectClient {
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    for (let i = 0; ; i++) { try { return await f(...a); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 5_000 * (i + 1))); } }
  };
  return { get: wrap(c.get.bind(c)), put: wrap(c.put.bind(c)), head: wrap(c.head.bind(c)), list: wrap(c.list.bind(c)), delete: async () => { throw new Error("NO_DELETE"); } };
}

async function main(): Promise<number> {
  if (process.argv[2] === "--check") {
    const c = await checkDailyBarsCoverage(noDelete(R2ObjectClient.fromEnv(process.env)));
    const ca = (c.missingCorporateActionSessions ?? []).length;
    console.log(`coverage: ${c.ok && ca === 0 ? "PASS" : "FAIL"} missing=${c.missingSessions.length} corporate-action gaps=${ca}`);
    return c.ok && ca === 0 ? 0 : 2;
  }
  const deadline = Date.now() + (Number(process.env.REFILL_BUDGET_MS) || 5 * 3_600_000);
  const client = noDelete(R2ObjectClient.fromEnv(process.env));
  const cov = await checkDailyBarsCoverage(client);
  const sessions = [...cov.missingSessions].sort();
  console.log(`gap-refill: missing sessions=${sessions.length} corporate-action gaps=${(cov.missingCorporateActionSessions ?? []).length}`);
  if (sessions.length === 0 && (cov.missingCorporateActionSessions ?? []).length === 0) { console.log("gap-refill: PASS nothing to do"); return 0; }
  const net = await netFreeze();
  if (!net.ok) { console.log(`gap-refill: NOT_STARTED ${net.reason}`); return 3; }
  console.log("gap-refill: NET_FREEZE PASS");
  // From here this run holds the key; the workflow's release step re-dispatches the chain afterwards.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "held=true\n");
  const gate = async (): Promise<string | undefined> => {
    for (;;) {
      if (Date.now() >= deadline) return "DEADLINE";
      const why = refillPauseReason(new Date(), await scannerRuns());
      if (!why) return undefined;
      await new Promise((r) => setTimeout(r, 60_000));
    }
  };
  mkdirSync("refill-backup", { recursive: true });
  let backups = 0;
  const res = await refill({
    client,
    provider: new MassiveMarketProvider({ keepRawReplies: true }),
    sessions,
    actionSessions: [...new Set([...sessions, ...(cov.missingCorporateActionSessions ?? [])])].sort(),
    gate,
    log: () => undefined,
    onWrite: () => undefined,
    backup: (key, body) => { writeFileSync(`refill-backup/${key.replace(/\//g, "__")}.${Date.now()}`, body); backups++; },
  });
  console.log(`gap-refill: massiveRequests=${res.massiveRequests} dust=${res.dustWritten.length} packs=${res.packsWritten.length} puts=${res.puts} backups=${backups} stopped=${res.stopped ?? "no"}`);
  if (res.stopped) return 4;
  const rows = await verifySessions(client, sessions);
  const ok = rows.filter((r) => r.ok).length;
  const after = await checkDailyBarsCoverage(client);
  console.log(`gap-refill: VERIFY ${ok === sessions.length && after.ok ? "PASS" : "FAIL"} ${ok}/${sessions.length} coverageOk=${after.ok}`);
  return ok === sessions.length && after.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.log(`gap-refill: FAIL ${/REFILL_GUARD_REFUSED/u.test(String(e)) ? "GUARD_REFUSED" : "error"}`); process.exit(1); });
}
