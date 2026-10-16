// Daily-bars gap refill: grouped daily (one Massive request per session) stored exactly like the scanner:
// grouped Reply Dust (permanent/daily-reply-dust/<D>/), the month JSONL (ObjectMarketStorage.appendBars,
// the scanner's appendUnique), the month partition manifest (finalizeDailyPartition) and the daily-bars
// pack (maybeWriteScanDailyBarsSidecar, bound to the day's Dust). Oldest first.
// Write guard (GuardedClient): a new key is written freely; an existing key is NEVER replaced, except
//  - a refill month's JSONL, only when the new body keeps every existing line byte-for-byte and adds
//    only lines of refill sessions, and the stored bytes did not change since they were read;
//  - that month's partition manifest (metadata recomputed from the month file, as every scan does);
//  - a byte-identical rewrite is skipped (no PUT).
// Anything else throws REFILL_GUARD_REFUSED. Nothing is ever deleted.
import { createHash } from "node:crypto";
import type { CanonicalDailyBar, ProviderSecurityRecord, SecurityMasterRecord } from "./contracts";
import { dailyBarsFromReply, readDailyReplyDustBars, readDailyReplyDustManifest, writeDailyReplyDust } from "./daily-reply-dust";
import { maybeWriteScanDailyBarsSidecar } from "./daily-bars-sidecar";
import { decodeDailyBarsPack } from "./daily-bars-pack-decode";
import { decodeReplyDust } from "./reply-dust";
import { type MassiveMarketProvider, groupedDailySymbolIndex, symbolBySecurityIdFor } from "./massive-provider";
import type { ObjectClient, ObjectHead, ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { finalizeDailyPartition } from "./scanner";
import { corporateActionCoverageRecords } from "./corporate-action-coverage";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const td = new TextDecoder();
const MONTH_RE = /^permanent\/daily-bars\/(\d{4}-\d{2})\.jsonl$/u;
const PARTITION_RE = /^permanent\/partitions\/daily-bars-(\d{4}-\d{2})\.json$/u;

export class GuardedClient implements ObjectClient {
  readonly puts: string[] = [];
  readonly skippedIdentical: string[] = [];
  private readonly readSha = new Map<string, string | null>();
  private readonly months: Set<string>;
  private readonly actionSessions: ReadonlySet<string>;
  /** Called right before every PUT ("PUT"), right after it succeeds ("PUT_DONE"), and for a skipped identical rewrite. */
  onWrite?: (event: "PUT" | "PUT_DONE" | "PUT_FAILED" | "SKIP_IDENTICAL", key: string, bytes: number) => void;
  constructor(private readonly inner: ObjectClient, private readonly sessions: ReadonlySet<string>, private readonly backup?: (key: string, body: Uint8Array) => void, actionSessions?: ReadonlySet<string>) {
    this.months = new Set([...sessions].map((d) => d.slice(0, 7)));
    this.actionSessions = actionSessions ?? sessions;
  }
  async get(key: string) {
    const body = await this.inner.get(key);
    this.readSha.set(key, body ? sha(body) : null);
    return body;
  }
  head(key: string): Promise<ObjectHead | undefined> { return this.inner.head(key); }
  list(prefix: string) { return this.inner.list(prefix); }
  async delete(key: string): Promise<void> { throw new Error(`REFILL_GUARD_REFUSED:delete:${key}`); }
  async put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void> {
    const existing = await this.inner.get(key);
    if (existing) {
      if (sha(existing) === sha(body)) { this.skippedIdentical.push(key); this.onWrite?.("SKIP_IDENTICAL", key, body.length); return; }
      const month = MONTH_RE.exec(key)?.[1];
      const partition = PARTITION_RE.exec(key)?.[1];
      // The Dust writer replaces a file left without its manifest by its own crashed attempt.
      const dustLeftover = /^permanent\/daily-reply-dust\/(\d{4}-\d{2}-\d{2})\/grouped-daily\.rdust$/u.exec(key)?.[1];
      const ledger = key === "permanent/corporate-actions.jsonl" ? "effectiveDate" : key === "permanent/corporate-actions-coverage.jsonl" ? "sessionDate" : undefined;
      if (ledger) {
        if (this.readSha.get(key) !== sha(existing)) throw new Error(`REFILL_GUARD_REFUSED:ledger-changed-since-read:${key}`);
        const oldLines = td.decode(existing).split("\n").filter(Boolean);
        const newLines = td.decode(body).split("\n").filter(Boolean);
        const newSet = new Set(newLines);
        for (const line of oldLines) if (!newSet.has(line)) throw new Error(`REFILL_GUARD_REFUSED:ledger-line-changed:${key}`);
        const oldSet = new Set(oldLines);
        const re = new RegExp(`"${ledger}":"(\\d{4}-\\d{2}-\\d{2})"`, "u");
        for (const line of newLines) {
          if (oldSet.has(line)) continue;
          const d = re.exec(line)?.[1];
          if (!d || !this.actionSessions.has(d)) throw new Error(`REFILL_GUARD_REFUSED:ledger-foreign-line:${key}:${d}`);
        }
      } else if (month && this.months.has(month)) {
        if (this.readSha.get(key) !== sha(existing)) throw new Error(`REFILL_GUARD_REFUSED:month-changed-since-read:${key}`);
        const oldLines = td.decode(existing).split("\n").filter(Boolean);
        const newLines = td.decode(body).split("\n").filter(Boolean);
        const newSet = new Set(newLines);
        for (const line of oldLines) if (!newSet.has(line)) throw new Error(`REFILL_GUARD_REFUSED:month-line-changed:${key}`);
        const oldSet = new Set(oldLines);
        for (const line of newLines) {
          if (oldSet.has(line)) continue;
          const d = /"sessionDate":"(\d{4}-\d{2}-\d{2})"/u.exec(line)?.[1];
          if (!d || !this.sessions.has(d)) throw new Error(`REFILL_GUARD_REFUSED:month-foreign-line:${key}:${d}`);
        }
        if (newLines.length < oldLines.length) throw new Error(`REFILL_GUARD_REFUSED:month-shrinks:${key}`);
      } else if (partition && this.months.has(partition)) {
        // metadata only (recomputed by finalizeDailyPartition from the month file)
      } else if (dustLeftover && this.sessions.has(dustLeftover) && !(await this.inner.head(key.replace(/grouped-daily\.rdust$/u, "manifest.json")))) {
        // crashed-attempt leftover of a refill session without a manifest
      } else throw new Error(`REFILL_GUARD_REFUSED:existing-key:${key}`);
      this.backup?.(key, existing);
    }
    this.onWrite?.("PUT", key, body.length);
    try { await this.inner.put(key, body, metadata); }
    catch (e) { this.onWrite?.("PUT_FAILED", key, body.length); throw e; }
    this.onWrite?.("PUT_DONE", key, body.length);
    this.puts.push(key);
  }
}

export function providerRecords(securities: SecurityMasterRecord[], provider: string): ProviderSecurityRecord[] {
  // Same mapping as src/backfill.ts providerRecords.
  return securities.flatMap((security) => {
    const identity = security.providerIdentities.find((item) => item.provider === provider);
    return identity
      ? [{
          provider, providerSecurityId: identity.providerSecurityId, symbol: security.currentSymbol, assetType: security.assetType,
          country: security.country, exchange: security.exchange, active: security.status === "ACTIVE", tradable: security.tradable,
          ...(security.fractional === undefined ? {} : { fractional: security.fractional }),
          ...(security.listingDate === undefined ? {} : { listingDate: security.listingDate }),
        }]
      : [];
  });
}

export interface RefillDeps {
  client: ObjectClient; // the raw store; refill wraps it in GuardedClient
  provider: MassiveMarketProvider; // keepRawReplies: true
  sessions: string[]; // the target sessions (oldest first)
  /** Blocks until the key may be used; returns a reason to stop (STOP file). */
  gate: (what: string) => Promise<string | undefined>;
  log: (event: string, data?: unknown) => void;
  backup?: (key: string, body: Uint8Array) => void;
  zstdVersionProbe?: () => string;
  /** Write log hook, passed to GuardedClient.onWrite. */
  onWrite?: GuardedClient["onWrite"];
  /** Sessions whose corporate actions to fetch (by date range) if not yet covered. Default: sessions. */
  actionSessions?: string[];
}

export interface RefillResult {
  massiveRequests: number;
  dustWritten: string[];
  dustReused: string[];
  barsAppended: Record<string, number>;
  packsWritten: string[];
  alreadyDone: string[];
  stopped?: string;
  corporateActions?: { requests: number; ranges: { from: string; to: string }[]; sessions: number; actionsStored: number; dropped: number; alreadyCovered: number; stopped?: string };
  puts: number;
  skippedIdentical: number;
}

export async function refill(deps: RefillDeps): Promise<RefillResult> {
  const target = new Set(deps.sessions);
  const actionTarget = new Set(deps.actionSessions ?? deps.sessions);
  const guarded = new GuardedClient(deps.client, target, deps.backup, actionTarget);
  if (deps.onWrite) guarded.onWrite = deps.onWrite;
  const storage = new ObjectMarketStorage(guarded);
  const provider = deps.provider;
  const securities = await storage.loadSecurities();
  if (!securities.length) throw new Error("REFILL_NO_SECURITY_MASTER");
  const records = providerRecords(securities, provider.providerName);
  provider.bindUniverse(records);
  const activeIds = securities.filter((s) => s.status === "ACTIVE").map((s) => s.securityId);
  const bySymbol = groupedDailySymbolIndex(symbolBySecurityIdFor(records), activeIds);
  const res: RefillResult = { massiveRequests: 0, dustWritten: [], dustReused: [], barsAppended: {}, packsWritten: [], alreadyDone: [], puts: 0, skippedIdentical: 0 };
  res.corporateActions = await refillCorporateActions({ guarded, storage, provider, activeIds, records, sessions: [...actionTarget].sort(), gate: deps.gate, log: deps.log });
  if (res.corporateActions.stopped) { res.stopped = res.corporateActions.stopped; res.puts = guarded.puts.length; res.skippedIdentical = guarded.skippedIdentical.length; return res; }
  const months = [...new Set(deps.sessions.map((d) => d.slice(0, 7)))].sort();
  const zstd = deps.zstdVersionProbe ? { zstdVersionProbe: deps.zstdVersionProbe } : {};
  for (const month of months) {
    const monthSessions = deps.sessions.filter((d) => d.startsWith(month)).sort();
    const stored = new Set<string>();
    {
      const body = await guarded.get(`permanent/daily-bars/${month}.jsonl`);
      for (const m of td.decode(body ?? new Uint8Array()).matchAll(/"sessionDate":"(\d{4}-\d{2}-\d{2})"/gu)) stored.add(m[1]!);
    }
    const barsBySession = new Map<string, CanonicalDailyBar[]>();
    for (const d of monthSessions) {
      const packDone = await guarded.head(`permanent/daily-bars-sidecar/${d}/manifest.json`);
      if (packDone && stored.has(d)) { res.alreadyDone.push(d); continue; }
      if (await readDailyReplyDustManifest(guarded, d)) {
        barsBySession.set(d, await readDailyReplyDustBars(guarded, d, bySymbol));
        res.dustReused.push(d);
        continue;
      }
      const stop = await deps.gate(`fetch ${d}`);
      if (stop) { res.stopped = stop; break; }
      if (provider.takeRawReplies().length) throw new Error("REFILL_UNEXPECTED_HELD_REPLIES");
      res.massiveRequests += 1;
      const bars = await provider.getDailyBars(d, activeIds);
      const replies = provider.takeRawReplies();
      const reply = replies[0];
      if (replies.length !== 1 || !reply || reply.dataset !== "stocks-grouped-daily" || reply.sessionDate !== d)
        throw new Error(`REFILL_REPLY_MISSING_OR_UNEXPECTED:${d}:${replies.length}`);
      if (!bars.length) throw new Error(`REFILL_EMPTY_GROUPED_DAILY:${d}`);
      const observedAt = bars[0]!.observedAt;
      const rebuilt = dailyBarsFromReply({ provider: provider.providerName, sessionDate: d, observedAt, reply: reply.body, bySymbol });
      if (JSON.stringify(rebuilt) !== JSON.stringify(bars)) throw new Error(`REFILL_DAILY_REBUILD_MISMATCH:${d}`);
      await writeDailyReplyDust(guarded, reply, { provider: provider.providerName, observedAt });
      res.dustWritten.push(d);
      barsBySession.set(d, bars);
      deps.log("session-fetched", { session: d, bars: bars.length, observedAt });
    }
    const pending = [...barsBySession.keys()].sort();
    if (pending.length) {
      const gateStop = await deps.gate(`append ${month}`);
      if (gateStop) { res.stopped = gateStop; break; }
      const all = pending.flatMap((d) => barsBySession.get(d)!);
      await storage.appendBars(all);
      res.barsAppended[month] = all.length;
      await finalizeDailyPartition(storage, pending.at(-1)!, provider.providerName, "GOOD");
      const monthBody = td.decode((await guarded.get(`permanent/daily-bars/${month}.jsonl`)) ?? new Uint8Array());
      const storedBySession = new Map<string, CanonicalDailyBar[]>();
      const pendingSet = new Set(pending);
      for (const line of monthBody.split("\n")) {
        if (!line) continue;
        const sd = /"sessionDate":"(\d{4}-\d{2}-\d{2})"/u.exec(line)?.[1];
        if (sd && pendingSet.has(sd)) storedBySession.set(sd, [...(storedBySession.get(sd) ?? []), JSON.parse(line) as CanonicalDailyBar]);
      }
      for (const d of pending) {
        const sessionBars = storedBySession.get(d) ?? [];
        const report = await maybeWriteScanDailyBarsSidecar({ enabled: true, store: guarded, sessionDate: d, bars: sessionBars, securities, ...zstd });
        if (report.failure) throw new Error(`REFILL_PACK_FAILED:${report.failure}`);
        res.packsWritten.push(d);
      }
      deps.log("month-stored", { month, sessions: pending, rows: all.length });
    }
    if (res.stopped) break;
  }
  res.puts = guarded.puts.length;
  res.skippedIdentical = guarded.skippedIdentical.length;
  return res;
}

export interface VerifyRow { session: string; ok: boolean; rows: number; source?: string; observedAt?: string; error?: string }

/** Read back each session: pack decodes (independent decoder) to the month JSONL's lines byte-for-byte; Dust manifest has observedAt. */
export async function verifySessions(client: Pick<ObjectClient, "get">, sessions: string[]): Promise<VerifyRow[]> {
  const out: VerifyRow[] = [];
  const monthLines = new Map<string, Map<string, string[]>>();
  for (const d of sessions) {
    try {
      const month = d.slice(0, 7);
      if (!monthLines.has(month)) {
        const body = await client.get(`permanent/daily-bars/${month}.jsonl`);
        const bySession = new Map<string, string[]>();
        for (const line of td.decode(body ?? new Uint8Array()).split("\n")) {
          if (!line) continue;
          const s = /"sessionDate":"(\d{4}-\d{2}-\d{2})"/u.exec(line)![1]!;
          bySession.set(s, [...(bySession.get(s) ?? []), line]);
        }
        monthLines.set(month, bySession);
      }
      const jsonl = monthLines.get(month)!.get(d) ?? [];
      const dustManifestBytes = await client.get(`permanent/daily-reply-dust/${d}/manifest.json`);
      if (!dustManifestBytes) throw new Error("NO_DUST_MANIFEST");
      const dm = JSON.parse(td.decode(dustManifestBytes)) as { observedAt?: string };
      if (typeof dm.observedAt !== "string" || !dm.observedAt) throw new Error("DUST_MANIFEST_NO_OBSERVED_AT");
      const file = await client.get(`permanent/daily-bars-sidecar/${d}/sidecar.dbs`);
      const manifest = await client.get(`permanent/daily-bars-sidecar/${d}/manifest.json`);
      if (!file || !manifest) throw new Error("NO_PACK");
      const m = JSON.parse(td.decode(manifest)) as { dustReplySha256?: string };
      let dustReply: Uint8Array | null = null;
      if (m.dustReplySha256) dustReply = decodeReplyDust((await client.get(`permanent/daily-reply-dust/${d}/grouped-daily.rdust`))!);
      const decoded = decodeDailyBarsPack({ file, manifest, dustReply });
      if (!jsonl.length) throw new Error("NO_JSONL_ROWS");
      if (decoded.lines.length !== jsonl.length) throw new Error(`ROW_COUNT ${decoded.lines.length}!=${jsonl.length}`);
      for (let i = 0; i < jsonl.length; i++) if (decoded.lines[i] !== jsonl[i]) throw new Error(`LINE_MISMATCH_AT_${i}`);
      // every JSONL row carries the Dust observedAt
      if (!process.env.VERIFY_SKIP_ROW_OBSERVED_AT) for (const line of jsonl) if (!line.includes(`"observedAt":"${dm.observedAt}"`)) throw new Error("ROW_OBSERVED_AT_DIFFERS_FROM_DUST");
      out.push({ session: d, ok: true, rows: jsonl.length, source: decoded.source, observedAt: dm.observedAt });
    } catch (e) {
      out.push({ session: d, ok: false, rows: 0, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return out;
}

const scalarDetails = (record: Record<string, unknown>): Record<string, string | number | boolean> =>
  // Same as massive-provider.ts details(): every scalar field except ticker.
  Object.fromEntries(Object.entries(record).filter(([key, value]) => key !== "ticker" && ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean>;
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Contiguous date ranges over the sorted sessions, split where consecutive sessions are > maxGapDays apart. */
export function actionRanges(sessions: readonly string[], maxGapDays = 60): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const d of [...sessions].sort()) {
    const last = out.at(-1);
    if (last && (Date.parse(d) - Date.parse(last.to)) / 86_400_000 <= maxGapDays) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

/**
 * Splits + dividends for the not-yet-covered sessions, by date range (a few paginated requests), mapped exactly
 * like MassiveMarketProvider.getCorporateActions (actionId = provider id, effectiveDate = the session,
 * details = scalar fields minus ticker, same provenance), stored with storage.appendActions (corporate-actions.jsonl,
 * appendUnique by actionId) plus one coverage line per session (corporate-actions-coverage.jsonl).
 * Actions dated outside the target sessions are dropped (the old per-session fetch never asked for them).
 */
export async function refillCorporateActions(o: {
  guarded: GuardedClient; storage: ObjectMarketStorage; provider: MassiveMarketProvider; activeIds: string[];
  records: ProviderSecurityRecord[]; sessions: string[]; gate: (what: string) => Promise<string | undefined>; log: (e: string, d?: unknown) => void;
}): Promise<NonNullable<RefillResult["corporateActions"]> & { stopped?: string }> {
  const covered = new Set<string>();
  for (const m of td.decode((await o.guarded.get("permanent/corporate-actions.jsonl")) ?? new Uint8Array()).matchAll(/"effectiveDate":"(\d{4}-\d{2}-\d{2})"/gu)) covered.add(m[1]!);
  for (const line of td.decode((await o.guarded.get("permanent/corporate-actions-coverage.jsonl")) ?? new Uint8Array()).split("\n")) if (line) covered.add(JSON.parse(line).sessionDate);
  const todo = o.sessions.filter((d) => !covered.has(d));
  const res = { requests: 0, ranges: actionRanges(todo), sessions: todo.length, actionsStored: 0, dropped: 0, alreadyCovered: o.sessions.length - todo.length } as NonNullable<RefillResult["corporateActions"]> & { stopped?: string };
  if (!todo.length) return res;
  const todoSet = new Set(todo);
  const ids = new Set(o.activeIds);
  // getCorporateActions builds symbol -> id from the bound universe filtered to the requested ids (later id wins).
  const bySymbol = new Map([...symbolBySecurityIdFor(o.records).entries()].filter(([id]) => ids.has(id)).map(([id, sym]) => [sym, id]));
  const get = (o.provider as unknown as { get(p: string, q?: Record<string, string>): Promise<Record<string, unknown>> }).get.bind(o.provider);
  const fetchAll = async (path: string, dateParam: string, r: { from: string; to: string }) => {
    const out: Record<string, unknown>[] = [];
    let page = 0;
    let next: string | undefined;
    do {
      const stop = await o.gate(`corporate-actions ${path} ${r.from}..${r.to} page ${page + 1}`);
      if (stop) throw Object.assign(new Error("STOPPED"), { stop });
      res.requests += 1;
      const reply = next ? await get(next) : await get(path, { [`${dateParam}.gte`]: r.from, [`${dateParam}.lte`]: r.to, limit: "5000", order: "asc" });
      out.push(...(Array.isArray(reply.results) ? (reply.results as Record<string, unknown>[]) : []));
      next = str(reply.next_url);
      if (++page > 60) throw new Error(`REFILL_CORPORATE_ACTIONS_TOO_MANY_PAGES:${path}`);
    } while (next);
    return out;
  };
  const actions: import("./contracts").CorporateAction[] = [];
  try {
    for (const r of res.ranges) {
      const splits = await fetchAll("/stocks/v1/splits", "execution_date", r);
      const dividends = await fetchAll("/stocks/v1/dividends", "ex_dividend_date", r);
      const observedAt = new Date().toISOString();
      const provenance = (dataset: string, id: string) => ({ provider: o.provider.providerName, dataset, retrievalId: id, providerTimestamp: observedAt, ingestionVersion: "markets-scanner-v0", normalizerVersion: "massive-v1" });
      for (const [list, dateField, type] of [[splits, "execution_date", "split"], [dividends, "ex_dividend_date", "dividend"]] as const) {
        for (const raw of list) {
          const date = str(raw[dateField]);
          const id = bySymbol.get(str(raw.ticker) ?? "");
          if (!date || !todoSet.has(date)) { res.dropped += 1; continue; }
          if (!id) continue; // same as getCorporateActions: names outside the active universe are skipped
          const actionId = str(raw.id) ?? `${type}:${id}:${date}`;
          actions.push({
            actionId, securityId: id,
            actionType: type === "split" ? (str(raw.adjustment_type) === "reverse_split" ? "REVERSE_SPLIT" : "SPLIT") : "DIVIDEND",
            effectiveDate: date, details: scalarDetails(raw), observedAt,
            provenance: provenance(type === "split" ? "stocks-splits" : "stocks-dividends", actionId),
          } as import("./contracts").CorporateAction);
        }
      }
      o.log("corporate-actions-range", { ...r, splits: splits.length, dividends: dividends.length });
    }
  } catch (e) {
    const stop = (e as { stop?: string }).stop;
    if (stop) { res.stopped = stop; return res; }
    throw e;
  }
  const stop = await o.gate("corporate-actions store");
  if (stop) { res.stopped = stop; return res; }
  actions.sort((a, b) => a.actionId.localeCompare(b.actionId));
  await o.storage.appendActions(actions);
  res.actionsStored = actions.length;
  await o.storage.recordCorporateActionCoverage(corporateActionCoverageRecords(todo, actions, { provider: o.provider.providerName, source: "daily-gap-refill", recordedAt: new Date().toISOString() }));
  o.log("corporate-actions-stored", { sessions: todo.length, actions: actions.length, requests: res.requests, dropped: res.dropped });
  return res;
}
