import type { SiteData } from "./site-data";
import { READ_REASON_MAX } from "./site-read-error";

/** Pure HTML for the private site: no scripts, no external assets, every value escaped. */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escape first, then offer a break after each underscore so long issue codes wrap cleanly on a phone. */
export function wrapAtUnderscores(value: unknown): string {
  return escapeHtml(value).replaceAll("_", "_<wbr>");
}

const DISPLAY_ZONE = "America/Denver";

export function localTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${text} MT`;
}

type Tone = "ok" | "warn" | "bad" | "muted";

function tone(state: string): Tone {
  const word = state.toUpperCase();
  if (["OK", "COMPLETE", "COMPLETED", "COMPLETE_WITH_WARNINGS", "CORRECTED_RECONCILED", "HEALTHY"].includes(word)) return "ok";
  if (["BEHIND", "PARTIAL", "NOT_READY", "PROVIDER_NOT_READY"].includes(word)) return "warn";
  if (["ERROR", "FAILED", "UNREADABLE"].includes(word)) return "bad";
  return "muted";
}

function badge(state: string): string {
  return `<span class="b ${tone(state)}">${escapeHtml(state)}</span>`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14171a;--mute:#5f6b76;--line:#e3e6ea;--ok:#127a3e;--warn:#9a6200;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1214;--card:#181c1f;--fg:#e8ecef;--mute:#9aa6b1;--line:#2a3036;--ok:#4cc27e;--warn:#e0a63a;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 2px}h2{font-size:16px;margin:0 0 8px}
.sub{color:var(--mute);font-size:13px;margin-bottom:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.big{font-size:17px;font-weight:600}.mute{color:var(--mute);font-size:13px}ul{margin:6px 0 0;padding-left:18px}li{margin:2px 0}
.b{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;border:1px solid currentColor}
.exp{margin:0 0 8px;padding:6px 8px;border-left:3px solid var(--warn);color:var(--warn);font-size:13px;font-weight:600;overflow-wrap:anywhere}.exp-tag{color:var(--warn);font-size:11px;font-weight:600;text-transform:uppercase}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:500;font-size:12px;border-top:0}
.r{text-align:right;white-space:nowrap}.f{color:var(--bad);font-size:12px;word-break:break-word}
html,body{max-width:100%;overflow-x:hidden}
.table-wrap{width:100%;max-width:100%;overflow-x:hidden}
.session-date,.when,.valid{white-space:nowrap}
.issues{overflow-wrap:anywhere;word-break:normal}
@media (max-width:480px){
.stack thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.stack,.stack tbody,.stack tr,.stack td{display:block;width:100%}
.stack{border-collapse:separate;border-spacing:0}
.stack tr{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 10px}
.stack tr:last-child{margin-bottom:0}
.stack td,.stack th{border:0;padding:6px 0;text-align:left}
.stack td.r{text-align:left}
.stack td::before{content:attr(data-label);display:block;color:var(--mute);font-size:12px;font-weight:500}
}
`;

/**
 * Shown above the picks and beside each list. The held-out evaluation (PR #124, src/holdout-eval.ts)
 * found no edge over random same-size lists, so the lists are labelled as experimental.
 */
export const PICKS_EXPERIMENTAL_LABEL =
  "Experimental: back-tests on held-out data show no reliable edge over random picks. Not investment advice.";

export const PAPER_TRADING_LABEL = "Paper trading: simulated, no real money.";

/** Signed percent with two decimals, or "n/a". */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const text = (value * 100).toFixed(2);
  return `${value > 0 ? "+" : ""}${text === "-0.00" ? "0.00" : text}%`;
}

function paperCard(data: SiteData): string {
  const days = data.paper?.days ?? [];
  const latest = days[0];
  return (
    `<section class="card"><h2>Paper trading</h2>` +
    `<div class="exp" role="note">${escapeHtml(PAPER_TRADING_LABEL)}</div>` +
    (latest
      ? `<div class="exp" role="note">${escapeHtml(PICKS_EXPERIMENTAL_LABEL)}</div>` +
        `<div class="big">Since start: paper ${escapeHtml(percent(latest.cumulativePaper))}</div>` +
        `<div class="mute">SPY ${escapeHtml(percent(latest.cumulativeSpy))} · equal-weight universe ${escapeHtml(percent(latest.cumulativeUniverse))} · paper is after costs</div>` +
        `<div class="table-wrap"><table class="stack"><thead><tr><th>Day</th><th class="r">Paper</th><th class="r">SPY</th><th class="r">Universe</th></tr></thead><tbody>${days
          .map(
            (d) =>
              `<tr><td data-label="Day"><span class="session-date">${escapeHtml(d.to)}</span><div class="mute">open ${escapeHtml(d.from)} to open ${escapeHtml(d.to)}</div>${
                d.entriesRefused ? `<div class="mute issues">no entries: ${wrapAtUnderscores(d.entriesRefused)}</div>` : ""
              }${
                d.dataDropout
                  ? `<div class="mute issues">data gap: ${d.dataDropout.universe} universe names, ${d.dataDropout.paper} paper names not counted as missed (${wrapAtUnderscores("DATA_DROPOUT")})</div>`
                  : ""
              }${
                d.recoveryNeedsReview
                  ? `<div class="mute issues">recovery held for review: ${d.recoveryNeedsReview.universe} universe names, ${d.recoveryNeedsReview.paper} paper names (${wrapAtUnderscores("RECOVERY_NEEDS_REVIEW")})</div>`
                  : ""
              }</td><td class="r" data-label="Paper">${escapeHtml(percent(d.paper))}</td><td class="r" data-label="SPY">${escapeHtml(percent(d.spy))}</td><td class="r" data-label="Universe">${escapeHtml(percent(d.universe))}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<div class="big muted">No paper results yet</div><div class="mute">Paper trading is off or has not finished a day.</div>`) +
    `</section>`
  );
}

const REASON_WORDS: Record<string, string> = {
  FLOOR_PRICE: "price under $5",
  FLOOR_DOLLAR_VOLUME: "dollar volume under $5M",
  FLOOR_HISTORY: "under 60 sessions of history",
  FLOOR_NO_BAR_ON_SESSION: "no bar on the session",
  SPLIT_UNRECONCILED: "split records disagree",
  PRICE_GAP_UNEXPLAINED: "unexplained price gap",
  SPLIT_LIKE_MOVE_UNRECORDED: "split-like move with no record",
};

function byReason(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${REASON_WORDS[reason] ?? reason} ${n}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** The newest nightly scan health record, inside the Health card. */
export function scanHealthBlock(scan: SiteData["scanHealth"]): string {
  if (!scan) return `<h2 style="margin-top:12px">Nightly scan</h2><div class="mute">No nightly scan record has been saved yet.</div>`;
  const before =
    scan.finishedBeforeOpen === true
      ? `<span class="ok">Finished before the open</span>`
      : scan.finishedBeforeOpen === false
        ? `<span class="bad">Finished after the open</span>`
        : `<span class="muted">Open time unknown</span>`;
  const freeze = scan.frozenOnTime
    ? `<span class="ok">Picks frozen on time</span>`
    : `<span class="bad">Picks not frozen on time</span> <span class="mute">${escapeHtml(scan.freezeStatus)}${scan.freezeReason ? ` ${wrapAtUnderscores(scan.freezeReason)}` : ""}</span>`;
  return (
    `<h2 style="margin-top:12px">Nightly scan</h2>` +
    `<div class="big">Session ${escapeHtml(scan.sessionDate)}</div>` +
    `<ul>` +
    `<li>${before} <span class="mute">finished ${escapeHtml(localTime(scan.completedAt))}, open ${escapeHtml(localTime(scan.nextSessionOpen))}</span></li>` +
    `<li>${freeze}</li>` +
    `<li>Names covered: ${escapeHtml(scan.namesCovered)} of ${escapeHtml(scan.namesExpected)}</li>` +
    `<li>Left out by the eligibility floor: ${escapeHtml(scan.floorExcluded)}${escapeHtml(byReason(scan.floorByReason))}</li>` +
    `<li>Left out by the split guard: ${escapeHtml(scan.splitExcluded)}${escapeHtml(byReason(scan.splitByReason))}</li>` +
    `</ul>`
  );
}

function shareText(label: string, s: { sessions: number; onTime: number; late: number; unavailable: number; noRecord: number }): string {
  const pct = s.sessions ? Math.round((100 * s.onTime) / s.sessions) : 0;
  const missed = [
    s.late ? `${s.late} late` : "",
    s.unavailable ? `${s.unavailable} unavailable` : "",
    s.noRecord ? `${s.noRecord} with no record` : "",
  ].filter(Boolean);
  const cls = !s.sessions ? "muted" : pct >= 95 ? "ok" : pct >= 80 ? "warn" : "bad";
  return `<li><span class="${cls}">${escapeHtml(label)}: ${escapeHtml(s.onTime)} of ${escapeHtml(s.sessions)} on time (${escapeHtml(pct)}%)</span>${
    missed.length ? ` <span class="mute">${escapeHtml(missed.join(", "))}</span>` : ""
  }</li>`;
}

/** On-time freeze share over the last 20 and 60 sessions, inside the Health card. */
export function freezeShareBlock(r: SiteData["freezeReliability"]): string {
  if (!r) return `<div class="mute">No freeze on-time record has been saved yet.</div>`;
  return (
    `<div class="mute" style="margin-top:8px">Picks frozen before the next open${r.through ? `, sessions through ${escapeHtml(r.through)}` : ""}</div>` +
    `<ul>${shareText("Last 20 sessions", r.last20)}${shareText("Last 60 sessions", r.last60)}</ul>`
  );
}

export function renderSitePage(data: SiteData): string {
  const parts: string[] = [];

  // Overall health.
  const health = data.health;
  parts.push(
    `<section class="card"><h2>Health</h2>${
      health
        ? `<div class="big ${health.attention ? "bad" : tone(health.headline.startsWith("behind") ? "BEHIND" : "OK")}">${escapeHtml(health.headline)}</div>` +
          `<div class="mute">Checked ${escapeHtml(localTime(health.at))}</div>` +
          (health.lines.length ? `<ul>${health.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : "")
        : `<div class="mute">No health check has been saved yet.</div>`
    }${scanHealthBlock(data.scanHealth)}${freezeShareBlock(data.freezeReliability)}</section>`,
  );

  // Catch-up / backlog.
  const backlog = data.backlog;
  const backlogLine =
    backlog.state === "BEHIND"
      ? `Behind: ${plural(backlog.remaining ?? 0, "market day")} still to collect.`
      : backlog.state === "ERROR"
        ? "The last scan reported an error."
        : backlog.state
          ? "No backlog: the scanner is caught up."
          : "The scan has not checked in yet.";
  parts.push(
    `<section class="card"><h2>Catch-up</h2><div class="big">${escapeHtml(backlogLine)}</div>` +
      `<div class="mute">Collected through ${escapeHtml(data.caughtUpThrough ?? "unknown")}</div>` +
      (backlog.message ? `<div class="mute">${escapeHtml(backlog.message)}</div>` : "") +
      `</section>`,
  );

  // Check-ins per part.
  parts.push(
    `<section class="card"><h2>Latest check-ins</h2>${
      data.checkins.length
        ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Part</th><th>State</th><th class="r">When</th></tr></thead><tbody>${data.checkins
            .map(
              (c) =>
                `<tr><td data-label="Part">${escapeHtml(c.name)}${c.message ? `<div class="mute">${escapeHtml(c.message)}</div>` : ""}</td><td data-label="State">${badge(c.state)}${
                  c.remaining !== undefined ? ` <span class="mute">${escapeHtml(c.remaining)} left</span>` : ""
                }</td><td class="r mute when" data-label="When">${escapeHtml(localTime(c.at))}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="mute">No check-ins yet.</div>`
    }</section>`,
  );

  // Predictions.
  const p = data.predictions;
  parts.push(
    `<section class="card"><h2>Picks</h2>${
      p.state === "off"
        ? `<div class="big muted">Predictions off</div><div class="mute">No picks are being made right now.${
            p.status ? ` Last status: ${escapeHtml(p.status)}${p.reason ? ` (${escapeHtml(p.reason)})` : ""}.` : ""
          }</div>`
        : `<div class="exp" role="note">${escapeHtml(PICKS_EXPERIMENTAL_LABEL)}</div><div class="mute">Session ${escapeHtml(p.sessionDate)}</div>${p.picks
            .map(
              (set) =>
                `<div><b>${escapeHtml(set.setType)}</b> <span class="exp-tag">experimental</span>: ${
                  set.unavailableReason
                    ? `<span class="mute">unavailable${set.unavailableReason === "INSUFFICIENT_HISTORY" ? " (not enough price history)" : ""}</span>`
                    : set.symbols.map(escapeHtml).join(", ")
                }</div>`,
            )
            .join("")}`
    }</section>`,
  );

  parts.push(paperCard(data));

  // Per-session reports.
  parts.push(
    `<section class="card"><h2>Recent sessions</h2>${
      data.reports.length
        ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Session</th><th>Status</th><th class="r">Valid</th></tr></thead><tbody>${data.reports
            .map(
              (r) =>
                `<tr><td data-label="Session"><span class="session-date">${escapeHtml(r.sessionDate)}</span><div class="mute">${escapeHtml(localTime(r.completedAt))}</div>${
                  r.failureCount
                    ? `<div class="f issues">${escapeHtml(plural(r.failureCount, "issue"))}: ${r.failures.map(wrapAtUnderscores).join("; ")}</div>`
                    : ""
                }</td><td data-label="Status">${badge(r.status)}</td><td class="r" data-label="Valid"><span class="valid">${escapeHtml(r.valid)} / ${escapeHtml(r.expected)}</span>${
                  r.incomplete ? `<div class="mute">${escapeHtml(r.incomplete)} incomplete</div>` : ""
                }</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="mute">No session reports yet.</div>`
    }</section>`,
  );

  if (data.readErrors.length)
    parts.push(
      `<section class="card"><div class="f">Could not read: ${data.readErrors
        .map((name) => {
          const why = data.readErrorReasons?.[name];
          const short = why && why.length > READ_REASON_MAX ? `${why.slice(0, READ_REASON_MAX - 1)}…` : why;
          return short ? `${escapeHtml(name)} (${escapeHtml(short)})` : escapeHtml(name);
        })
        .join(", ")}</div></section>`,
    );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>PeaceSTOCKS</title><style>${STYLE}</style></head><body><main><h1>PeaceSTOCKS</h1><div class="sub">Scanner status · updated ${escapeHtml(
    localTime(data.generatedAt),
  )}</div>${parts.join("")}</main></body></html>`;
}

/** Response headers for every site page: private, never cached, no framing, no scripts. */
export const SITE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
});
