import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Paper trading is simulated only (docs/PAPER_TRADING.md). No live broker endpoint may appear anywhere
 * in src/ or .github/workflows/. Hosts are assembled from parts so this file never contains one.
 */
const DOT = ".";
const ALPACA = ["alpaca", "markets"].join(DOT);
/** Any host ending in api.<alpaca>, except exactly the paper one, is a live (or broker) endpoint. */
const ALPACA_HOST = new RegExp(`([a-z0-9.-]*)api\\${DOT}${ALPACA.replace(DOT, `\\${DOT}`)}`, "giu");
const ALLOWED_ALPACA_PREFIX = "paper-";
const OTHER_LIVE_HOSTS = [
  ["api", "tradier", "com"],
  ["api", "schwabapi", "com"],
  ["api", "tdameritrade", "com"],
  ["api", "etrade", "com"],
  ["api", "tastyworks", "com"],
  ["api", "tastytrade", "com"],
  ["api", "ibkr", "com"],
  ["api", "robinhood", "com"],
].map((parts) => parts.join(DOT));

export function liveBrokerHits(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(ALPACA_HOST)) if (match[1]!.toLowerCase() !== ALLOWED_ALPACA_PREFIX) hits.push(match[0]);
  const lower = text.toLowerCase();
  for (const host of OTHER_LIVE_HOSTS) if (lower.includes(host)) hits.push(host);
  return hits;
}

/** Broker / trading SDK package names (npm). Any dependency matching one is refused. */
const BROKER_PACKAGE = /(^|[/@-])(alpaca|alpacahq|tradier|schwab|tdameritrade|td-ameritrade|etrade|e-trade|tastytrade|tastyworks|ibkr|interactive-?brokers|ib-tws|@stoqey\/ib|robinhood|webull|ccxt|tradestation|questrade|oanda|tradovate)([/@-]|$)/iu;

/** Every dependency name of a package.json (all four dependency maps) that looks like a broker SDK. */
export function brokerPackageHits(packageJson: string): string[] {
  const manifest = JSON.parse(packageJson) as Record<string, unknown>;
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field];
    if (deps && typeof deps === "object") names.push(...Object.keys(deps));
  }
  return names.filter((name) => BROKER_PACKAGE.test(name));
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

const root = fileURLToPath(new URL("..", import.meta.url));

test("no live broker endpoint in src/ or .github/workflows/", () => {
  const scanned = [...files(join(root, "src")), ...files(join(root, ".github", "workflows"))];
  assert.ok(scanned.length > 50, "scanned the tree");
  const bad: string[] = [];
  for (const path of scanned) for (const hit of liveBrokerHits(readFileSync(path, "latin1"))) bad.push(`${path.slice(root.length)}: ${hit}`);
  assert.deepEqual(bad, []);
});

test("the detector catches live hosts and allows only the paper host", () => {
  const live = `https://api${DOT}${ALPACA}/v2/orders`;
  const paper = `https://paper-api${DOT}${ALPACA}/v2/orders`;
  assert.deepEqual(liveBrokerHits(live), [`api${DOT}${ALPACA}`]);
  assert.deepEqual(liveBrokerHits(`"API${DOT}${ALPACA.toUpperCase()}"`).length, 1);
  assert.deepEqual(liveBrokerHits(`https://broker-api${DOT}${ALPACA}`).length, 1);
  assert.deepEqual(liveBrokerHits(`https://xpaper-api${DOT}${ALPACA}`).length, 1);
  assert.deepEqual(liveBrokerHits(paper), []);
  assert.deepEqual(liveBrokerHits(`see ${OTHER_LIVE_HOSTS[0]}`), [OTHER_LIVE_HOSTS[0]]);
  assert.deepEqual(liveBrokerHits("no broker here"), []);
});

test("no broker SDK in package.json or the lockfile", () => {
  assert.deepEqual(brokerPackageHits(readFileSync(join(root, "package.json"), "utf8")), []);
  // The lockfile's package keys ("/name@version" or "name@version:") must not name one either.
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const lockNames = [...lock.matchAll(/^ {2}'?\/?((?:@[^/@\s']+\/)?[^@\s'/]+)@/gmu)].map((m) => m[1]!);
  assert.ok(lockNames.length > 20, "parsed the lockfile");
  assert.deepEqual(lockNames.filter((name) => BROKER_PACKAGE.test(name)), []);
});

test("the SDK detector catches broker packages in any dependency map", () => {
  for (const name of ["@alpacahq/alpaca-trade-api", "alpaca-ts", "@master-chief/alpaca", "tradier-client", "schwab-client-js", "@stoqey/ib", "ib-tws-api", "ccxt", "robinhood", "interactive-brokers", "oanda-node", "webull-api"]) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
      assert.deepEqual(brokerPackageHits(JSON.stringify({ [field]: { [name]: "1.0.0", tsx: "1" } })), [name], `${field} ${name}`);
  }
  assert.deepEqual(brokerPackageHits(JSON.stringify({ dependencies: { tsx: "1", typescript: "5", "@types/node": "24" } })), []);
});
