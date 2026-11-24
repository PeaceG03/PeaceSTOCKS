import assert from "node:assert/strict";
import test from "node:test";
import { ReadOnlyR2Client } from "./r2-read-client";
import { loadSiteData, type SiteData } from "./site-data";
import { renderSitePage } from "./site-page";
import { READ_REASON_MAX, SiteReadError, httpReadReason, readReason } from "./site-read-error";

const KEY_ID = "AKIDSENTINEL0001";
const SECRET = "SECRETSENTINEL0002";

/** What R2 / S3 sends back for a bad signature: it echoes the key id and the signed request. */
const SIGNATURE_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SignatureDoesNotMatch</Code><Message>MESSAGESENTINEL The request signature we calculated does not match</Message><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId><StringToSign>STRINGTOSIGNSENTINEL AWS4-HMAC-SHA256 20261124T090000Z</StringToSign><SignatureProvided>SIGNATURESENTINEL0123abcd</SignatureProvided><StringToSignBytes>41 57 53 34</StringToSignBytes><CanonicalRequest>CANONICALSENTINEL GET /bucket/ list-type=2&amp;prefix=runs%2F</CanonicalRequest><CanonicalRequestBytes>47 45 54</CanonicalRequestBytes><RequestId>REQUESTIDSENTINEL</RequestId><HostId>HOSTIDSENTINEL</HostId></Error>`;
const SENTINELS = [KEY_ID, SECRET, "SENTINEL", "r2.cloudflarestorage.com", "X-Amz", "list-type", "Signature=", "AWS4-HMAC"];

function client(answer: () => Promise<Response>): ReadOnlyR2Client {
  return new ReadOnlyR2Client({
    accountId: "acctsentinel",
    bucket: "bucket",
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    fetchImpl: (async () => answer()) as typeof fetch,
    sleep: async () => undefined,
  });
}

async function pageFor(answer: () => Promise<Response>): Promise<{ data: SiteData; html: string }> {
  const data = await loadSiteData(client(answer));
  return { data, html: renderSitePage(data) };
}

function assertNoLeak(data: SiteData, html: string): void {
  const reasons = JSON.stringify({ readErrors: data.readErrors, readErrorReasons: data.readErrorReasons });
  for (const sentinel of SENTINELS) {
    assert.ok(!reasons.includes(sentinel), `${sentinel} in readErrors: ${reasons}`);
    assert.ok(!html.includes(sentinel), `${sentinel} on the page`);
  }
}

test("site read errors: a SignatureDoesNotMatch body shows only 'HTTP 403 SignatureDoesNotMatch', nothing it echoes", async () => {
  const { data, html } = await pageFor(async () => new Response(SIGNATURE_BODY, { status: 403, headers: { "content-type": "application/xml" } }));
  assertNoLeak(data, html); // first, so a leak is what fails
  assert.ok(data.readErrors.includes("health") && data.readErrors.includes("runs") && data.readErrors.includes("scheduler"), data.readErrors.join());
  for (const name of data.readErrors) assert.equal(data.readErrorReasons?.[name], "HTTP 403 SignatureDoesNotMatch", name);
  assert.match(html, /Could not read: [^<]*health \(HTTP 403 SignatureDoesNotMatch\)/u);
  assert.match(html, /runs \(HTTP 403 SignatureDoesNotMatch\)/u);
  assertNoLeak(data, html);
});

test("site read errors: the other usual S3 codes come through as status + code", async () => {
  for (const [status, code] of [[403, "InvalidAccessKeyId"], [403, "AccessDenied"], [404, "NoSuchBucket"], [400, "InvalidArgument"]] as const) {
    const body = `<Error><Code>${code}</Code><Message>MESSAGESENTINEL</Message><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId></Error>`;
    const { data, html } = await pageFor(async () => new Response(body, { status }));
    assert.equal(data.readErrorReasons?.runs, `HTTP ${status} ${code}`);
    assert.match(html, new RegExp(`runs \\(HTTP ${status} ${code}\\)`, "u"));
    assertNoLeak(data, html);
  }
});

test("site read errors: a <Code> that is not a plain word, or no body, gives the status only", async () => {
  for (const body of [`<Error><Code>${KEY_ID} SENTINEL</Code></Error>`, `<Error><Code>Bad&lt;x&gt;</Code></Error>`, `<Error><Code>${"A".repeat(65)}</Code></Error>`, "", "not xml SENTINEL"]) {
    const { data, html } = await pageFor(async () => new Response(body, { status: 403 }));
    assert.equal(data.readErrorReasons?.runs, "HTTP 403", body);
    assertNoLeak(data, html.replaceAll("A".repeat(65), ""));
  }
  assert.equal(httpReadReason(403, `<Code>${"A".repeat(64)}</Code>`), `HTTP 403 ${"A".repeat(64)}`);
});

test("site read errors: a network or crypto exception shows its name only, never its message", async () => {
  const thrown = [
    new TypeError(`fetch failed SENTINEL https://acctsentinel.r2.cloudflarestorage.com/bucket/?X-Amz-Signature=${SECRET}`),
    new DOMException(`timeout SENTINEL ${KEY_ID}`, "TimeoutError"),
  ];
  for (const error of thrown) {
    const { data, html } = await pageFor(async () => {
      throw error;
    });
    assert.equal(data.readErrorReasons?.runs, error.name);
    assert.match(html, new RegExp(`runs \\(${error.name}\\)`, "u"));
    assertNoLeak(data, html);
  }
  // A thrown non-Error, or a name that is not a plain word: just "Error".
  const odd = Object.assign(new Error(`x ${SECRET}`), { name: `Weird ${SECRET}` });
  assert.equal(readReason(odd), "Error");
  assert.equal(readReason(`string ${SECRET}`), "Error");
});

test("site read errors: reasons are cut to about 120 characters and HTML-escaped on the page", () => {
  const long = readReason(new SiteReadError("x".repeat(500)));
  assert.equal(long.length, READ_REASON_MAX);
  const data: SiteData = {
    generatedAt: "2026-11-24T09:00:00.000Z",
    checkins: [],
    backlog: {},
    reports: [],
    predictions: { picks: [] } as unknown as SiteData["predictions"],
    readErrors: ["health", "runs"],
    readErrorReasons: { health: `<script>alert(1)</script>${"y".repeat(300)}`, runs: "HTTP 403 AccessDenied" },
  };
  const html = renderSitePage(data);
  assert.ok(!html.includes("<script>alert"), "escaped");
  assert.match(html, /health \(&lt;script&gt;alert\(1\)&lt;\/script&gt;y+…\)/u);
  const shown = /health \(([^)]*)\)/u.exec(html)![1]!.replaceAll(/&[a-z]+;/gu, "_");
  assert.ok(shown.length <= READ_REASON_MAX, `${shown.length}`);
  assert.match(html, /runs \(HTTP 403 AccessDenied\)/u);
});
