import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ONEOFF_PREFIX, ONEOFF_SESSIONS, ONEOFF_DEFAULT_BUDGET_MS, ONEOFF_SPACING_MS, inOneOffGuardWindow, dollarVolumeBySecurity,
  liquidityOrder, nextOneOffFloor, parseOneOffFloor, parseChainIndex, decideOneOffNext, oneOffPauseReason, errorClass,
  timedFetch, guardedStore, storedByFetchFrom,
} from "./oct2024-tenmin-oneoff";
import { isTenMinRangeAbortError, fetchIdentityKey } from "./tenmin-range-reply-dust";

test("guard windows match the box driver (05:15-06:15Z, 09:15-10:15Z)", () => {
  const at = (hm: string) => new Date(`2026-10-13T${hm}:00Z`);
  for (const hm of ["05:15", "05:59", "06:14", "09:15", "10:14"]) assert.equal(inOneOffGuardWindow(at(hm)), true, hm);
  for (const hm of ["05:14", "06:15", "09:14", "10:15", "00:00", "23:59"]) assert.equal(inOneOffGuardWindow(at(hm)), false, hm);
});

test("plan constants: 12.5 s spacing, 5h15m budget, sessions 2024-10-11..2024-10-31, chain range folder", () => {
  assert.equal(ONEOFF_SPACING_MS, 12_500);
  assert.equal(ONEOFF_DEFAULT_BUDGET_MS, 315 * 60_000);
  assert.equal(ONEOFF_SESSIONS[0], "2024-10-11");
  assert.equal(ONEOFF_SESSIONS[1], "2024-10-14");
  assert.equal(ONEOFF_SESSIONS.at(-1), "2024-10-31");
  assert.equal(ONEOFF_PREFIX, "permanent/tenmin-reply-dust/2024-09-01_2024-10-31/");
});

test("liquidity order: Oct 11+ dollar volume desc, ties by securityId; earlier sessions ignored", () => {
  const jsonl = [
    { securityId: "a", sessionDate: "2024-10-10", close: 1000, volume: 1000 },
    { securityId: "a", sessionDate: "2024-10-11", close: 1, volume: 10 },
    { securityId: "b", sessionDate: "2024-10-14", close: 2, volume: 10 },
    { securityId: "c", sessionDate: "2024-10-15", close: 1, volume: 10 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const dv = dollarVolumeBySecurity(jsonl, "2024-10-11");
  assert.equal(dv.get("a"), 10);
  const order = liquidityOrder([{ securityId: "c" }, { securityId: "z" }, { securityId: "a" }, { securityId: "b" }], dv).map((f) => f.securityId);
  assert.deepEqual(order, ["b", "a", "c", "z"]);
});

test("floor: validated input, advance on GONE, none after the last session", () => {
  assert.equal(parseOneOffFloor(undefined), "2024-10-11");
  assert.equal(parseOneOffFloor("2024-10-14"), "2024-10-14");
  assert.throws(() => parseOneOffFloor("2024-10-12"), /ONEOFF_FLOOR_INVALID/u); // Saturday
  assert.throws(() => parseOneOffFloor("2024-10-11; rm -rf /"), /ONEOFF_FLOOR_INVALID/u);
  assert.equal(nextOneOffFloor("2024-10-11"), "2024-10-14");
  assert.equal(nextOneOffFloor("2024-10-31"), undefined);
  assert.equal(parseChainIndex(""), 1);
  assert.equal(parseChainIndex("4"), 4);
  assert.throws(() => parseChainIndex("0"), /CHAIN_INDEX/u);
  assert.throws(() => parseChainIndex("1x"), /CHAIN_INDEX/u);
});

test("next step: budget dispatches (below the cap), sealed starts the backstop, anything else alerts", () => {
  assert.equal(decideOneOffNext("budget", 1), "dispatch");
  assert.equal(decideOneOffNext("budget", 9), "dispatch");
  assert.equal(decideOneOffNext("budget", 10), "alert");
  assert.equal(decideOneOffNext("sealed", 3), "backstop");
  assert.equal(decideOneOffNext("fatal", 1), "alert");
  assert.equal(decideOneOffNext("refused", 1), "alert");
});

test("pause: guard window, active non-idle scanner run, failed check (fail closed); idle runs ignored", () => {
  const ok = new Date("2026-10-12T02:00:00Z");
  assert.equal(oneOffPauseReason(new Date("2026-10-13T05:30:00Z"), []), "GUARD_WINDOW");
  assert.equal(oneOffPauseReason(ok, []), undefined);
  assert.equal(oneOffPauseReason(ok, [{ id: 1, status: "in_progress", event: "schedule", display_title: "Scanner restarter" }]), undefined);
  assert.equal(oneOffPauseReason(ok, [{ id: 1, status: "completed", event: "workflow_dispatch", display_title: "Scanner" }]), undefined);
  assert.equal(oneOffPauseReason(ok, [{ id: 2, status: "queued", event: "workflow_dispatch", display_title: "Scanner" }]), "ACTIVE_SCANNER_RUN");
  assert.equal(oneOffPauseReason(ok, { error: "http-403" }), "RUNS_CHECK_FAILED:http-403");
});

test("window-gone is a writer abort (never a stored gap); per-ticker 403 is a gap", () => {
  assert.equal(isTenMinRangeAbortError("MASSIVE_HTTP_403:TENMIN_WINDOW_GONE"), true);
  assert.equal(isTenMinRangeAbortError("TENMIN_TICKER_FORBIDDEN"), false);
});

test("errorClass keeps only the leading code (no tickers, keys or URLs in logs)", () => {
  assert.equal(errorClass(new Error("GUARD_WOULD_OVERWRITE:permanent/tenmin-reply-dust/x/AAPL")), "GUARD_WOULD_OVERWRITE");
  assert.equal(errorClass(new Error("MASSIVE_HTTP_500 /v2/aggs/ticker/AAPL")), "MASSIVE_HTTP_500");
});

test("guarded store: prefix only, never overwrite, dry refuses every PUT", async () => {
  const objects = new Map<string, Uint8Array>([[`${ONEOFF_PREFIX}old`, new Uint8Array([1])]]);
  const r2 = {
    get: async (k: string) => objects.get(k), head: async (k: string) => (objects.has(k) ? { metadata: {} } : undefined),
    list: async (p: string) => [...objects.keys()].filter((k) => k.startsWith(p)),
    put: async (k: string, b: Uint8Array) => { objects.set(k, b); },
  };
  let puts = 0;
  const s = guardedStore(r2, { dry: false, onPut: () => { puts += 1; } });
  await assert.rejects(s.put("permanent/daily-bars/2024-10.jsonl", new Uint8Array()), /GUARD_KEY_NOT_ALLOWED/u);
  await assert.rejects(s.put(`${ONEOFF_PREFIX}old`, new Uint8Array([2])), /GUARD_WOULD_OVERWRITE/u);
  assert.deepEqual([...objects.get(`${ONEOFF_PREFIX}old`)!], [1]);
  await s.put(`${ONEOFF_PREFIX}new`, new Uint8Array([3]));
  assert.equal(puts, 1);
  const dry = guardedStore(r2, { dry: true });
  await assert.rejects(dry.put(`${ONEOFF_PREFIX}other`, new Uint8Array()), /DRY_RUN_PUT/u);
});

test("timedFetch: normal reply passes; hung headers and hung body both settle at the timeout", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "x-a": "1" }); res.end("hello"); return; }
    if (req.url === "/body") { res.writeHead(200); res.write("part"); return; } // never ends
    // /hang: never answers
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const ok = await timedFetch(2_000)(`http://127.0.0.1:${port}/ok`);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get("x-a"), "1"); assert.equal(await ok.text(), "hello");
    const t = Date.now();
    await assert.rejects(timedFetch(300)(`http://127.0.0.1:${port}/hang`), /HTTP_TIMEOUT 300ms/u);
    await assert.rejects(timedFetch(300)(`http://127.0.0.1:${port}/body`), /HTTP_TIMEOUT 300ms/u);
    assert.ok(Date.now() - t < 3_000);
  } finally { server.closeAllConnections(); server.close(); }
});

test("storedByFetchFrom counts listed fetches by their first requested session", () => {
  const k1 = fetchIdentityKey({ securityId: "s1", symbol: "A", fetchFrom: "2024-10-11", fetchTo: "2024-10-31" });
  const k2 = fetchIdentityKey({ securityId: "s2", symbol: "B", fetchFrom: "2024-10-14", fetchTo: "2024-10-31" });
  const k3 = fetchIdentityKey({ securityId: "s3", symbol: "C", fetchFrom: "2024-10-11", fetchTo: "2024-10-31" });
  assert.deepEqual(storedByFetchFrom(new Map([[k1, new Set([1])], [k2, new Set([1])], [k3, new Set([1, 2])]])), { "2024-10-11": 2, "2024-10-14": 1 });
});

test("workflow: dispatch-only, main-only, minimal permissions, own concurrency group, inputs only via env", () => {
  const y = readFileSync(new URL("../.github/workflows/oct2024-tenmin.yml", import.meta.url), "utf8");
  const on = y.slice(y.indexOf("\non:"), y.indexOf("\npermissions:"));
  assert.match(on, /workflow_dispatch:/u);
  assert.doesNotMatch(on, /\n  (push|pull_request|pull_request_target|schedule|workflow_run|issue_comment):/u);
  assert.match(y, /\npermissions:\n  contents: read\n/u);
  assert.equal((y.match(/github\.ref == 'refs\/heads\/main'/gu) ?? []).length, 3);
  assert.match(y, /group: oct2024-tenmin-fetch\n      cancel-in-progress: false/u);
  assert.doesNotMatch(y, /peacestocks-r2-writer\n/u);
  // No ${{ inputs.* }} / step outputs interpolated into a run: script (only into env:).
  for (const block of y.split(/\n\s+run: \|?/u).slice(1)) {
    const script = block.split(/\n\s{6}- (?:name|uses):|\n  [a-z_]+:\n/u)[0]!;
    assert.doesNotMatch(script, /\$\{\{/u, script.slice(0, 80));
  }
  // Secrets only in the fetch step.
  assert.equal((y.match(/secrets\.MASSIVE_API_KEY/gu) ?? []).length, 1);
  // The workflow never changes repo variables itself (GITHUB_TOKEN cannot); it only alerts.
  assert.doesNotMatch(y, /^\s*gh variable/mu);
});
