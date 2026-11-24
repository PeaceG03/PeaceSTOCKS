import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient } from "./object-store";
import { PAPER_DAYS_PREFIX } from "./paper-ledger";
import { loadSiteData, SITE_PAPER_DAYS, type SiteReader } from "./site-data";
import { PAPER_TRADING_LABEL, percent, PICKS_EXPERIMENTAL_LABEL, renderSitePage } from "./site-page";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const card = (html: string) => html.slice(html.indexOf("<h2>Paper trading</h2>"), html.indexOf("<h2>Recent sessions</h2>"));
const date = (i: number) => `2026-12-${String(i).padStart(2, "0")}`;

function day(i: number, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: "paper-day-v1",
    rulesVersion: "paper-rules-v2",
    rulesSha256: "x",
    fromSessionDate: date(i - 1),
    toSessionDate: date(i),
    equityFrom: 100000,
    equityTo: 100000,
    paperReturn: 0.0123,
    spyReturn: -0.005,
    universeReturn: 0.001,
    universeSize: 10,
    cumulativePaperReturn: i / 1000,
    cumulativeSpyReturn: -i / 1000,
    cumulativeUniverseReturn: 0,
    positions: 15,
    costsUsd: 1,
    ...patch,
  };
}

test("paper card: always labelled simulated; says no results until a day exists", async () => {
  assert.equal(PAPER_TRADING_LABEL, "Paper trading: simulated, no real money.");
  const data = await loadSiteData(new MemoryObjectClient());
  assert.deepEqual(data.paper, { days: [] });
  assert.deepEqual(data.readErrors, []);
  const html = card(renderSitePage(data));
  assert.ok(html.includes(`<div class="exp" role="note">${PAPER_TRADING_LABEL}</div>`));
  assert.match(html, /No paper results yet/u);
});

test("paper card: newest 10 days, newest first, paper vs SPY vs universe, cumulative, both labels, phone layout", async () => {
  const client = new MemoryObjectClient();
  for (let i = 2; i <= 13; i += 1) await client.put(`${PAPER_DAYS_PREFIX}${date(i)}.json`, enc(day(i, i === 13 ? { spyReturn: null, entriesRefused: "DAILY_LOSS_LIMIT" } : {})));
  await client.put(`${PAPER_DAYS_PREFIX}latest.json`, enc(day(99))); // not a day key: ignored
  const data = await loadSiteData(client);
  assert.equal(SITE_PAPER_DAYS, 10);
  assert.deepEqual(data.paper!.days.map((d) => d.to), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4].map(date));
  const html = card(renderSitePage(data));
  assert.ok(html.includes(PICKS_EXPERIMENTAL_LABEL));
  assert.ok(html.includes(PAPER_TRADING_LABEL));
  assert.match(html, /Since start: paper \+1\.30%/u);
  assert.match(html, /SPY -1\.30% · equal-weight universe 0\.00%/u);
  assert.match(html, /<table class="stack">/u);
  assert.match(html, /<td class="r" data-label="Paper">\+1\.23%<\/td><td class="r" data-label="SPY">n\/a<\/td><td class="r" data-label="Universe">\+0\.10%<\/td>/u);
  assert.match(html, /no entries: DAILY_<wbr>LOSS_<wbr>LIMIT/u);
  assert.equal((html.match(/<tr><td data-label="Day">/gu) ?? []).length, 10);
});

test("paper card: stored values are escaped and non-numbers show n/a", async () => {
  const client = new MemoryObjectClient();
  await client.put(`${PAPER_DAYS_PREFIX}${date(2)}.json`, enc(day(2, { fromSessionDate: "<img src=x onerror=alert(1)>", entriesRefused: "<script>x</script>", paperReturn: "1e999", spyReturn: { a: 1 }, cumulativePaperReturn: null })));
  const html = renderSitePage(await loadSiteData(client));
  assert.equal(html.includes("<script>x"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(card(html), /data-label="Paper">n\/a</u);
  assert.match(card(html), /Since start: paper n\/a/u);
});

test("paper card: a failed read is reported and the page still renders", async () => {
  const base = new MemoryObjectClient();
  const reader: SiteReader = {
    get: (key) => base.get(key),
    list: async (prefix) => {
      if (prefix.startsWith("paper/")) throw Object.assign(new Error("boom"), { name: "TypeError" });
      return base.list(prefix);
    },
  };
  const data = await loadSiteData(reader);
  assert.deepEqual(data.readErrors, ["paper"]);
  assert.match(renderSitePage(data), /No paper results yet/u);
});

test("percent: sign, two decimals, n/a", () => {
  assert.equal(percent(0.01234), "+1.23%");
  assert.equal(percent(-0.005), "-0.50%");
  assert.equal(percent(0), "0.00%");
  assert.equal(percent(-0.0000001), "0.00%");
  assert.equal(percent(null), "n/a");
  assert.equal(percent(Number.NaN), "n/a");
});
