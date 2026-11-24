// Health alert (Peace, Nov 23): a non-OK health result opens ONE GitHub issue, or comments on the
// open one; never a new issue per run. Same pattern as the scanner alerts (src/tenmin-alert.ts and
// #114's refill-backup-and-alert action): label scanner-alert, assignee PeaceG03, the open issue
// found by its exact title. Built-in GITHUB_TOKEN only (issues: write). The body carries the health
// lines (part names, counts, redacted messages): no secrets and no market data.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEALTHY } from "./health-check";
import { redactHealthMessage } from "./health-checkins";
import { SCANNER_ALERT_ASSIGNEE, SCANNER_ALERT_LABEL } from "./tenmin-alert";

export const HEALTH_ALERT_TITLE = "PeaceSTOCKS health needs attention" as const;
/** The headline used when the health check itself did not finish (no result file). */
export const HEALTH_CHECK_DID_NOT_FINISH = "health check did not finish" as const;

export interface HealthAlertResult {
  headline: string;
  lines: readonly string[];
}

/** Pure: Denver wall time with a short label. */
function mountainTime(d: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return text;
}

/** Pure: undefined when the result is OK (Healthy); otherwise the comment/issue body. */
export function healthAlertBody(result: HealthAlertResult | undefined, runUrl: string, now: Date): string | undefined {
  if (result && result.headline === HEALTHY) return undefined;
  const headline = result?.headline ?? HEALTH_CHECK_DID_NOT_FINISH;
  const lines = (result?.lines ?? []).slice(1).map((line) => `- ${redactHealthMessage(line) ?? ""}`);
  return [`**${redactHealthMessage(headline)}** (${mountainTime(now)})`, "", ...lines, "", `Run: ${runUrl}`].join("\n").slice(0, 60_000);
}

interface Issue {
  number: number;
  title: string;
  pull_request?: unknown;
}

/**
 * Open (or comment on) the one health issue. Returns what it did. `fetchImpl` is injectable for tests.
 * Never closes anything: a person closes the issue once the cause is handled.
 */
export async function runHealthAlert(options: {
  result: HealthAlertResult | undefined;
  env: NodeJS.ProcessEnv;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const env = options.env;
  const now = options.now ?? new Date();
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const body = healthAlertBody(options.result, runUrl, now);
  if (!body) return "none: Healthy";
  const doFetch = options.fetchImpl ?? fetch;
  const token = env.GITHUB_TOKEN;
  if (!token || !env.GITHUB_REPOSITORY) throw new Error("HEALTH_ALERT_NO_TOKEN_OR_REPO");
  const gh = async <T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> => {
    const response = await doFetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`HEALTH_ALERT_GITHUB_${response.status}:${init.method ?? "GET"}`);
    return (await response.json()) as T;
  };
  const label = env.SCANNER_ALERT_LABEL || SCANNER_ALERT_LABEL;
  const open = (await gh<Issue[]>(`/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`)).filter(
    (issue) => !issue.pull_request && issue.title === HEALTH_ALERT_TITLE,
  );
  const existing = open.sort((a, b) => a.number - b.number)[0];
  if (existing) {
    await gh(`/issues/${existing.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    return `commented on #${existing.number}`;
  }
  const created = await gh<{ number: number }>(`/issues`, {
    method: "POST",
    body: JSON.stringify({ title: HEALTH_ALERT_TITLE, body, labels: [label], assignees: [SCANNER_ALERT_ASSIGNEE] }),
  });
  return `opened #${created.number}`;
}

function readResult(path: string | undefined): HealthAlertResult | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HealthAlertResult>;
    return typeof parsed.headline === "string" ? { headline: parsed.headline, lines: Array.isArray(parsed.lines) ? parsed.lines : [] } : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runHealthAlert({ result: readResult(process.env.HEALTH_RESULT_FILE), env: process.env })
    .then((line) => process.stdout.write(`health alert: ${line}\n`))
    .catch((error: unknown) => {
      process.stdout.write(`HEALTH_ALERT_FAILED:${redactHealthMessage(error instanceof Error ? error.message : String(error))?.slice(0, 120) ?? ""}\n`);
      process.exitCode = 1;
    });
}
