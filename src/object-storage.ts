import { writeVerifiedHealthJson } from "./health-checkins";
import { SCAN_HEALTH_LATEST_KEY, type ScanHealthRecord, scanHealthKey } from "./scan-health";
import { CORPORATE_ACTION_COVERAGE_KEY, type CorporateActionCoverageRecord } from "./corporate-action-coverage";
import { createHash } from "node:crypto";
import { isSplitAction, SETTLEMENT_ACTION_TYPES } from "./split-adjust";
import type {
  CanonicalDailyBar,
  CorporateAction,
  CorrectionRecord,
  PartitionManifest,
  PredictionSet,
  PredictionStatus,
  ScannerRunReport,
  SecurityMasterRecord,
  StorageReport,
  UniverseMembershipEvidence,
} from "./contracts";
import { type DailyBarSessionIndex, indexDailyBarSessions, requireMonth } from "./daily-bar-sessions";
import { stableJson } from "./identity";
import {
  loadTickerReferenceIndex,
  type TickerReferenceCapture,
  type TickerReferenceIndexManifest,
  writeTickerReferenceIndex,
} from "./ticker-reference-index";
import type { ObjectClient, ObjectListing } from "./object-store";
import { R2ObjectClient } from "./object-store";
import { MarketStorage, monthsBetween, type MarketStore } from "./storage";

type StoredRecord =
  | SecurityMasterRecord
  | UniverseMembershipEvidence
  | CanonicalDailyBar
  | CorporateAction
  | CorrectionRecord
  | PredictionSet
  | PredictionStatus;

const text = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : "";
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function lines<T>(body: string): T[] {
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** A record as it reads back from storage (undefined fields dropped), as canonical JSON. */
function storedJson(record: unknown): string {
  return stableJson(JSON.parse(JSON.stringify(record)));
}

function lineText(records: StoredRecord[]): string {
  return records.map((record) => stableJson(record)).join("\n") + (records.length ? "\n" : "");
}

export interface PendingArchiveRecord {
  objectId: string;
  sha256: string;
  byteSize: number;
  acked: boolean;
  format: "opaque-pending-evidence";
}

function safeObjectId(objectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(objectId)) throw new Error("PENDING_ARCHIVE_ID_INVALID");
  return objectId;
}

export class ObjectMarketStorage implements MarketStore {
  constructor(private readonly client: ObjectClient) {}

  async initialize(): Promise<void> {}

  private async readText(key: string): Promise<string> {
    return text(await this.client.get(key));
  }

  private async writeText(key: string, value: string): Promise<void> {
    await this.client.put(key, bytes(value));
  }

  async loadSecurities(): Promise<SecurityMasterRecord[]> {
    const body = await this.readText("permanent/security-master.json");
    return body ? (JSON.parse(body) as SecurityMasterRecord[]) : [];
  }

  async saveSecurities(records: SecurityMasterRecord[]): Promise<void> {
    await this.writeText(
      "permanent/security-master.json",
      JSON.stringify(records.sort((a, b) => a.securityId.localeCompare(b.securityId)), null, 2) + "\n",
    );
  }

  async saveTickerReferenceIndex(
    capture: TickerReferenceCapture,
    options: { provider: string; asOf: string },
  ): Promise<TickerReferenceIndexManifest> {
    return writeTickerReferenceIndex(this.client, capture, options);
  }

  async loadTickerReferenceIndex() {
    return loadTickerReferenceIndex(this.client);
  }

  async loadMembership(): Promise<UniverseMembershipEvidence[]> {
    return lines(await this.readText("permanent/universe-membership.jsonl"));
  }

  async appendMembership(records: UniverseMembershipEvidence[]): Promise<void> {
    await this.appendUnique(
      "permanent/universe-membership.jsonl",
      records,
      (record) => `${record.securityId}|${record.effectiveDate}|${record.included}`,
    );
  }

  async loadBars(sessionDate?: string): Promise<CanonicalDailyBar[]> {
    if (sessionDate)
      return lines<CanonicalDailyBar>(
        await this.readText(`permanent/daily-bars/${sessionDate.slice(0, 7)}.jsonl`),
      ).filter((bar) => bar.sessionDate === sessionDate);
    const keys = await this.client.list("permanent/daily-bars/");
    const groups = await Promise.all(keys.map(async (key) => lines<CanonicalDailyBar>(await this.readText(key))));
    return groups.flat();
  }

  async loadBarsBetween(from: string, to: string): Promise<CanonicalDailyBar[]> {
    const output: CanonicalDailyBar[] = [];
    // One month file at a time; a line is parsed only when its sessionDate is inside the window.
    for (const month of monthsBetween(from, to)) {
      const body = await this.readText(`permanent/daily-bars/${month}.jsonl`);
      for (const line of body.split("\n")) {
        if (!line) continue;
        const date = /"sessionDate":"(\d{4}-\d{2}-\d{2})"/u.exec(line)?.[1];
        if (date !== undefined && (date < from || date > to)) continue;
        const bar = JSON.parse(line) as CanonicalDailyBar;
        if (bar.sessionDate >= from && bar.sessionDate <= to) output.push(bar);
      }
    }
    return output;
  }

  async loadDailyBarSessions(month: string): Promise<DailyBarSessionIndex> {
    requireMonth(month);
    const body = await this.client.get(`permanent/daily-bars/${month}.jsonl`);
    return body ? indexDailyBarSessions(body, new Map(), month) : new Map();
  }

  async appendBars(records: CanonicalDailyBar[]): Promise<void> {
    if (!records.length) return;
    const byMonth = new Map<string, CanonicalDailyBar[]>();
    for (const record of records) {
      const month = record.sessionDate.slice(0, 7);
      const list = byMonth.get(month);
      if (list) list.push(record);
      else byMonth.set(month, [record]);
    }
    const corrections: CorrectionRecord[] = [];
    for (const [month, monthRecords] of byMonth) {
      const keyName = `permanent/daily-bars/${month}.jsonl`;
      const got = this.client.getWithEtag
        ? await this.client.getWithEtag(keyName)
        : await this.client.get(keyName).then((body) => (body ? { body, etag: undefined } : undefined));
      const readSha = got ? createHash("sha256").update(got.body).digest("hex") : undefined;
      const oldLines = got ? text(got.body).split("\n").filter(Boolean) : [];
      // Keep existing lines byte-for-byte; only append new (securityId, sessionDate, revision) keys.
      const firstByKey = new Map<string, { record: CanonicalDailyBar; line: string }>();
      for (const rawLine of oldLines) {
        const item = JSON.parse(rawLine) as CanonicalDailyBar;
        const k = `${item.securityId}|${item.sessionDate}|${item.revision}`;
        if (!firstByKey.has(k)) firstByKey.set(k, { record: item, line: rawLine });
      }
      let added = 0;
      const addedRecords: CanonicalDailyBar[] = [];
      for (const record of monthRecords) {
        const k = `${record.securityId}|${record.sessionDate}|${record.revision}`;
        if (firstByKey.has(k)) continue;
        firstByKey.set(k, { record, line: stableJson(record) });
        added += 1;
        addedRecords.push(record);
      }
      if (added === 0) continue;
      for (const record of addedRecords) {
        const prior = firstByKey.get(`${record.securityId}|${record.sessionDate}|${record.revision - 1}`)?.record;
        if (prior)
          corrections.push({
            correctionId: `${record.securityId}|${record.sessionDate}|${record.revision}`,
            evidenceKey: `${record.securityId}|${record.sessionDate}`,
            supersedesRevision: prior.revision,
            replacementRevision: record.revision,
            reason: "provider-revision",
            correctedAt: record.ingestedAt,
            provenance: record.provenance,
          });
      }
      const newLines = [...firstByKey.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, entry]) => entry.line);
      const newIndex = new Map<string, number>();
      newLines.forEach((line, idx) => newIndex.set(line, idx));
      let prevIdx = -1;
      for (const oldLine of oldLines) {
        const idx = newIndex.get(oldLine);
        if (idx === undefined) throw new Error(`DAILY_BARS_MONTH_LINE_LOST:${keyName}`);
        if (idx <= prevIdx) throw new Error(`DAILY_BARS_MONTH_ORDER_DRIFT:${keyName}`);
        prevIdx = idx;
      }
      if (newLines.length < oldLines.length) throw new Error(`DAILY_BARS_MONTH_SHRUNK:${keyName}`);
      const nextBytes = bytes(newLines.join("\n") + "\n");
      const nextSha = createHash("sha256").update(nextBytes).digest("hex");
      if (readSha !== undefined && nextSha === readSha) continue;
      this.barCountsByKey.delete(keyName);
      if (!got) {
        if (this.client.putIfAbsent) {
          if (!(await this.client.putIfAbsent(keyName, nextBytes)))
            throw new Error(`DAILY_BARS_MONTH_SHA_DRIFT:${keyName}`);
        } else {
          if (await this.client.get(keyName)) throw new Error(`DAILY_BARS_MONTH_SHA_DRIFT:${keyName}`);
          await this.client.put(keyName, nextBytes);
        }
      } else if (got.etag !== undefined && this.client.putIfMatch) {
        if (!(await this.client.putIfMatch(keyName, nextBytes, got.etag)))
          throw new Error(`DAILY_BARS_MONTH_SHA_DRIFT:${keyName}`);
      } else {
        const current = await this.client.get(keyName);
        if (!current || createHash("sha256").update(current).digest("hex") !== readSha)
          throw new Error(`DAILY_BARS_MONTH_SHA_DRIFT:${keyName}`);
        await this.client.put(keyName, nextBytes);
      }
      this.barCountsByKey.delete(keyName);
    }
    if (corrections.length > 0) await this.appendCorrections(corrections);
  }

  async appendCorrections(records: CorrectionRecord[]): Promise<void> {
    await this.appendUnique("permanent/corrections.jsonl", records, (record) => record.correctionId);
  }

  async appendActions(records: CorporateAction[]): Promise<void> {
    await this.appendUnique("permanent/corporate-actions.jsonl", records, (record) => record.actionId);
  }

  async loadSplitActions(): Promise<CorporateAction[]> {
    return lines<CorporateAction>(await this.readText("permanent/corporate-actions.jsonl")).filter(isSplitAction);
  }

  /** Stored MERGER / CLOSURE / DELISTING records (paper trading: cash settlements of STUCK holdings). */
  async loadSettlementActions(): Promise<CorporateAction[]> {
    return lines<CorporateAction>(await this.readText("permanent/corporate-actions.jsonl")).filter((action) => SETTLEMENT_ACTION_TYPES.includes(action.actionType));
  }

  /** One line per session whose splits + dividends were fetched and stored (see corporate-action-coverage.ts). */
  async recordCorporateActionCoverage(records: CorporateActionCoverageRecord[]): Promise<void> {
    if (!records.length) return;
    await this.appendUnique(
      CORPORATE_ACTION_COVERAGE_KEY,
      records as unknown as StoredRecord[],
      (record) => (record as unknown as CorporateActionCoverageRecord).sessionDate,
    );
  }

  async writePredictions(records: PredictionSet[]): Promise<void> {
    const sessionDate = records[0]?.sessionDate;
    if (!sessionDate) return;
    await this.writeImmutable(
      `permanent/predictions/${sessionDate}.jsonl`,
      records,
      (record) => record.predictionId,
    );
  }

  async writePredictionStatus(record: PredictionStatus): Promise<void> {
    await this.writeImmutable(
      `permanent/prediction-status/${record.sessionDate}.jsonl`,
      [record],
      (item) => item.predictionStatusId,
    );
  }

  private async readJsonl<T>(keyOrPrefix: string, exact: boolean): Promise<T[]> {
    const keys = exact ? [keyOrPrefix] : await this.client.list(keyOrPrefix);
    const rows: T[] = [];
    for (const key of keys) rows.push(...lines<T>(await this.readText(key)));
    return rows;
  }

  async loadPredictions(sessionDate?: string): Promise<PredictionSet[]> {
    return sessionDate
      ? this.readJsonl(`permanent/predictions/${sessionDate}.jsonl`, true)
      : this.readJsonl("permanent/predictions/", false);
  }

  async loadPredictionStatuses(sessionDate?: string): Promise<PredictionStatus[]> {
    return sessionDate
      ? this.readJsonl(`permanent/prediction-status/${sessionDate}.jsonl`, true)
      : this.readJsonl("permanent/prediction-status/", false);
  }

  async writePartitionManifest(manifest: PartitionManifest): Promise<void> {
    await this.writeText(
      `permanent/partitions/${manifest.partitionId}.json`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  async writeRunReport(report: unknown): Promise<void> {
    const typed = report as { runId?: string; status?: string };
    const runId = typed.runId;
    if (!runId) throw new Error("RUN_ID_REQUIRED");
    const file =
      typed.status === "ALREADY_FROZEN" ? `${runId}.already-frozen.json` : `${runId}.json`;
    await this.writeText(`runs/${file}`, JSON.stringify(report, null, 2) + "\n");
  }

  /** Same size + checksum read-back as the health check's own reports (writeVerifiedHealthJson). */
  async writeScanHealth(record: ScanHealthRecord): Promise<void> {
    await writeVerifiedHealthJson(this.client, scanHealthKey(record.sessionDate), record);
    await writeVerifiedHealthJson(this.client, SCAN_HEALTH_LATEST_KEY, record);
  }

  async loadRunReports(): Promise<ScannerRunReport[]> {
    const keys = (await this.client.list("runs/")).filter((key) => key.endsWith(".json"));
    const reports: ScannerRunReport[] = [];
    for (const key of keys) {
      const body = await this.readText(key);
      if (body) reports.push(JSON.parse(body) as ScannerRunReport);
    }
    return reports.sort((left, right) => left.session.sessionDate.localeCompare(right.session.sessionDate));
  }

  private storageSizes: Promise<Record<string, number>> | undefined;

  /**
   * Bytes per top-level category, measured once per storage instance (one host run) from the
   * listing's sizes. It used to GET every object in the bucket on every run report, which grew with
   * the ten-minute history and timed out the scheduled scan; the bodies were only used for length.
   */
  private measureCategoryBytes(): Promise<Record<string, number>> {
    this.storageSizes ??= (async () => {
      const categoryBytes: Record<string, number> = { permanent: 0, cache: 0, transient: 0 };
      let entries: ObjectListing[];
      if (this.client.listSizes) entries = await this.client.listSizes("");
      else {
        // Clients without sized listings: one HEAD per key (still no bodies).
        entries = [];
        for (const key of await this.client.list("")) entries.push({ key, size: (await this.client.head(key))?.size ?? 0 });
      }
      for (const { key, size } of entries) {
        if (key.startsWith("permanent/")) categoryBytes.permanent = (categoryBytes.permanent ?? 0) + size;
        else if (key.startsWith("cache/")) categoryBytes.cache = (categoryBytes.cache ?? 0) + size;
        else if (key.startsWith("transient/")) categoryBytes.transient = (categoryBytes.transient ?? 0) + size;
      }
      return categoryBytes;
    })();
    this.storageSizes.catch(() => {
      this.storageSizes = undefined;
    });
    return this.storageSizes;
  }

  async measureStorage(): Promise<StorageReport> {
    const categoryBytes = { ...(await this.measureCategoryBytes()) };
    const permanentBytesToday = categoryBytes.permanent ?? 0;
    const rollingMbPerDay = permanentBytesToday / 1024 / 1024;
    return {
      permanentBytesToday,
      cacheBytes: categoryBytes.cache ?? 0,
      transientBytesCreated: categoryBytes.transient ?? 0,
      transientBytesDeleted: 0,
      rollingMbPerDay,
      projectedGbPerYear: (rollingMbPerDay * 252) / 1024,
      targetUtilizationPercent: ((rollingMbPerDay * 252) / 1024 / 10) * 100,
      categoryBytes,
    };
  }

  async readPermanent(relativePath: string): Promise<Buffer> {
    const body = await this.client.get(`permanent/${relativePath}`);
    return Buffer.from(body ?? new Uint8Array());
  }

  async loadSchedulerState(): Promise<unknown> {
    const body = await this.readText("scheduler-host-state.json");
    return body ? (JSON.parse(body) as unknown) : undefined;
  }

  async saveSchedulerState(state: unknown): Promise<void> {
    await this.writeText("scheduler-host-state.json", JSON.stringify(state, null, 2) + "\n");
  }

  async loadBackfillProgress(): Promise<unknown> {
    const body = await this.readText("backfill-state.json");
    return body ? (JSON.parse(body) as unknown) : undefined;
  }

  async saveBackfillProgress(state: unknown): Promise<void> {
    await this.writeText("backfill-state.json", JSON.stringify(state, null, 2) + "\n");
  }

  async loadBackfillReopenProgress(): Promise<unknown> {
    const body = await this.readText("backfill-reopen-state.json");
    return body ? (JSON.parse(body) as unknown) : undefined;
  }

  async saveBackfillReopenProgress(state: unknown): Promise<void> {
    await this.writeText("backfill-reopen-state.json", JSON.stringify(state, null, 2) + "\n");
  }

  /** Per month file: securityId -> stored bar lines. Kept for this storage instance (one host run). */
  private readonly barCountsByKey = new Map<string, Map<string, number>>();

  /**
   * Stored bar lines per security across every month file. Each month is read once per storage
   * instance, one at a time; appendBars drops the cached count of each month it rewrites, so only
   * those months are read again. (It used to re-read every month on every session.)
   */
  async tallyBarCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const key of await this.client.list("permanent/daily-bars/")) {
      let monthCounts = this.barCountsByKey.get(key);
      if (!monthCounts) {
        monthCounts = new Map<string, number>();
        const body = await this.readText(key);
        for (const line of body.split("\n")) {
          if (!line) continue;
          const securityId = /"securityId":"([^"]+)"/u.exec(line)?.[1];
          if (securityId) monthCounts.set(securityId, (monthCounts.get(securityId) ?? 0) + 1);
        }
        this.barCountsByKey.set(key, monthCounts);
      }
      for (const [securityId, count] of monthCounts) counts.set(securityId, (counts.get(securityId) ?? 0) + count);
    }
    return counts;
  }

  async putPendingArchive(objectId: string, body: Uint8Array): Promise<PendingArchiveRecord> {
    const id = safeObjectId(objectId);
    const record: PendingArchiveRecord = {
      objectId: id,
      sha256: createHash("sha256").update(body).digest("hex"),
      byteSize: body.byteLength,
      acked: false,
      format: "opaque-pending-evidence",
    };
    await this.client.put(`pending-archive/${id}.bin`, body);
    await this.writeText(`pending-archive/${id}.json`, JSON.stringify(record) + "\n");
    return record;
  }

  async readPendingArchive(objectId: string): Promise<Uint8Array | undefined> {
    return this.client.get(`pending-archive/${safeObjectId(objectId)}.bin`);
  }

  async ackPendingArchive(objectId: string): Promise<void> {
    const record = await this.pendingRecord(objectId);
    await this.writeText(
      `pending-archive/${record.objectId}.json`,
      JSON.stringify({ ...record, acked: true }) + "\n",
    );
  }

  async purgePendingArchive(objectId: string): Promise<void> {
    const record = await this.pendingRecord(objectId);
    if (!record.acked) throw new Error("PENDING_ARCHIVE_NOT_ACKED");
    await this.client.delete(`pending-archive/${record.objectId}.bin`);
    await this.client.delete(`pending-archive/${record.objectId}.json`);
  }

  private async pendingRecord(objectId: string): Promise<PendingArchiveRecord> {
    const id = safeObjectId(objectId);
    const body = await this.readText(`pending-archive/${id}.json`);
    if (!body) throw new Error("PENDING_ARCHIVE_MISSING");
    return JSON.parse(body) as PendingArchiveRecord;
  }

  private async appendUnique<T extends StoredRecord>(
    keyName: string,
    incoming: T[],
    key: (record: T) => string,
  ): Promise<void> {
    if (!incoming.length) return;
    const existing = lines<T>(await this.readText(keyName));
    const byKey = new Map(existing.map((record) => [key(record), record]));
    let added = 0;
    for (const record of incoming) {
      if (!byKey.has(key(record))) {
        byKey.set(key(record), record);
        added += 1;
      }
    }
    if (added === 0) return;
    await this.writeText(keyName, lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]));
  }

  private async writeImmutable<T extends StoredRecord>(
    keyName: string,
    incoming: T[],
    key: (record: T) => string,
  ): Promise<void> {
    const existing = lines<T>(await this.readText(keyName));
    const byKey = new Map(existing.map((record) => [key(record), record]));
    let changed = false;
    for (const record of incoming) {
      const prior = byKey.get(key(record));
      if (prior) {
        // Compare as stored: JSON drops undefined fields. Same content => no-op; any difference throws.
        if (storedJson(prior) !== storedJson(record)) throw new Error(`IMMUTABLE_RECORD_CONFLICT:${key(record)}`);
        continue;
      }
      byKey.set(key(record), record);
      changed = true;
    }
    if (!changed) return;
    await this.writeText(keyName, lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]));
  }
}

export function openMarketStore(root: string, env: NodeJS.ProcessEnv = process.env): MarketStore {
  if (!env.PEACESTOCKS_R2_BUCKET) return new MarketStorage(root);
  return new ObjectMarketStorage(R2ObjectClient.fromEnv(env));
}
