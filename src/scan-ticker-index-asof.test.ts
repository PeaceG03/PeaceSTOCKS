// The ticker reference index records the day the listing was taken (ET), not the past session a
// catch-up is scanning: live scan 45310223847 relabelled a November listing as October 13-21.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner, US_EQUITY_CALENDAR } from "./scanner";
import type { TickerReferenceCapture } from "./ticker-reference-index";

const PAST = "2026-10-13";
const NOW = new Date("2026-11-24T03:00:00.000Z"); // Nov 23 22:00 ET
class Provider implements MarketProvider {
  readonly providerName = "fixture-provider";
  private capture: TickerReferenceCapture | undefined;
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    this.capture = { pages: { active: 1, inactive: 0 }, entries: [] } as unknown as TickerReferenceCapture;
    return [{ provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true }];
  }
  takeTickerReferenceCapture() { const c = this.capture; this.capture = undefined; return c; }
  takeTickerReferenceCaptureError() { return undefined; }
  async getDailyBars(): Promise<CanonicalDailyBar[]> { return []; }
  async getCorporateActions(): Promise<CorporateAction[]> { return []; }
}

test("catch-up of a past session writes the ticker index as of the listing day (ET), not the session", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const seen: string[] = [];
  storage.saveTickerReferenceIndex = async (_capture, options) => {
    seen.push(options.asOf);
    return { pages: { active: 1, inactive: 0 }, records: { active: 0, inactive: 0 } } as never;
  };
  await new MarketsScanner(new Provider(), storage, US_EQUITY_CALENDAR, undefined, () => NOW).run(PAST, "EVIDENCE_ONLY");
  assert.deepEqual(seen, ["2026-11-23"]);
});
