/**
 * An in-process fake of the Massive endpoints the backfill uses (reference tickers, grouped daily,
 * splits, dividends). For dry runs and tests only: it answers a `fetch` call from memory and never
 * opens a connection. Use with baseUrl https://massive.invalid (a reserved name that cannot resolve).
 */
export const FAKE_MASSIVE_BASE_URL = "https://massive.invalid";

export interface FakeTicker {
  ticker: string;
  figi: string;
  type?: "CS" | "ETF";
  active: boolean;
  listDate?: string;
  delistedDate?: string;
}

export interface FakeGroupedRow {
  T: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FakeMassiveOptions {
  tickers: readonly FakeTicker[];
  /** Grouped-daily rows for a date (an empty list for a date with no trading). */
  grouped: (date: string) => readonly FakeGroupedRow[];
  /** Plan window: grouped-daily (and actions) before this date answer 403 like Massive does. */
  planFrom?: string;
  /** Optional per-request hook (e.g. advance a fake clock for latency, or fail a request). */
  onRequest?: (url: URL) => Response | undefined;
}

export interface FakeMassive {
  fetchImpl: typeof fetch;
  calls: { tickers: number; grouped: string[]; splits: number; dividends: number; refusedPlan: number };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeMassive(options: FakeMassiveOptions): FakeMassive {
  const calls: FakeMassive["calls"] = { tickers: 0, grouped: [], splits: 0, dividends: 0, refusedPlan: 0 };
  const planRefusal = () => {
    calls.refusedPlan += 1;
    return json({ status: "NOT_AUTHORIZED", request_id: "fake", message: "Your plan doesn't include this data timeframe. Please upgrade your plan." }, 403);
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== FAKE_MASSIVE_BASE_URL) throw new Error(`FAKE_MASSIVE_UNEXPECTED_ORIGIN:${url.origin}`);
    const hooked = options.onRequest?.(url);
    if (hooked) return hooked;
    if (url.pathname === "/v3/reference/tickers") {
      calls.tickers += 1;
      const active = url.searchParams.get("active") !== "false";
      return json({
        status: "OK",
        results: options.tickers
          .filter((t) => t.active === active)
          .map((t) => ({
            ticker: t.ticker,
            share_class_figi: t.figi,
            type: t.type ?? "CS",
            market: "stocks",
            locale: "us",
            primary_exchange: "XNYS",
            active: t.active,
            ...(t.listDate ? { list_date: t.listDate } : {}),
            ...(t.delistedDate ? { delisted_utc: `${t.delistedDate}T21:00:00Z` } : {}),
          })),
      });
    }
    const day = /\/v2\/aggs\/grouped\/locale\/us\/market\/stocks\/(\d{4}-\d{2}-\d{2})$/u.exec(url.pathname)?.[1];
    if (day) {
      if (options.planFrom && day < options.planFrom) return planRefusal();
      calls.grouped.push(day);
      const t = Date.parse(`${day}T21:00:00Z`);
      const results = options.grouped(day).map((row) => ({ ...row, t }));
      return json({ status: "OK", adjusted: false, queryCount: results.length, resultsCount: results.length, request_id: `fake-${day}`, results });
    }
    if (url.pathname === "/stocks/v1/splits" || url.pathname === "/stocks/v1/dividends") {
      const date = url.searchParams.get(url.pathname.endsWith("splits") ? "execution_date" : "ex_dividend_date") ?? "";
      if (options.planFrom && date < options.planFrom) return planRefusal();
      if (url.pathname.endsWith("splits")) calls.splits += 1;
      else calls.dividends += 1;
      return json({ status: "OK", results: [] });
    }
    return json({ status: "ERROR", message: "fake: unknown path" }, 404);
  };
  return { fetchImpl, calls };
}

/** Deterministic synthetic market for a mocked paid-tier range: n tickers, prices from the date. */
export function syntheticMarket(n: number): { tickers: FakeTicker[]; grouped: (date: string) => FakeGroupedRow[] } {
  const tickers = Array.from({ length: n }, (_, k) => ({ ticker: `SYN${k}`, figi: `FAKEFIGI${k}`, active: true }));
  const grouped = (date: string) => {
    const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
    return tickers.map((t, k) => {
      const c = 10 + k + ((day * (k + 7)) % 97) / 10;
      return { T: t.ticker, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 + k };
    });
  };
  return { tickers, grouped };
}
