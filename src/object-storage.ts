import { createHash } from "node:crypto";
import type {
  CanonicalDailyBar,
  CorporateAction,
  CorrectionRecord,
  PartitionManifest,
  PredictionSet,
  PredictionStatus,
  ScannerBelief,
  ScannerRunReport,
  SecurityMasterRecord,
  StorageReport,
  UniverseMembershipEvidence,
} from "./contracts";
import { type DailyBarSessionIndex, indexDailyBarSessions, requireMonth } from "./daily-bar-sessions";
import { stableJson } from "./identity";
import type { ObjectClient } from "./object-store";
import { R2ObjectClient } from "./object-store";
import { MarketStorage, type MarketStore } from "./storage";

type StoredRecord =
  | SecurityMasterRecord
  | UniverseMembershipEvidence
  | CanonicalDailyBar
  | CorporateAction
  | CorrectionRecord
  | ScannerBelief
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

  async loadDailyBarSessions(month: string): Promise<DailyBarSessionIndex> {
    requireMonth(month);
    const body = await this.client.get(`permanent/daily-bars/${month}.jsonl`);
    return body ? indexDailyBarSessions(body, new Map(), month) : new Map();
  }

  async appendBars(records: CanonicalDailyBar[]): Promise<void> {
    const byMonth = new Map<string, CanonicalDailyBar[]>();
    for (const record of records)
      byMonth.set(record.sessionDate.slice(0, 7), [
        ...(byMonth.get(record.sessionDate.slice(0, 7)) ?? []),
        record,
      ]);
    const corrections: CorrectionRecord[] = [];
    for (const [month, monthRecords] of byMonth) {
      const existing = lines<CanonicalDailyBar>(
        await this.readText(`permanent/daily-bars/${month}.jsonl`),
      );
      for (const record of monthRecords) {
        const prior = [...existing, ...monthRecords].find(
          (item) =>
            item.securityId === record.securityId &&
            item.sessionDate === record.sessionDate &&
            item.revision === record.revision - 1,
        );
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
      await this.appendUnique(
        `permanent/daily-bars/${month}.jsonl`,
        monthRecords,
        (record) => `${record.securityId}|${record.sessionDate}|${record.revision}`,
      );
    }
    await this.appendCorrections(corrections);
  }

  async appendCorrections(records: CorrectionRecord[]): Promise<void> {
    await this.appendUnique("permanent/corrections.jsonl", records, (record) => record.correctionId);
  }

  async appendActions(records: CorporateAction[]): Promise<void> {
    await this.appendUnique("permanent/corporate-actions.jsonl", records, (record) => record.actionId);
  }

  async writeBeliefs(records: ScannerBelief[]): Promise<void> {
    const sessionDate = records[0]?.sessionDate;
    if (!sessionDate) return;
    await this.writeImmutable(`permanent/beliefs/${sessionDate}.jsonl`, records, (record) => record.decisionId);
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

  async loadBeliefs(sessionDate?: string): Promise<ScannerBelief[]> {
    return sessionDate
      ? this.readJsonl(`permanent/beliefs/${sessionDate}.jsonl`, true)
      : this.readJsonl("permanent/beliefs/", false);
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

  async writeDecisions(records: ScannerBelief[]): Promise<void> {
    await this.writeImmutable(
      `permanent/decisions/${records[0]?.sessionDate ?? "empty"}.jsonl`,
      records,
      (record) => record.decisionId,
    );
  }

  async writePartitionManifest(manifest: PartitionManifest): Promise<void> {
    await this.writeText(
      `permanent/partitions/${manifest.partitionId}.json`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  async writeRunReport(report: unknown): Promise<void> {
    const runId = (report as { runId?: string }).runId;
    if (!runId) throw new Error("RUN_ID_REQUIRED");
    await this.writeText(`runs/${runId}.json`, JSON.stringify(report, null, 2) + "\n");
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

  async measureStorage(): Promise<StorageReport> {
    const keys = await this.client.list("");
    const categoryBytes: Record<string, number> = { permanent: 0, cache: 0, transient: 0 };
    for (const key of keys) {
      const size = (await this.client.get(key))?.byteLength ?? 0;
      if (key.startsWith("permanent/")) categoryBytes.permanent = (categoryBytes.permanent ?? 0) + size;
      else if (key.startsWith("cache/")) categoryBytes.cache = (categoryBytes.cache ?? 0) + size;
      else if (key.startsWith("transient/")) categoryBytes.transient = (categoryBytes.transient ?? 0) + size;
    }
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

  async tallyBarCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const key of await this.client.list("permanent/daily-bars/")) {
      const body = await this.readText(key);
      for (const line of body.split("\n")) {
        if (!line) continue;
        const securityId = /"securityId":"([^"]+)"/u.exec(line)?.[1];
        if (securityId) counts.set(securityId, (counts.get(securityId) ?? 0) + 1);
      }
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
    const existing = lines<T>(await this.readText(keyName));
    const byKey = new Map(existing.map((record) => [key(record), record]));
    for (const record of incoming) if (!byKey.has(key(record))) byKey.set(key(record), record);
    await this.writeText(keyName, lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]));
  }

  private async writeImmutable<T extends StoredRecord>(
    keyName: string,
    incoming: T[],
    key: (record: T) => string,
  ): Promise<void> {
    const existing = lines<T>(await this.readText(keyName));
    const byKey = new Map(existing.map((record) => [key(record), record]));
    for (const record of incoming) {
      const prior = byKey.get(key(record));
      if (prior && stableJson(prior) !== stableJson(record))
        throw new Error(`IMMUTABLE_RECORD_CONFLICT:${key(record)}`);
      byKey.set(key(record), record);
    }
    await this.writeText(keyName, lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]));
  }
}

export function openMarketStore(root: string, env: NodeJS.ProcessEnv = process.env): MarketStore {
  if (!env.PEACESTOCKS_R2_BUCKET) return new MarketStorage(root);
  return new ObjectMarketStorage(R2ObjectClient.fromEnv(env));
}
