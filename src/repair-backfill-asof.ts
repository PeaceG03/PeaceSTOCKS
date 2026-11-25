import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { etCalendarDate } from "./et-time";
import { securityId, stableJson } from "./identity";
import { R2ObjectClient, type ObjectClient } from "./object-store";
import {
  loadTickerReferenceIndexFromManifest,
  parseTickerReferenceManifest,
  signTickerReferenceManifest,
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceEntry,
  type TickerReferenceIndexManifest,
} from "./ticker-reference-index";
import type { SecurityMasterRecord, UniverseMembershipEvidence } from "./contracts";
type SymbolHistoryEntry = SecurityMasterRecord["historicalSymbols"][number];

const SECURITY_MASTER_KEY = "permanent/security-master.json";
const UNIVERSE_MEMBERSHIP_KEY = "permanent/universe-membership.jsonl";
const REOPEN_STATE_KEY = "backfill-reopen-state.json";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export interface RepairBackfillAsOfOptions {
  badDate?: string;
  targetDate?: string;
  baselineMasterPath?: string;
  apply?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RepairBackfillAsOfSummary {
  mode: "dry-run" | "apply";
  badDate: string;
  targetDate: string;
  evidence: {
    reopenStateEtDate: string | null;
    morningIndexAsOf: string | null;
    liveIndexAsOf: string | null;
    baselineMasterLoaded: boolean;
  };
  securityMaster: {
    total: number;
    repairedFirstSeen: number;
    repairedInactiveAt: number;
    repairedHistoricalSymbols: number;
    repairedLastUniverseSeenAt: number;
    touchedRecords: number;
    unverified: number;
    wrote: boolean;
  };
  universeMembership: {
    totalLines: number;
    repairedRows: number;
    deduplicatedRows: number;
    unverified: number;
    wrote: boolean;
  };
  tickerReferenceIndex: {
    action: "none" | "restore-previous-to-live" | "relink-previous-past-bad";
    deletedKeysCount: number;
    unverified: boolean;
    wrote: boolean;
  };
}

interface VersionedObject {
  body: Uint8Array;
  etag?: string;
  sha256: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readVersioned(store: ObjectClient, key: string): Promise<VersionedObject | undefined> {
  if (store.getWithEtag) {
    const res = await store.getWithEtag(key);
    if (!res) return undefined;
    return { body: res.body, etag: res.etag, sha256: sha256Hex(res.body) };
  }
  const body = await store.get(key);
  if (!body) return undefined;
  return { body, sha256: sha256Hex(body) };
}

async function writeWithEtag(store: ObjectClient, key: string, body: Uint8Array, prior: VersionedObject): Promise<void> {
  if (store.putIfMatch && prior.etag !== undefined) {
    const ok = await store.putIfMatch(key, body, prior.etag);
    if (!ok) throw new Error(`REPAIR_ETAG_DRIFT:${key}`);
    return;
  }
  const current = await store.get(key);
  if (!current || sha256Hex(current) !== prior.sha256) {
    throw new Error(`REPAIR_ETAG_DRIFT:${key}`);
  }
  await store.put(key, body);
}

interface EntryLookup {
  bySecId: Map<string, TickerReferenceEntry>;
  byShareClassFigi: Map<string, TickerReferenceEntry>;
  byCompositeFigi: Map<string, TickerReferenceEntry>;
  byTicker: Map<string, TickerReferenceEntry>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildEntryLookup(entries: TickerReferenceEntry[]): EntryLookup {
  const bySecId = new Map<string, TickerReferenceEntry>();
  const byShareClassFigi = new Map<string, TickerReferenceEntry>();
  const byCompositeFigi = new Map<string, TickerReferenceEntry>();
  const byTicker = new Map<string, TickerReferenceEntry>();

  for (const entry of entries) {
    let rawMarket: string | undefined;
    let rawLocale: string | undefined;
    let rawType = nonEmpty(entry.type)?.toUpperCase();
    if (entry.raw) {
      try {
        const raw = JSON.parse(entry.raw) as Record<string, unknown>;
        rawMarket = nonEmpty(raw.market)?.toLowerCase();
        rawLocale = nonEmpty(raw.locale)?.toLowerCase();
        if (!rawType) rawType = nonEmpty(raw.type)?.toUpperCase();
      } catch {
        // Ignore malformed raw in synthetic fixtures; fall back to parsed entry fields.
      }
    }

    const scFigi = nonEmpty(entry.share_class_figi);
    const compFigi = nonEmpty(entry.composite_figi);
    const ticker = nonEmpty(entry.ticker);
    const pid = scFigi ?? compFigi ?? ticker;
    const isUsStockOrEtf =
      (!rawType || rawType === "CS" || rawType === "ETF") &&
      (!rawMarket || rawMarket === "stocks") &&
      (!rawLocale || rawLocale === "us");

    if (pid && isUsStockOrEtf) {
      const assetType = rawType === "ETF" ? "ETF" : "STOCK";
      const sid = securityId("massive-stocks", pid, assetType);
      if (!bySecId.has(sid)) bySecId.set(sid, entry);
    }
    if (isUsStockOrEtf) {
      if (scFigi && !byShareClassFigi.has(scFigi)) byShareClassFigi.set(scFigi, entry);
      if (!scFigi && compFigi && !byCompositeFigi.has(compFigi)) byCompositeFigi.set(compFigi, entry);
      if (!scFigi && !compFigi && ticker && !byTicker.has(ticker)) byTicker.set(ticker, entry);
    }
  }
  return { bySecId, byShareClassFigi, byCompositeFigi, byTicker };
}

function lookupIndexEntry(record: SecurityMasterRecord, lookup: EntryLookup | undefined): TickerReferenceEntry | undefined {
  if (!lookup) return undefined;
  const byId = lookup.bySecId.get(record.securityId);
  if (byId) return byId;

  for (const identity of record.providerIdentities ?? []) {
    if (identity.provider !== "massive-stocks" && identity.provider !== "massive") continue;
    const pid = identity.providerSecurityId;
    if (!pid) continue;
    const matched =
      lookup.byShareClassFigi.get(pid) ??
      lookup.byCompositeFigi.get(pid) ??
      lookup.byTicker.get(pid);
    if (matched) return matched;
  }

  if (record.securityId.startsWith("figi:")) {
    const figi = record.securityId.slice(5);
    return lookup.byShareClassFigi.get(figi) ?? lookup.byCompositeFigi.get(figi);
  }
  return undefined;
}

function membershipRowKey(row: Pick<UniverseMembershipEvidence, "securityId" | "effectiveDate" | "included">): string {
  return `${row.securityId}|${row.effectiveDate}|${row.included}`;
}

function deriveTargetDate(candidates: Array<[string, string | undefined]>, badDate: string): string {
  const present = candidates.filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0);
  if (present.length === 0) throw new Error("REPAIR_TARGET_DATE_EVIDENCE_MISSING");
  for (const [source, date] of present) {
    if (!ISO_DATE_RE.test(date)) throw new Error(`REPAIR_TARGET_DATE_INVALID:${source}:${date}`);
    if (date === badDate) throw new Error(`REPAIR_TARGET_DATE_EQUALS_BAD_DATE:${source}:${date}`);
  }
  const first = present[0]!;
  for (const [source, date] of present.slice(1)) {
    if (date !== first[1]) throw new Error(`REPAIR_TARGET_DATE_CONFLICT:${first[0]}=${first[1]}:${source}=${date}`);
  }
  return first[1];
}

export function formatRepairSummary(summary: RepairBackfillAsOfSummary): string {
  return JSON.stringify(summary);
}

export async function repairBackfillAsOf(
  store: ObjectClient,
  options: RepairBackfillAsOfOptions = {},
): Promise<RepairBackfillAsOfSummary> {
  const badDate = options.badDate ?? "2025-05-13";
  if (!ISO_DATE_RE.test(badDate)) throw new Error(`REPAIR_BAD_DATE_INVALID:${badDate}`);
  const apply = options.apply === true;
  const env = options.env ?? process.env;
  if (apply && env.GITHUB_ACTIONS === "true" && env.GITHUB_REF !== "refs/heads/main") {
    throw new Error(`REPAIR_REFUSE_NON_MAIN:${env.GITHUB_REF ?? "unknown"}`);
  }

  // 1. Load reopen checkpoint evidence (optional)
  let reopenStateEtDate: string | undefined;
  const reopenBytes = await store.get(REOPEN_STATE_KEY);
  if (reopenBytes) {
    const parsed = JSON.parse(new TextDecoder().decode(reopenBytes)) as { updatedAt?: unknown };
    if (typeof parsed.updatedAt === "string") {
      const d = new Date(parsed.updatedAt);
      if (!Number.isNaN(d.getTime())) reopenStateEtDate = etCalendarDate(d);
    }
  }

  // 2. Load ticker-reference-index manifest chain
  const liveManifestVersioned = await readVersioned(store, TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  let liveManifest: TickerReferenceIndexManifest | undefined;
  let badManifest: TickerReferenceIndexManifest | undefined;
  let badManifestDepth = -1;
  let badManifestArchiveKey: string | undefined;
  let morningManifest: TickerReferenceIndexManifest | undefined;
  let morningArchiveKey: string | undefined;
  let morningArchiveBytes: Uint8Array | undefined;
  let indexChainUnverified = false;

  if (liveManifestVersioned) {
    liveManifest = parseTickerReferenceManifest(liveManifestVersioned.body);
    if (liveManifest.asOf === badDate) {
      badManifest = liveManifest;
      badManifestDepth = 0;
    } else if (liveManifest.previousManifest?.verified) {
      const prevKey = liveManifest.previousManifest.key;
      const prevBytes = await store.get(prevKey);
      if (prevBytes) {
        const prevManifest = parseTickerReferenceManifest(prevBytes);
        if (prevManifest.asOf === badDate) {
          badManifest = prevManifest;
          badManifestDepth = 1;
          badManifestArchiveKey = prevKey;
        }
      }
    }

    if (badManifest?.previousManifest) {
      if (!badManifest.previousManifest.verified) {
        indexChainUnverified = true;
      } else {
        const mKey = badManifest.previousManifest.key;
        const mBytes = await store.get(mKey);
        if (!mBytes || sha256Hex(mBytes) !== badManifest.previousManifest.sha256) {
          indexChainUnverified = true;
        } else {
          const parsedMorning = parseTickerReferenceManifest(mBytes);
          if (parsedMorning.asOf === badDate) {
            indexChainUnverified = true;
          } else {
            morningManifest = parsedMorning;
            morningArchiveKey = mKey;
            morningArchiveBytes = mBytes;
          }
        }
      }
    }
  }

  const hasCandidateDate = Boolean(reopenStateEtDate || morningManifest?.asOf || options.targetDate);
  let targetDate = hasCandidateDate
    ? deriveTargetDate(
        [
          ["backfill-reopen-state", reopenStateEtDate],
          ["morning-index", morningManifest?.asOf],
          ["cli-target-date", options.targetDate],
        ],
        badDate,
      )
    : "";

  // 3. Load index entry snapshots + optional local baseline master
  const badEntries = badManifest ? (await loadTickerReferenceIndexFromManifest(store, badManifest)).entries : undefined;
  const morningEntries = morningManifest
    ? (await loadTickerReferenceIndexFromManifest(store, morningManifest)).entries
    : undefined;
  const badLookup = badEntries ? buildEntryLookup(badEntries) : undefined;
  const morningLookup = morningEntries ? buildEntryLookup(morningEntries) : undefined;

  const baselineById = new Map<string, SecurityMasterRecord>();
  let baselineMasterLoaded = false;
  if (options.baselineMasterPath) {
    const raw = JSON.parse(readFileSync(options.baselineMasterPath, "utf8")) as SecurityMasterRecord[];
    for (const rec of raw) baselineById.set(rec.securityId, rec);
    baselineMasterLoaded = true;
  }

  // 4. Load security-master.json and universe-membership.jsonl with ETags
  const masterVersioned = await readVersioned(store, SECURITY_MASTER_KEY);
  if (!masterVersioned) throw new Error(`REPAIR_MISSING_OBJECT:${SECURITY_MASTER_KEY}`);
  const securities = JSON.parse(new TextDecoder().decode(masterVersioned.body)) as SecurityMasterRecord[];

  const membershipVersioned = await readVersioned(store, UNIVERSE_MEMBERSHIP_KEY);
  if (!membershipVersioned) throw new Error(`REPAIR_MISSING_OBJECT:${UNIVERSE_MEMBERSHIP_KEY}`);
  const membershipText = new TextDecoder("utf-8", { fatal: true }).decode(membershipVersioned.body);
  const membershipLines = membershipText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((raw) => ({ raw, parsed: JSON.parse(raw) as UniverseMembershipEvidence }));

  if (!targetDate) {
    const anyMasterBad = securities.some(
      (r) =>
        r.firstSeenAt === badDate ||
        r.inactiveAt === badDate ||
        r.lastUniverseSeenAt === badDate ||
        r.historicalSymbols.some((h) => h.effectiveFrom === badDate || h.effectiveTo === badDate),
    );
    const anyMembershipBad = membershipLines.some((m) => m.parsed.effectiveDate === badDate);
    if (!anyMasterBad && !anyMembershipBad && !badManifest) {
      targetDate = liveManifest?.asOf && liveManifest.asOf !== badDate ? liveManifest.asOf : "none";
    } else {
      throw new Error("REPAIR_TARGET_DATE_EVIDENCE_MISSING");
    }
  }

  const membershipBySecId = new Map<string, UniverseMembershipEvidence[]>();
  for (const item of membershipLines) {
    let list = membershipBySecId.get(item.parsed.securityId);
    if (!list) {
      list = [];
      membershipBySecId.set(item.parsed.securityId, list);
    }
    list.push(item.parsed);
  }

  // 5. Surgically verify & repair security-master.json
  let repairedFirstSeen = 0;
  let repairedInactiveAt = 0;
  let repairedHistoricalSymbols = 0;
  let repairedLastUniverseSeenAt = 0;
  let touchedRecords = 0;
  let masterUnverified = 0;

  const verifiedNewIds = new Set<string>();
  const verifiedInactiveIds = new Set<string>();
  const verifiedRenameIds = new Set<string>();

  const nextSecurities = securities.map((record) => {
    const morningEntry = lookupIndexEntry(record, morningLookup);
    const badEntry = lookupIndexEntry(record, badLookup);
    const baselineRec = baselineMasterLoaded ? baselineById.get(record.securityId) : undefined;
    const secMembership = membershipBySecId.get(record.securityId) ?? [];

    const hasBadNewMembership = secMembership.some((m) => m.effectiveDate === badDate && m.included === true);
    const hasUniverseDiffInactMembership = secMembership.some(
      (m) => m.effectiveDate === badDate && m.included === false && m.provider === "universe-diff",
    );

    let next = record;
    let touched = false;
    let recordHasUnverified = false;
    const cloneIfNeeded = (): SecurityMasterRecord => {
      if (next === record) {
        next = {
          ...record,
          historicalSymbols: record.historicalSymbols.map((h) => ({ ...h })),
        };
      }
      return next;
    };

    // 5a. Added records (firstSeenAt === badDate)
    let handledNewHist = false;
    if (record.firstSeenAt === badDate) {
      const absentBefore =
        (morningLookup !== undefined && morningEntry === undefined) ||
        (baselineMasterLoaded && baselineRec === undefined);
      const seenDuringBadRun = badEntry !== undefined;
      if (absentBefore && seenDuringBadRun && hasBadNewMembership) {
        const draft = cloneIfNeeded();
        draft.firstSeenAt = targetDate;
        repairedFirstSeen += 1;
        touched = true;
        verifiedNewIds.add(record.securityId);
        let repairedHistForNew = false;
        draft.historicalSymbols = draft.historicalSymbols.map((h) => {
          if (h.effectiveFrom === badDate) {
            repairedHistForNew = true;
            return { ...h, effectiveFrom: targetDate };
          }
          return h;
        });
        if (repairedHistForNew) {
          repairedHistoricalSymbols += 1;
          handledNewHist = true;
        }
      } else {
        recordHasUnverified = true;
      }
    }

    // 5b. ACTIVE -> INACTIVE transitions (inactiveAt === badDate, including out-of-scope lacking delistedAt)
    if (record.inactiveAt === badDate) {
      const wasActiveBefore = morningEntry?.active === true || baselineRec?.status === "ACTIVE";
      const inactiveInBadCapture = badEntry?.active === false;
      const outOfScopeUniverseDiff = badEntry === undefined && hasUniverseDiffInactMembership;
      if (wasActiveBefore && (inactiveInBadCapture || outOfScopeUniverseDiff)) {
        const draft = cloneIfNeeded();
        draft.inactiveAt = targetDate;
        repairedInactiveAt += 1;
        touched = true;
        verifiedInactiveIds.add(record.securityId);
      } else {
        recordHasUnverified = true;
      }
    }

    // 5c. Symbol rename (historicalSymbols effectiveTo/effectiveFrom === badDate on pre-existing security)
    if (!handledNewHist) {
      const hasBadHist = record.historicalSymbols.some(
        (h) => h.effectiveFrom === badDate || h.effectiveTo === badDate,
      );
      if (hasBadHist) {
        const prevEntry = record.historicalSymbols.find((h) => h.effectiveTo === badDate);
        const currEntry = record.historicalSymbols.find((h) => h.effectiveFrom === badDate);
        const priorSymbolMatches =
          prevEntry !== undefined &&
          ((morningEntry !== undefined && morningEntry.ticker === prevEntry.symbol) ||
            (baselineRec !== undefined && baselineRec.currentSymbol === prevEntry.symbol));
        const nextSymbolMatches =
          currEntry !== undefined &&
          ((badEntry !== undefined && badEntry.ticker === currEntry.symbol) ||
            (record.lastUniverseSeenAt ?? "") >= targetDate);
        if (record.firstSeenAt !== badDate && priorSymbolMatches && nextSymbolMatches) {
          const draft = cloneIfNeeded();
          draft.historicalSymbols = draft.historicalSymbols.map((h): SymbolHistoryEntry => {
            const updated: SymbolHistoryEntry = { ...h };
            if (updated.effectiveTo === badDate) updated.effectiveTo = targetDate;
            if (updated.effectiveFrom === badDate) updated.effectiveFrom = targetDate;
            return updated;
          });
          repairedHistoricalSymbols += 1;
          touched = true;
          verifiedRenameIds.add(record.securityId);
        } else if (record.firstSeenAt !== badDate) {
          recordHasUnverified = true;
        }
      }
    }

    // 5d. lastUniverseSeenAt rollbacks (only if still equal to badDate)
    if (record.lastUniverseSeenAt === badDate) {
      if (baselineRec?.lastUniverseSeenAt && baselineRec.lastUniverseSeenAt > badDate) {
        const draft = cloneIfNeeded();
        draft.lastUniverseSeenAt = baselineRec.lastUniverseSeenAt;
        repairedLastUniverseSeenAt += 1;
        touched = true;
      } else if (badEntry !== undefined) {
        const draft = cloneIfNeeded();
        draft.lastUniverseSeenAt = targetDate;
        repairedLastUniverseSeenAt += 1;
        touched = true;
      } else {
        recordHasUnverified = true;
      }
    }

    if (touched) touchedRecords += 1;
    if (recordHasUnverified) masterUnverified += 1;
    return next;
  });

  // 6. Surgically verify & repair universe-membership.jsonl (line-preserving)
  const existingTargetKeys = new Set<string>();
  for (const item of membershipLines) {
    if (item.parsed.effectiveDate !== badDate) {
      existingTargetKeys.add(membershipRowKey(item.parsed));
    }
  }

  let repairedRows = 0;
  let deduplicatedRows = 0;
  let membershipUnverified = 0;
  const masterById = new Map(nextSecurities.map((r) => [r.securityId, r]));

  const nextMembershipLines: Array<{ raw: string; parsed: UniverseMembershipEvidence }> = [];
  for (const item of membershipLines) {
    if (item.parsed.effectiveDate !== badDate) {
      nextMembershipLines.push(item);
      continue;
    }

    const row = item.parsed;
    const sec = masterById.get(row.securityId);
    const verified =
      sec !== undefined &&
      ((row.included === true &&
        row.reason === "NEW" &&
        (verifiedNewIds.has(row.securityId) || sec.firstSeenAt === targetDate)) ||
        (row.included === false &&
          (verifiedInactiveIds.has(row.securityId) || sec.inactiveAt === targetDate)) ||
        (row.reason === "CONTINUED" && verifiedRenameIds.has(row.securityId)));

    if (!verified) {
      membershipUnverified += 1;
      nextMembershipLines.push(item);
      continue;
    }

    const repairedRow: UniverseMembershipEvidence = {
      ...row,
      effectiveDate: targetDate,
      observedAt: row.observedAt === badDate ? targetDate : row.observedAt,
    };
    const nextKey = membershipRowKey(repairedRow);
    if (existingTargetKeys.has(nextKey)) {
      deduplicatedRows += 1;
      continue;
    }
    existingTargetKeys.add(nextKey);
    repairedRows += 1;
    nextMembershipLines.push({ raw: stableJson(repairedRow), parsed: repairedRow });
  }

  // 7. Plan ticker-reference-index manifest chain repair
  let indexAction: RepairBackfillAsOfSummary["tickerReferenceIndex"]["action"] = "none";
  const keysToDelete: string[] = [];
  let nextManifestBytes: Uint8Array | undefined;

  if (badManifest && !indexChainUnverified) {
    if (badManifestDepth === 0) {
      if (morningArchiveBytes && morningManifest) {
        indexAction = "restore-previous-to-live";
        nextManifestBytes = morningArchiveBytes;
        // Keep bad index base object as forensic evidence; relink manifest only.
      } else {
        indexChainUnverified = true;
      }
    } else if (badManifestDepth === 1 && liveManifest && badManifestArchiveKey) {
      const { checksum: _oldChecksum, ...rest } = liveManifest;
      const relinked = signTickerReferenceManifest({
        ...rest,
        previousManifest: badManifest.previousManifest ?? null,
      });
      indexAction = "relink-previous-past-bad";
      nextManifestBytes = new TextEncoder().encode(JSON.stringify(relinked, null, 2) + "\n");
      // Keep bad index objects as forensic evidence; relink manifest only.
    } else {
      indexChainUnverified = true;
    }
  }

  // 8. Execute writes if --apply
  let wroteMaster = false;
  let wroteMembership = false;
  let wroteIndex = false;

  if (apply) {
    if (touchedRecords > 0) {
      const sortedMaster = [...nextSecurities].sort((a, b) => a.securityId.localeCompare(b.securityId));
      const masterBytes = new TextEncoder().encode(JSON.stringify(sortedMaster, null, 2) + "\n");
      await writeWithEtag(store, SECURITY_MASTER_KEY, masterBytes, masterVersioned);
      wroteMaster = true;
    }

    if (repairedRows > 0 || deduplicatedRows > 0) {
      nextMembershipLines.sort((a, b) => membershipRowKey(a.parsed).localeCompare(membershipRowKey(b.parsed)));
      const membershipOut = new TextEncoder().encode(nextMembershipLines.map((l) => l.raw).join("\n") + "\n");
      await writeWithEtag(store, UNIVERSE_MEMBERSHIP_KEY, membershipOut, membershipVersioned);
      wroteMembership = true;
    }

    if (indexAction !== "none" && nextManifestBytes && liveManifestVersioned) {
      await writeWithEtag(store, TICKER_REFERENCE_INDEX_MANIFEST_KEY, nextManifestBytes, liveManifestVersioned);
      wroteIndex = true;
      for (const key of keysToDelete) {
        await store.delete(key);
      }
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    badDate,
    targetDate,
    evidence: {
      reopenStateEtDate: reopenStateEtDate ?? null,
      morningIndexAsOf: morningManifest?.asOf ?? null,
      liveIndexAsOf: liveManifest?.asOf ?? null,
      baselineMasterLoaded,
    },
    securityMaster: {
      total: securities.length,
      repairedFirstSeen,
      repairedInactiveAt,
      repairedHistoricalSymbols,
      repairedLastUniverseSeenAt,
      touchedRecords,
      unverified: masterUnverified,
      wrote: wroteMaster,
    },
    universeMembership: {
      totalLines: membershipLines.length,
      repairedRows,
      deduplicatedRows,
      unverified: membershipUnverified,
      wrote: wroteMembership,
    },
    tickerReferenceIndex: {
      action: indexAction,
      deletedKeysCount: keysToDelete.length,
      unverified: indexChainUnverified,
      wrote: wroteIndex,
    },
  };
}

export function parseCliArgs(argv: string[]): RepairBackfillAsOfOptions {
  const options: RepairBackfillAsOfOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      continue;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--bad-date") {
      const value = argv[++i];
      if (!value) throw new Error("REPAIR_ARG_MISSING:--bad-date");
      options.badDate = value;
    } else if (arg === "--target-date") {
      const value = argv[++i];
      if (!value) throw new Error("REPAIR_ARG_MISSING:--target-date");
      options.targetDate = value;
    } else if (arg === "--baseline-master") {
      const value = argv[++i];
      if (!value) throw new Error("REPAIR_ARG_MISSING:--baseline-master");
      options.baselineMasterPath = value;
    } else {
      throw new Error(`REPAIR_UNKNOWN_ARG:${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const store = R2ObjectClient.fromEnv();
  // parseCliArgs never sets env from argv or config; production always falls back to process.env.
  const summary = await repairBackfillAsOf(store, options);
  console.log(formatRepairSummary(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
