import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSafeStoreDirectory,
  assertSafeStoreFile,
  prepareSafeStoreDirectory,
  prepareSafeStoreFile,
} from "./store-path";
import type {
  CanonicalDailyBar,
  CorporateAction,
  CorrectionRecord,
  PartitionManifest,
  PredictionSet,
  PredictionStatus,
  ScannerRunReport,
  ScannerBelief,
  SecurityMasterRecord,
  StorageReport,
  UniverseMembershipEvidence,
} from "./contracts";
import { stableJson } from "./identity";

export const MARKET_STORAGE_PATH_ERROR = "MARKET_STORAGE_PATH_INVALID";

export interface MarketStore {
  initialize(): Promise<void>;
  loadSecurities(): Promise<SecurityMasterRecord[]>;
  saveSecurities(records: SecurityMasterRecord[]): Promise<void>;
  loadMembership(): Promise<UniverseMembershipEvidence[]>;
  appendMembership(records: UniverseMembershipEvidence[]): Promise<void>;
  loadBars(sessionDate?: string): Promise<CanonicalDailyBar[]>;
  appendBars(records: CanonicalDailyBar[]): Promise<void>;
  appendActions(records: CorporateAction[]): Promise<void>;
  writeBeliefs(records: ScannerBelief[]): Promise<void>;
  writePredictions(records: PredictionSet[]): Promise<void>;
  writePredictionStatus(record: PredictionStatus): Promise<void>;
  loadBeliefs(sessionDate?: string): Promise<ScannerBelief[]>;
  loadPredictions(sessionDate?: string): Promise<PredictionSet[]>;
  loadPredictionStatuses(sessionDate?: string): Promise<PredictionStatus[]>;
  writeDecisions(records: ScannerBelief[]): Promise<void>;
  writePartitionManifest(manifest: PartitionManifest): Promise<void>;
  writeRunReport(report: unknown): Promise<void>;
  loadRunReports(): Promise<ScannerRunReport[]>;
  measureStorage(): Promise<StorageReport>;
  readPermanent(relativePath: string): Promise<Buffer>;
  loadSchedulerState(): Promise<unknown>;
  saveSchedulerState(state: unknown): Promise<void>;
  loadBackfillProgress(): Promise<unknown>;
  saveBackfillProgress(state: unknown): Promise<void>;
}

type StoredRecord =
  | SecurityMasterRecord
  | UniverseMembershipEvidence
  | CanonicalDailyBar
  | CorporateAction
  | CorrectionRecord
  | ScannerBelief
  | PredictionSet
  | PredictionStatus;

async function readJson<T>(path: string): Promise<T | undefined> {
  assertSafeStoreFile(path, MARKET_STORAGE_PATH_ERROR);
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  assertSafeStoreFile(path, MARKET_STORAGE_PATH_ERROR);
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function lineText(records: StoredRecord[]): string {
  return records.map((record) => stableJson(record)).join("\n") + (records.length ? "\n" : "");
}

export class MarketStorage implements MarketStore {
  readonly root: string;
  readonly permanentRoot: string;
  readonly cacheRoot: string;
  readonly transientRoot: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error(MARKET_STORAGE_PATH_ERROR);
    this.root = prepareSafeStoreDirectory(root, MARKET_STORAGE_PATH_ERROR);
    this.permanentRoot = join(this.root, "permanent");
    this.cacheRoot = join(this.root, "cache");
    this.transientRoot = join(this.root, "transient");
  }

  private guardRoot(): void {
    assertSafeStoreDirectory(this.root, MARKET_STORAGE_PATH_ERROR);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    this.guardRoot();
    const target = prepareSafeStoreFile(path, MARKET_STORAGE_PATH_ERROR);
    assertSafeStoreFile(target, MARKET_STORAGE_PATH_ERROR);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    assertSafeStoreFile(temporary, MARKET_STORAGE_PATH_ERROR);
    await writeFile(temporary, content, "utf8");
    try {
      assertSafeStoreFile(temporary, MARKET_STORAGE_PATH_ERROR);
      assertSafeStoreFile(target, MARKET_STORAGE_PATH_ERROR);
      const { rename } = await import("node:fs/promises");
      await rename(temporary, target);
      assertSafeStoreFile(target, MARKET_STORAGE_PATH_ERROR);
    } catch (error) {
      if (error instanceof Error && error.message === MARKET_STORAGE_PATH_ERROR) throw error;
      const { copyFile, unlink } = await import("node:fs/promises");
      try {
        assertSafeStoreFile(temporary, MARKET_STORAGE_PATH_ERROR);
        assertSafeStoreFile(target, MARKET_STORAGE_PATH_ERROR);
        await copyFile(temporary, target);
        assertSafeStoreFile(temporary, MARKET_STORAGE_PATH_ERROR);
        await unlink(temporary).catch(() => undefined);
      } catch (cleanupError) {
        if (cleanupError instanceof Error && cleanupError.message === MARKET_STORAGE_PATH_ERROR)
          throw cleanupError;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async initialize(): Promise<void> {
    this.guardRoot();
    for (const directory of [
      join(this.permanentRoot, "daily-bars"),
      join(this.permanentRoot, "beliefs"),
      join(this.permanentRoot, "predictions"),
      join(this.permanentRoot, "prediction-status"),
      join(this.permanentRoot, "decisions"),
      join(this.permanentRoot, "partitions"),
      join(this.permanentRoot, "intraday-dust"),
      this.cacheRoot,
      this.transientRoot,
    ]) {
      prepareSafeStoreDirectory(directory, MARKET_STORAGE_PATH_ERROR);
    }
  }

  private path(name: string): string {
    this.guardRoot();
    const target = join(this.permanentRoot, name);
    assertSafeStoreFile(target, MARKET_STORAGE_PATH_ERROR);
    return target;
  }

  async loadSecurities(): Promise<SecurityMasterRecord[]> {
    return (await readJson<SecurityMasterRecord[]>(this.path("security-master.json"))) ?? [];
  }

  async saveSecurities(records: SecurityMasterRecord[]): Promise<void> {
    await this.atomicWrite(
      this.path("security-master.json"),
      JSON.stringify(
        records.sort((a, b) => a.securityId.localeCompare(b.securityId)),
        null,
        2,
      ) + "\n",
    );
  }

  async loadMembership(): Promise<UniverseMembershipEvidence[]> {
    return readJsonLines<UniverseMembershipEvidence>(this.path("universe-membership.jsonl"));
  }

  async appendMembership(records: UniverseMembershipEvidence[]): Promise<void> {
    await this.appendUnique(
      "universe-membership.jsonl",
      records,
      (record) => `${record.securityId}|${record.effectiveDate}|${record.included}`,
    );
  }

  async loadBars(sessionDate?: string): Promise<CanonicalDailyBar[]> {
    if (sessionDate)
      return readJsonLines<CanonicalDailyBar>(
        this.path(`daily-bars/${sessionDate.slice(0, 7)}.jsonl`),
      ).then((bars) => bars.filter((bar) => bar.sessionDate === sessionDate));
    return this.readTree("daily-bars", async (file) => readJsonLines<CanonicalDailyBar>(file));
  }

  async appendBars(records: CanonicalDailyBar[]): Promise<void> {
    const existing = await this.loadBars();
    const corrections: CorrectionRecord[] = [];
    for (const record of records) {
      const prior = [...existing, ...records].find(
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
    const byMonth = new Map<string, CanonicalDailyBar[]>();
    for (const record of records)
      byMonth.set(record.sessionDate.slice(0, 7), [
        ...(byMonth.get(record.sessionDate.slice(0, 7)) ?? []),
        record,
      ]);
    for (const [month, monthRecords] of byMonth)
      await this.appendUnique(
        `daily-bars/${month}.jsonl`,
        monthRecords,
        (record) => `${record.securityId}|${record.sessionDate}|${record.revision}`,
      );
    await this.appendCorrections(corrections);
  }

  async appendCorrections(records: CorrectionRecord[]): Promise<void> {
    await this.appendUnique("corrections.jsonl", records, (record) => record.correctionId);
  }

  async appendActions(records: CorporateAction[]): Promise<void> {
    await this.appendUnique("corporate-actions.jsonl", records, (record) => record.actionId);
  }

  async loadBarsForSecurity(
    securityId: string,
    throughDate?: string,
  ): Promise<CanonicalDailyBar[]> {
    return (await this.loadBars())
      .filter(
        (bar) => bar.securityId === securityId && (!throughDate || bar.sessionDate <= throughDate),
      )
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.revision - b.revision);
  }

  async writeBeliefs(records: ScannerBelief[]): Promise<void> {
    if (!records.length) return;
    const sessionDate = records[0]?.sessionDate;
    if (!sessionDate) return;
    await this.writeImmutableJsonLines(
      `beliefs/${sessionDate}.jsonl`,
      records,
      (record) => record.decisionId,
    );
  }

  async writePredictions(records: PredictionSet[]): Promise<void> {
    if (!records.length) return;
    const sessionDate = records[0]?.sessionDate;
    if (!sessionDate) return;
    await this.writeImmutableJsonLines(
      `predictions/${sessionDate}.jsonl`,
      records,
      (record) => record.predictionId,
    );
  }

  async writePredictionStatus(record: PredictionStatus): Promise<void> {
    await this.writeImmutableJsonLines(
      `prediction-status/${record.sessionDate}.jsonl`,
      [record],
      (item) => item.predictionStatusId,
    );
  }

  async loadBeliefs(sessionDate?: string): Promise<ScannerBelief[]> {
    if (sessionDate) return readJsonLines<ScannerBelief>(this.path(`beliefs/${sessionDate}.jsonl`));
    return this.readTree("beliefs", async (file) => readJsonLines<ScannerBelief>(file));
  }

  async loadPredictions(sessionDate?: string): Promise<PredictionSet[]> {
    if (sessionDate) return readJsonLines<PredictionSet>(this.path(`predictions/${sessionDate}.jsonl`));
    return this.readTree("predictions", async (file) => readJsonLines<PredictionSet>(file));
  }

  async loadPredictionStatuses(sessionDate?: string): Promise<PredictionStatus[]> {
    if (sessionDate)
      return readJsonLines<PredictionStatus>(this.path(`prediction-status/${sessionDate}.jsonl`));
    return this.readTree("prediction-status", async (file) =>
      readJsonLines<PredictionStatus>(file),
    );
  }

  async writeDecisions(records: ScannerBelief[]): Promise<void> {
    await this.writeImmutableJsonLines(
      `decisions/${records[0]?.sessionDate ?? "empty"}.jsonl`,
      records,
      (record) => record.decisionId,
    );
  }

  async writePartitionManifest(manifest: PartitionManifest): Promise<void> {
    await this.atomicWrite(
      this.path(`partitions/${manifest.partitionId}.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  async writeRunReport(report: unknown): Promise<void> {
    this.guardRoot();
    await this.atomicWrite(
      join(this.root, "runs", `${(report as { runId: string }).runId}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
  }

  async loadRunReports(): Promise<ScannerRunReport[]> {
    this.guardRoot();
    const root = join(this.root, "runs");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const reports: ScannerRunReport[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const report = await readJson<ScannerRunReport>(join(root, entry.name));
      if (report) reports.push(report);
    }
    return reports.sort((left, right) =>
      left.session.sessionDate.localeCompare(right.session.sessionDate),
    );
  }

  async measureStorage(): Promise<StorageReport> {
    this.guardRoot();
    const categoryBytes: Record<string, number> = { permanent: 0, cache: 0, transient: 0 };
    for (const [category, root] of [
      ["permanent", this.permanentRoot],
      ["cache", this.cacheRoot],
      ["transient", this.transientRoot],
    ] as const)
      categoryBytes[category] = await this.treeBytes(root);
    const today = new Date().toISOString().slice(0, 10);
    const permanentBytesToday = await this.treeBytesOnDate(this.permanentRoot, today);
    const history = await this.loadRecentDailyMeasurements();
    const dailyBytes = [...history, permanentBytesToday].filter((value) => value >= 0);
    const rollingMbPerDay =
      dailyBytes.reduce((sum, value) => sum + value, 0) /
      Math.max(dailyBytes.length, 1) /
      1024 /
      1024;
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

  private async loadRecentDailyMeasurements(): Promise<number[]> {
    this.guardRoot();
    const root = join(this.root, "runs");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const byDay = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const report = await readJson<{
        completedAt?: string;
        storage?: { permanentBytesToday?: number };
      }>(join(root, entry.name));
      const day = report?.completedAt?.slice(0, 10);
      const bytes = report?.storage?.permanentBytesToday;
      if (day && typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0)
        byDay.set(day, bytes);
    }
    return [...byDay.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .slice(-30)
      .map(([, bytes]) => bytes);
  }

  private async treeBytesOnDate(root: string, day: string): Promise<number> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const path = join(root, entry.name);
            if (entry.isDirectory()) return this.treeBytesOnDate(path, day);
            if (!entry.isFile()) return 0;
            const metadata = await stat(path);
            return metadata.mtime.toISOString().slice(0, 10) === day ? metadata.size : 0;
          }),
        )
      ).reduce((sum, value) => sum + value, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
  async verifyPartition(path: string, expectedSha256: string): Promise<boolean> {
    this.guardRoot();
    assertSafeStoreFile(path, MARKET_STORAGE_PATH_ERROR);
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return digest === expectedSha256.toLowerCase();
  }

  private async appendUnique<T extends StoredRecord>(
    name: string,
    incoming: T[],
    key: (record: T) => string,
  ): Promise<void> {
    const path = this.path(name);
    const existing = await readJsonLines<T>(path);
    const byKey = new Map(existing.map((record) => [key(record), record]));
    for (const record of incoming) if (!byKey.has(key(record))) byKey.set(key(record), record);
    await this.atomicWrite(
      path,
      lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]),
    );
  }

  private async writeImmutableJsonLines<T extends StoredRecord>(
    name: string,
    incoming: T[],
    key: (record: T) => string,
  ): Promise<void> {
    const path = this.path(name);
    const existing = await readJsonLines<T>(path);
    const byKey = new Map(existing.map((record) => [key(record), record]));
    for (const record of incoming) {
      const prior = byKey.get(key(record));
      if (prior && stableJson(prior) !== stableJson(record))
        throw new Error(`IMMUTABLE_RECORD_CONFLICT:${key(record)}`);
      byKey.set(key(record), record);
    }
    await this.atomicWrite(
      path,
      lineText([...byKey.values()].sort((a, b) => key(a).localeCompare(key(b))) as StoredRecord[]),
    );
  }

  private async readTree<T>(
    relativeRoot: string,
    reader: (file: string) => Promise<T[]>,
  ): Promise<T[]> {
    this.guardRoot();
    const root = join(this.permanentRoot, relativeRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = await Promise.all(
      entries.filter((entry) => entry.isFile()).map((entry) => reader(join(root, entry.name))),
    );
    return files.flat();
  }

  private async treeBytes(root: string): Promise<number> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const path = join(root, entry.name);
            return entry.isDirectory() ? this.treeBytes(path) : (await stat(path)).size;
          }),
        )
      ).reduce((sum, value) => sum + value, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async readPermanent(relativePath: string): Promise<Buffer> {
    try {
      return await readFile(this.path(relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.from("");
      throw error;
    }
  }

  async loadSchedulerState(): Promise<unknown> {
    return readJson(join(this.root, "scheduler-host-state.json"));
  }

  async saveSchedulerState(state: unknown): Promise<void> {
    await this.atomicWrite(
      join(this.root, "scheduler-host-state.json"),
      JSON.stringify(state, null, 2) + "\n",
    );
  }

  async loadBackfillProgress(): Promise<unknown> {
    return readJson(join(this.root, "backfill-state.json"));
  }

  async saveBackfillProgress(state: unknown): Promise<void> {
    await this.atomicWrite(
      join(this.root, "backfill-state.json"),
      JSON.stringify(state, null, 2) + "\n",
    );
  }

}
