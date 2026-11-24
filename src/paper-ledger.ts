/**
 * Simulated paper-trading ledger (docs/PAPER_TRADING.md). No node: imports, so the site Worker can read it.
 *
 * Append-only: every object is written once under paper/v1/ and never overwritten or deleted. Keys have
 * exactly these shapes: intents, fills, days (one per trading session) and corrections (one per
 * correction of an exit fill). A write to a key that already
 * exists keeps the stored object (a retried step is a no-op), so an order can never be duplicated.
 * Writes are conditional puts (If-None-Match: *): the store refuses an overwrite.
 */

export const PAPER_LEDGER_PREFIX = "paper/v1/";
export const PAPER_INTENTS_PREFIX = "paper/v1/intents/";
export const PAPER_FILLS_PREFIX = "paper/v1/fills/";
export const PAPER_DAYS_PREFIX = "paper/v1/days/";
export const PAPER_CORRECTIONS_PREFIX = "paper/v1/corrections/";
/** An object at this key stops all new orders and ledger writes (kill switch). */
export const PAPER_KILL_KEY = "paper/KILL";

const SESSION = /^\d{4}-\d{2}-\d{2}$/u;
const LEDGER_KEY = /^paper\/v1\/(intents|fills|days)\/(\d{4}-\d{2}-\d{2})\.json$/u;
/** paper/v1/corrections/<fill session>/<securityId>_<n>.json: the n-th correction of that exit fill. */
const CORRECTION_KEY = /^paper\/v1\/corrections\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9._-]{1,64})_([1-9][0-9]?)\.json$/u;
const SECURITY = /^[A-Za-z0-9._-]{1,64}$/u;

export type PaperLedgerKind = "intents" | "fills" | "days";
export type PaperSide = "BUY" | "SELL";

export function paperLedgerKey(kind: PaperLedgerKind, sessionDate: string): string {
  if (!SESSION.test(sessionDate)) throw new Error("PAPER_LEDGER_SESSION_INVALID");
  return `${PAPER_LEDGER_PREFIX}${kind}/${sessionDate}.json`;
}

/** Session date of a ledger key, or undefined when it is not a ledger key of that kind. */
export function paperLedgerSession(key: string, kind: PaperLedgerKind): string | undefined {
  const match = LEDGER_KEY.exec(key);
  return match && match[1] === kind ? match[2] : undefined;
}

export function paperCorrectionKey(sessionDate: string, securityId: string, n: number): string {
  if (!SESSION.test(sessionDate)) throw new Error("PAPER_LEDGER_SESSION_INVALID");
  if (!SECURITY.test(securityId)) throw new Error("PAPER_LEDGER_SECURITY_INVALID");
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error("PAPER_LEDGER_CORRECTION_INVALID");
  return `${PAPER_CORRECTIONS_PREFIX}${sessionDate}/${securityId}_${n}.json`;
}

export function parsePaperCorrectionKey(key: string): { sessionDate: string; securityId: string; n: number } | undefined {
  const match = CORRECTION_KEY.exec(key);
  return match ? { sessionDate: match[1]!, securityId: match[2]!, n: Number(match[3]) } : undefined;
}

/** The client order id: one per (rules version, session, security, side). */
export function paperClientOrderId(rulesVersion: string, sessionDate: string, securityId: string, side: PaperSide): string {
  if (!SESSION.test(sessionDate)) throw new Error("PAPER_LEDGER_SESSION_INVALID");
  if (!SECURITY.test(securityId)) throw new Error("PAPER_LEDGER_SECURITY_INVALID");
  return `${rulesVersion}_${sessionDate}_${securityId}_${side}`;
}

interface RulesStamp {
  rulesVersion: string;
  rulesSha256: string;
}

export interface PaperOrderIntent extends RulesStamp {
  clientOrderId: string;
  sessionDate: string;
  securityId: string;
  side: PaperSide;
  purpose: "ENTRY" | "EXIT";
}

export type PaperEntryRefusal =
  | "NO_FREEZE_STATUS"
  | "EVIDENCE_ONLY"
  | "UNAVAILABLE"
  | "NOT_PREDICTIONS_FROZEN"
  | "FREEZE_PROOF_MISSING"
  | "FREEZE_SESSION_MISMATCH"
  | "FROZEN_AFTER_OPEN"
  | "LIST_MISSING"
  | "LIST_EMPTY"
  | "DAILY_LOSS_LIMIT"
  | "FILLS_PENDING";

/** The orders for one session's open, written before that open. */
export interface PaperIntents extends RulesStamp {
  schemaVersion: "paper-intents-v1";
  /** Session whose 09:30 ET open the orders are for. */
  sessionDate: string;
  /** The frozen session the entries come from (the trading session before). */
  freezeSessionDate: string;
  /** Run clock when written; always before nextSessionOpen. */
  recordedAt: string;
  /** That session's open (ISO UTC), from the freeze proof or the calendar. */
  sessionOpen: string;
  orders: PaperOrderIntent[];
  entriesRefused?: PaperEntryRefusal;
}

/**
 * WRITTEN_OFF: a held name with no open at writeOffAfterMissedExits exit attempts in a row, closed at
 * its last known close (no slippage). There is no "fill flat": exits always fill at the actual open.
 */
export type PaperFillStatus = "FILLED" | "WRITTEN_OFF" | "NO_PRICE" | "NOT_HELD" | "ALREADY_HELD" | "ZERO_QTY";

export interface PaperFill extends RulesStamp {
  clientOrderId: string;
  securityId: string;
  side: PaperSide;
  purpose: "ENTRY" | "EXIT";
  status: PaperFillStatus;
  qty: number;
  /** Stored (unadjusted) open of the session. */
  rawOpen?: number;
  /** Price paid / received per share after slippage (and split adjustment on exits). */
  fillPrice?: number;
  /** Exits: the unadjusted price the exit used (the session's open, or the last close for a write-off). */
  rawPrice?: number;
  /** Exits: the split factor applied (product over (entry, exit] of the split records known then; 1 if none or unreconciled). */
  splitFactorApplied?: number;
  /** Exits: the position's entry session. */
  entrySessionDate?: string;
  /** qty x fillPrice. */
  notionalUsd: number;
  commissionUsd: number;
  slippageUsd: number;
  flags: string[];
}

export interface PaperPosition {
  securityId: string;
  qty: number;
  /** Stored open on the entry session (before slippage). */
  entryOpen: number;
  entryFillPrice: number;
  entrySessionDate: string;
  /** Exit attempts in a row with no open (halted / delisted); absent means 0. */
  missedExits?: number;
}

export interface PaperFills extends RulesStamp {
  schemaVersion: "paper-fills-v1";
  sessionDate: string;
  cashBefore: number;
  cashAfterExits: number;
  /** Cash after exits plus names still held, marked: the equity entries are sized from. */
  equityAtOpen: number;
  cashAfter: number;
  positionsAfter: PaperPosition[];
  fills: PaperFill[];
  /** Corrections added to cash at this open (sum of their cashAdjustmentUsd); absent means 0. */
  correctionsUsd?: number;
  /** Every correction key applied so far, this open's included (cumulative, sorted). */
  correctionsApplied?: string[];
}

/**
 * An exit fill is never rewritten. When a split record that changes the factor an exit used turns up
 * later, a correction is appended: the corrected price and the cash difference, which is added to cash
 * at the next open that is filled.
 */
export interface PaperCorrection extends RulesStamp {
  schemaVersion: "paper-correction-v1";
  /** Session of the exit fill being corrected. */
  sessionDate: string;
  securityId: string;
  clientOrderId: string;
  /** 1 for the first correction of this fill, 2 for the next, ... */
  n: number;
  qty: number;
  rawPrice: number;
  /** Factor the previous price used (the fill's, or the previous correction's). */
  previousFactor: number;
  previousFillPrice: number;
  correctedFactor: number;
  correctedFillPrice: number;
  /** qty x (correctedFillPrice - previousFillPrice). */
  cashAdjustmentUsd: number;
  recordedAt: string;
}

/** One open-to-open window, from the previous filled session's open to this session's open. */
export interface PaperDay extends RulesStamp {
  schemaVersion: "paper-day-v1";
  fromSessionDate: string;
  toSessionDate: string;
  equityFrom: number;
  equityTo: number;
  paperReturn: number;
  spyReturn: number | null;
  universeReturn: number | null;
  universeSize: number;
  cumulativePaperReturn: number;
  cumulativeSpyReturn: number;
  cumulativeUniverseReturn: number;
  /** Names held through the window. */
  positions: number;
  costsUsd: number;
  /** Corrections of earlier exit fills that entered equity at this window's closing open. */
  correctionsUsd?: number;
  entriesRefused?: PaperEntryRefusal;
}

/**
 * The minimal object-store surface the ledger needs: read, list, and create-only writes (a conditional
 * put, If-None-Match: *). It has no plain put and no delete on purpose.
 */
export interface PaperObjectClient {
  get(key: string): Promise<Uint8Array | undefined>;
  /** True when written; false when the key already exists (nothing is overwritten). */
  putIfAbsent(key: string, body: Uint8Array): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export class PaperLedgerStore {
  constructor(private readonly client: PaperObjectClient) {}

  /**
   * Write once, as one conditional put: the store itself refuses to overwrite an existing key, so the
   * stored object is kept (KEPT_EXISTING) even if two writers race.
   */
  async putOnce(key: string, value: PaperIntents | PaperFills | PaperDay | PaperCorrection): Promise<"WRITTEN" | "KEPT_EXISTING"> {
    if (!LEDGER_KEY.test(key) && !CORRECTION_KEY.test(key)) throw new Error("PAPER_LEDGER_KEY_REFUSED");
    const written = await this.client.putIfAbsent(key, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    return written ? "WRITTEN" : "KEPT_EXISTING";
  }

  async read<T>(key: string): Promise<T | undefined> {
    const body = await this.client.get(key);
    return body === undefined ? undefined : (JSON.parse(text(body)) as T);
  }

  /** Sessions with a stored object of this kind, oldest first. */
  async sessions(kind: PaperLedgerKind): Promise<string[]> {
    const keys = await this.client.list(`${PAPER_LEDGER_PREFIX}${kind}/`);
    return keys
      .map((key) => paperLedgerSession(key, kind))
      .filter((session): session is string => session !== undefined)
      .sort();
  }

  /** Every correction key, sorted. */
  async correctionKeys(): Promise<string[]> {
    return (await this.client.list(PAPER_CORRECTIONS_PREFIX)).filter((key) => CORRECTION_KEY.test(key)).sort();
  }

  async killed(): Promise<boolean> {
    return (await this.client.get(PAPER_KILL_KEY)) !== undefined;
  }
}
