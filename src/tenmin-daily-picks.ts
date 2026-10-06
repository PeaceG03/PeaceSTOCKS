/**
 * Daily 10-minute picks — rule pick-v1 (pure; no I/O).
 *
 * Two immutable documents (later picks.json / picks-top50.json):
 *   - buildPicksBaseV1: index + holdings + random 5% from D's first grouped copy
 *     (all linked, type-filtered candidates; does not depend on the scan).
 *   - buildPicksTop50V1: top50 from frozen predictions + beliefs for D.
 * mergeDailyTenMinPicksV1 unions them into the per-day fetch list (dedupe by
 * securityId, primary reason by priority, alsoReasons for the rest).
 *
 * Frozen scan source (immutable in production):
 *   permanent/predictions/<D>.jsonl  — PredictionSet TOP_50_OVERALL (ordered ids)
 *   permanent/beliefs/<D>.jsonl      — ScannerBelief (familyScores, overallRank)
 */

import type { PredictionSet, ScannerBelief } from "./contracts";
import { dailyReplyDustFileKey } from "./daily-reply-dust";
import { sha256, stableJson } from "./identity";

export const PICK_V1_RULE_VERSION = "pick-v1" as const;

/** Documented seed: sha256("pick-v1|" + sessionDate + "|" + securityId) as hex. */
export const PICK_V1_SEED_FORMULA =
  'sha256("pick-v1|" + sessionDate + "|" + securityId) as hex' as const;

/**
 * Copied from the master's Massive type gate (CS/ETF only). Own constant list so pick-v1
 * does not import from tenmin-union (union may still be on hold / change). Sorted for hashing.
 */
export const PICK_V1_TYPE_FILTER_VERSION = "pick-v1-types-1" as const;
export const PICK_V1_ALLOWED_TYPES = ["CS", "ETF"] as const;
export type PickV1AllowedType = (typeof PICK_V1_ALLOWED_TYPES)[number];

const ALLOWED_TYPE_SET = new Set<string>(PICK_V1_ALLOWED_TYPES);

export type PickV1Reason = "holding" | "index" | "top50" | "random";

/** Priority: holding > index > top50 > random (lower index = higher priority). */
const REASON_PRIORITY: Record<PickV1Reason, number> = {
  holding: 0,
  index: 1,
  top50: 2,
  random: 3,
};

export function pickV1PredictionsKey(sessionDate: string): string {
  return `permanent/predictions/${sessionDate}.jsonl`;
}

export function pickV1BeliefsKey(sessionDate: string): string {
  return `permanent/beliefs/${sessionDate}.jsonl`;
}

export interface PickV1NamedSecurity {
  securityId: string;
  symbol: string;
}

export interface PickV1GroupedReplyInput {
  /** Must be the first-copy key: permanent/daily-reply-dust/D/grouped-daily.rdust */
  key: string;
  sha256: string;
  sessionDate: string;
  results: readonly { T?: unknown }[];
}

export interface PickV1StoredJsonlInput<T> {
  /** e.g. permanent/predictions/<D>.jsonl */
  key: string;
  /** sha256 of the stored bytes (not of re-serialized records). */
  sha256: string;
  records: readonly T[];
}

export interface PickV1RankInputsTop50 {
  predictionId: string;
  /** 1-based position in TOP_50_OVERALL.securityIds (frozen order). */
  position: number;
  /** From ScannerBelief when present. */
  overallRank: number | null;
  familyScores: Record<string, number>;
}

export interface PickV1RankInputsRandom {
  shaKey: string;
}

export type PickV1RankInputs = PickV1RankInputsTop50 | PickV1RankInputsRandom | null;

export interface PickV1Pick {
  securityId: string;
  symbol: string;
  reason: PickV1Reason;
  alsoReasons?: PickV1Reason[];
  rankInputs: PickV1RankInputs;
}

export interface PicksBaseV1 {
  ruleVersion: typeof PICK_V1_RULE_VERSION;
  sessionDate: string;
  seedFormula: typeof PICK_V1_SEED_FORMULA;
  groupedReply: { key: string; sha256: string };
  typeFilter: { version: typeof PICK_V1_TYPE_FILTER_VERSION; sha256: string };
  mappingSha256: string;
  /** sha256 of the canonical sorted ticker→type map used for filtering. */
  tickerTypesSha256: string;
  candidateCount: number;
  candidateListSha256: string;
  counts: {
    index: number;
    holding: number;
    random: number;
    unlinkedExcluded: number;
    excludedByType: number;
  };
  picks: PickV1Pick[];
}

export interface PicksTop50V1 {
  ruleVersion: typeof PICK_V1_RULE_VERSION;
  sessionDate: string;
  scanSource: {
    predictions: { key: string; sha256: string };
    beliefs: { key: string; sha256: string };
  };
  /** How many ids the TOP_50_OVERALL set listed (may be < 50). */
  top50Count: number;
  counts: { top50: number };
  picks: PickV1Pick[];
}

export class PickV1InputError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
  }
}

export function pickV1RandomShaKey(sessionDate: string, securityId: string): string {
  return sha256(`pick-v1|${sessionDate}|${securityId}`);
}

export function pickV1TypeFilterSha256(
  types: readonly string[] = PICK_V1_ALLOWED_TYPES,
): string {
  return sha256(stableJson([...types].sort()));
}

export function pickV1MappingSha256(
  mapping: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const entries =
    mapping instanceof Map ? [...mapping.entries()] : Object.entries(mapping);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(stableJson(Object.fromEntries(entries)));
}

/** Canonical sorted ticker→type fingerprint (same shape as mappingSha256). */
export function pickV1TickerTypesSha256(
  types: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  return pickV1MappingSha256(types);
}

export function serializePicksBaseV1(doc: PicksBaseV1): string {
  return stableJson(doc);
}

export function serializePicksTop50V1(doc: PicksTop50V1): string {
  return stableJson(doc);
}

export function serializeMergedPicksV1(picks: readonly PickV1Pick[]): string {
  return stableJson(picks);
}

function asMap(
  mapping: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): Map<string, string> {
  return mapping instanceof Map ? new Map(mapping) : new Map(Object.entries(mapping));
}

function requireSessionDate(iso: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso))
    throw new PickV1InputError("PICK_V1_INVALID_SESSION_DATE", `${label}:${iso}`);
}

function preferReason(a: PickV1Reason, b: PickV1Reason): PickV1Reason {
  return REASON_PRIORITY[a] <= REASON_PRIORITY[b] ? a : b;
}

function finalizePick(acc: {
  securityId: string;
  symbol: string;
  reasons: Set<PickV1Reason>;
  top50?: PickV1RankInputsTop50;
  randomShaKey?: string;
}): PickV1Pick {
  const reasons = [...acc.reasons].sort(
    (a, b) => REASON_PRIORITY[a] - REASON_PRIORITY[b] || (a < b ? -1 : a > b ? 1 : 0),
  );
  const reason = reasons.reduce(preferReason);
  const also = reasons.filter((r) => r !== reason);
  let rankInputs: PickV1RankInputs = null;
  if (reason === "top50" && acc.top50) rankInputs = acc.top50;
  else if (reason === "random" && acc.randomShaKey) rankInputs = { shaKey: acc.randomShaKey };
  return {
    securityId: acc.securityId,
    symbol: acc.symbol,
    reason,
    ...(also.length ? { alsoReasons: also } : {}),
    rankInputs,
  };
}

/**
 * Base picks for D: index, holdings, and random 5% of every linked type-filtered
 * candidate in the first grouped copy. Does not read or depend on the scan.
 *
 * Duplicate securityIds across tickers: keep the lexicographically smallest ticker as symbol.
 * Random N = all such candidates (top50/index/holdings are NOT removed from the pool).
 */
export function buildPicksBaseV1(input: {
  sessionDate: string;
  index: readonly PickV1NamedSecurity[];
  holdings: readonly PickV1NamedSecurity[];
  groupedReply: PickV1GroupedReplyInput;
  tickerToSecurityId: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  tickerTypes: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}): PicksBaseV1 {
  const D = input.sessionDate;
  requireSessionDate(D, "sessionDate");
  requireSessionDate(input.groupedReply.sessionDate, "groupedReply");
  if (input.groupedReply.sessionDate !== D)
    throw new PickV1InputError(
      "PICK_V1_GROUPED_SESSION_MISMATCH",
      `${input.groupedReply.sessionDate}!=${D}`,
    );
  if (input.groupedReply.key !== dailyReplyDustFileKey(D))
    throw new PickV1InputError("PICK_V1_GROUPED_NOT_FIRST_COPY", input.groupedReply.key);

  const tickerToSid = asMap(input.tickerToSecurityId);
  const tickerTypes = asMap(input.tickerTypes);
  const mappingSha256 = pickV1MappingSha256(tickerToSid);
  const tickerTypesSha256 = pickV1TickerTypesSha256(tickerTypes);
  const typeFilterSha256 = pickV1TypeFilterSha256();

  type Acc = {
    securityId: string;
    symbol: string;
    reasons: Set<PickV1Reason>;
    randomShaKey?: string;
  };
  const byId = new Map<string, Acc>();
  const add = (securityId: string, symbol: string, reason: PickV1Reason, randomShaKey?: string) => {
    const existing = byId.get(securityId);
    if (!existing) {
      byId.set(securityId, {
        securityId,
        symbol,
        reasons: new Set([reason]),
        ...(randomShaKey ? { randomShaKey } : {}),
      });
      return;
    }
    existing.reasons.add(reason);
    if (symbol < existing.symbol) existing.symbol = symbol;
    if (randomShaKey) existing.randomShaKey = randomShaKey;
  };

  for (const h of input.holdings) add(h.securityId, h.symbol, "holding");
  for (const ix of input.index) add(ix.securityId, ix.symbol, "index");

  let unlinkedExcluded = 0;
  let excludedByType = 0;
  const linkedCandidates = new Map<string, string>(); // securityId → smallest ticker

  // Order of checks: link first, then type.
  // - No securityId link → unlinkedExcluded (regardless of type or missing type).
  // - Linked but type missing or outside PICK_V1_ALLOWED_TYPES → excludedByType.
  // - Linked and type-ok → random-pool candidate.
  for (const row of input.groupedReply.results) {
    const ticker = typeof row.T === "string" ? row.T : undefined;
    if (!ticker) continue;
    const securityId = tickerToSid.get(ticker);
    if (!securityId) {
      unlinkedExcluded += 1;
      continue;
    }
    const type = tickerTypes.get(ticker);
    if (!type || !ALLOWED_TYPE_SET.has(type)) {
      excludedByType += 1;
      continue;
    }
    const prev = linkedCandidates.get(securityId);
    if (prev === undefined || ticker < prev) linkedCandidates.set(securityId, ticker);
  }

  // N = ALL linked type-filtered candidates (no exclusion of index/holdings/top50).
  const candidateIds = [...linkedCandidates.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const N = candidateIds.length;
  const take = Math.ceil(0.05 * N);
  const keyed = candidateIds.map((securityId) => ({
    securityId,
    shaKey: pickV1RandomShaKey(D, securityId),
  }));
  keyed.sort((a, b) =>
    a.shaKey < b.shaKey
      ? -1
      : a.shaKey > b.shaKey
        ? 1
        : a.securityId < b.securityId
          ? -1
          : a.securityId > b.securityId
            ? 1
            : 0,
  );
  for (const r of keyed.slice(0, take)) {
    add(r.securityId, linkedCandidates.get(r.securityId)!, "random", r.shaKey);
  }

  const picks = [...byId.values()]
    .sort((a, b) => (a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0))
    .map((acc) => finalizePick(acc));

  // Count by reason membership (a name that is holding+random increments both).
  let countIndex = 0;
  let countHolding = 0;
  let countRandom = 0;
  for (const acc of byId.values()) {
    if (acc.reasons.has("index")) countIndex += 1;
    if (acc.reasons.has("holding")) countHolding += 1;
    if (acc.reasons.has("random")) countRandom += 1;
  }

  return {
    ruleVersion: PICK_V1_RULE_VERSION,
    sessionDate: D,
    seedFormula: PICK_V1_SEED_FORMULA,
    groupedReply: { key: input.groupedReply.key, sha256: input.groupedReply.sha256 },
    typeFilter: { version: PICK_V1_TYPE_FILTER_VERSION, sha256: typeFilterSha256 },
    mappingSha256,
    tickerTypesSha256,
    candidateCount: N,
    candidateListSha256: sha256(stableJson(candidateIds)),
    counts: {
      index: countIndex,
      holding: countHolding,
      random: countRandom,
      unlinkedExcluded,
      excludedByType,
    },
    picks,
  };
}

/**
 * Top50 picks for D from frozen predictions + beliefs. Does not touch grouped/random.
 * Rank inputs are exactly what beliefs freeze (familyScores, overallRank) plus
 * predictionId and position in the TOP_50_OVERALL list — no feature/score recompute.
 */
export function buildPicksTop50V1(input: {
  sessionDate: string;
  predictions: PickV1StoredJsonlInput<PredictionSet>;
  beliefs: PickV1StoredJsonlInput<ScannerBelief>;
  /** securityId → symbol for names in the top50 list. */
  symbolsBySecurityId: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}): PicksTop50V1 {
  const D = input.sessionDate;
  requireSessionDate(D, "sessionDate");

  if (input.predictions.key !== pickV1PredictionsKey(D))
    throw new PickV1InputError("PICK_V1_PREDICTIONS_KEY_MISMATCH", input.predictions.key);
  if (input.beliefs.key !== pickV1BeliefsKey(D))
    throw new PickV1InputError("PICK_V1_BELIEFS_KEY_MISMATCH", input.beliefs.key);

  for (const set of input.predictions.records) {
    if (set.sessionDate !== D)
      throw new PickV1InputError(
        "PICK_V1_PREDICTIONS_SESSION_MISMATCH",
        `${set.sessionDate}!=${D}`,
      );
  }
  for (const belief of input.beliefs.records) {
    if (belief.sessionDate !== D)
      throw new PickV1InputError(
        "PICK_V1_BELIEFS_SESSION_MISMATCH",
        `${belief.sessionDate}!=${D}`,
      );
  }

  const top50Sets = input.predictions.records.filter((s) => s.setType === "TOP_50_OVERALL");
  if (top50Sets.length === 0)
    throw new PickV1InputError("PICK_V1_TOP50_SET_MISSING", D);
  if (top50Sets.length > 1)
    throw new PickV1InputError("PICK_V1_TOP50_SET_DUPLICATE", String(top50Sets.length));

  const set = top50Sets[0]!;
  const beliefById = new Map<string, ScannerBelief>();
  for (const belief of input.beliefs.records) {
    if (beliefById.has(belief.securityId))
      throw new PickV1InputError("PICK_V1_BELIEF_DUPLICATE", belief.securityId);
    beliefById.set(belief.securityId, belief);
  }
  const symbols = asMap(input.symbolsBySecurityId);

  const picks: PickV1Pick[] = [];
  for (let i = 0; i < set.securityIds.length; i++) {
    const securityId = set.securityIds[i]!;
    const belief = beliefById.get(securityId);
    if (!belief)
      throw new PickV1InputError("PICK_V1_TOP50_BELIEF_MISSING", securityId);
    const symbol = symbols.get(securityId);
    if (symbol === undefined)
      throw new PickV1InputError("PICK_V1_TOP50_SYMBOL_MISSING", securityId);
    const position = i + 1;
    picks.push({
      securityId,
      symbol,
      reason: "top50",
      rankInputs: {
        predictionId: set.predictionId,
        position,
        overallRank: belief.overallRank ?? null,
        familyScores: { ...belief.familyScores },
      },
    });
  }
  picks.sort((a, b) =>
    a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0,
  );

  return {
    ruleVersion: PICK_V1_RULE_VERSION,
    sessionDate: D,
    scanSource: {
      predictions: { key: input.predictions.key, sha256: input.predictions.sha256 },
      beliefs: { key: input.beliefs.key, sha256: input.beliefs.sha256 },
    },
    top50Count: set.securityIds.length,
    counts: { top50: picks.length },
    picks,
  };
}

/**
 * Merge base + top50 into the per-day fetch list: one row per securityId, union of
 * reasons (primary by priority holding > index > top50 > random), alsoReasons for the rest.
 * Order of inputs does not matter; output is sorted by securityId.
 *
 * rankInputs follow the primary reason (top50 inputs if primary is top50; random sha if
 * primary is random; otherwise null). When top50 is only in alsoReasons, top50 rankInputs
 * are not attached (primary wins).
 */
export function mergeDailyTenMinPicksV1(
  base: PicksBaseV1,
  top50: PicksTop50V1 | undefined,
): PickV1Pick[] {
  if (top50 && top50.sessionDate !== base.sessionDate)
    throw new PickV1InputError(
      "PICK_V1_MERGE_SESSION_MISMATCH",
      `${top50.sessionDate}!=${base.sessionDate}`,
    );

  type Acc = {
    securityId: string;
    symbol: string;
    reasons: Set<PickV1Reason>;
    top50?: PickV1RankInputsTop50;
    randomShaKey?: string;
  };
  const byId = new Map<string, Acc>();

  const ingest = (p: PickV1Pick) => {
    const existing = byId.get(p.securityId);
    const reasons = new Set<PickV1Reason>([p.reason, ...(p.alsoReasons ?? [])]);
    const top50Inputs =
      p.rankInputs && "predictionId" in p.rankInputs ? p.rankInputs : undefined;
    const randomShaKey =
      p.rankInputs && "shaKey" in p.rankInputs ? p.rankInputs.shaKey : undefined;
    if (!existing) {
      byId.set(p.securityId, {
        securityId: p.securityId,
        symbol: p.symbol,
        reasons,
        ...(top50Inputs ? { top50: top50Inputs } : {}),
        ...(randomShaKey ? { randomShaKey } : {}),
      });
      return;
    }
    for (const r of reasons) existing.reasons.add(r);
    if (p.symbol < existing.symbol) existing.symbol = p.symbol;
    if (top50Inputs) existing.top50 = top50Inputs;
    if (randomShaKey) existing.randomShaKey = randomShaKey;
  };

  for (const p of base.picks) ingest(p);
  if (top50) for (const p of top50.picks) ingest(p);

  return [...byId.values()]
    .sort((a, b) => (a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0))
    .map((acc) => finalizePick(acc));
}

/**
 * Fetch order for a day: holding → index → top50 → random, then securityId.
 * Priority names (SPY/QQQ index, holdings, top50) are requested before the random group
 * so a mid-day cutoff still leaves them stored.
 */
export function orderPicksForFetch(picks: readonly PickV1Pick[]): PickV1Pick[] {
  return [...picks].sort((a, b) => {
    const byReason = REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason];
    if (byReason !== 0) return byReason;
    return a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0;
  });
}

