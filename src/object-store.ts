import { createHash, createHmac } from "node:crypto";

/** Custom object metadata: lowercase names, printable-ASCII values (S3 x-amz-meta-*). */
export type ObjectMetadata = Record<string, string>;

export interface ObjectHead {
  size: number;
  metadata: ObjectMetadata;
}

export interface ObjectClient {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void>;
  /** Size and custom metadata without the body, or undefined if the key does not exist. */
  head(key: string): Promise<ObjectHead | undefined>;
  delete(key: string): Promise<void>;
  /** Every key under the prefix (all pages), sorted. */
  list(prefix: string): Promise<string[]>;
}

/** Kept at S3's 2 KB user-metadata limit (R2 allows more) so objects stay portable. */
export const OBJECT_METADATA_MAX_BYTES = 2048;
const METADATA_PREFIX = "x-amz-meta-";

/**
 * Check metadata before any write: names are lowercase [a-z0-9-], values printable ASCII, and the
 * total (header names with x-amz-meta- plus values) is at most 2 KB. Never truncates.
 */
export function assertObjectMetadata(metadata: ObjectMetadata): void {
  let bytes = 0;
  for (const [name, value] of Object.entries(metadata)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) throw new Error(`OBJECT_METADATA_NAME_INVALID:${name}`);
    if (typeof value !== "string" || !/^[\x20-\x7e]*$/u.test(value))
      throw new Error(`OBJECT_METADATA_VALUE_NOT_ASCII:${name}`);
    bytes += METADATA_PREFIX.length + name.length + value.length;
  }
  if (bytes > OBJECT_METADATA_MAX_BYTES) throw new Error(`OBJECT_METADATA_TOO_LARGE:${bytes}`);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/gu;

function decodeEncodedWord(charset: string, encoding: string, text: string): string | undefined {
  const name = charset.toLowerCase().split("*")[0];
  if (name !== "utf-8" && name !== "utf8" && name !== "us-ascii") return undefined;
  let bytes: Uint8Array;
  if (encoding === "B" || encoding === "b") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return undefined;
    bytes = Buffer.from(text, "base64");
  } else {
    const out: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (char === "_") out.push(0x20);
      else if (char === "=") {
        const hex = text.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) return undefined;
        out.push(Number.parseInt(hex, 16));
        i += 2;
      } else out.push(char.charCodeAt(0));
    }
    bytes = Uint8Array.from(out);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Decode RFC 2047 encoded words (=?charset?Q?...?= / =?charset?B?...?=, utf-8 or us-ascii) in a
 * metadata value as R2 returns it on HEAD/GET for values with characters like / ? = &. Whitespace
 * between two adjacent encoded words is dropped; plain text around them is kept. Values with no
 * encoded word (or an undecodable one) are returned unchanged.
 */
export function decodeRfc2047Value(value: string): string {
  if (!value.includes("=?")) return value;
  let output = "";
  let last = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const start = match.index;
    const between = value.slice(last, start);
    const decoded = decodeEncodedWord(match[1]!, match[2]!, match[3]!);
    if (decoded === undefined) {
      output += between + match[0];
      previousWasWord = false;
    } else {
      if (!(previousWasWord && /^\s*$/u.test(between))) output += between;
      output += decoded;
      previousWasWord = true;
    }
    last = start + match[0].length;
  }
  return output + value.slice(last);
}

export class MemoryObjectClient implements ObjectClient {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly metadata = new Map<string, ObjectMetadata>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : undefined;
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}): Promise<void> {
    assertObjectMetadata(metadata);
    this.objects.set(key, new Uint8Array(body));
    this.metadata.set(key, { ...metadata });
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    const found = this.objects.get(key);
    return found ? { size: found.length, metadata: { ...(this.metadata.get(key) ?? {}) } } : undefined;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.metadata.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function xmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function authorizationHeader(input: {
  method: string;
  url: URL;
  body: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  /** Extra x-amz-* headers (lowercase names) to sign; S3 requires every x-amz-* header signed. */
  amzHeaders?: Record<string, string>;
}): { authorization: string; amzDate: string; payloadHash: string } {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const canonicalQuery = [...input.url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const headers: Array<[string, string]> = [
    ["host", input.url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  for (const [name, value] of Object.entries(input.amzHeaders ?? {}))
    headers.push([name.toLowerCase(), value.trim().replaceAll(/\s+/gu, " ")]);
  headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash,
  };
}

export class R2ObjectClient implements ObjectClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly config: R2Config) {
    if (!config.accountId || !config.bucket || !config.accessKeyId || !config.secretAccessKey)
      throw new Error("R2_CONFIG_REQUIRED");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): R2ObjectClient {
    return new R2ObjectClient({
      accountId: env.PEACESTOCKS_R2_ACCOUNT_ID ?? "",
      bucket: env.PEACESTOCKS_R2_BUCKET ?? "",
      accessKeyId: env.PEACESTOCKS_R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.PEACESTOCKS_R2_SECRET_ACCESS_KEY ?? "",
    });
  }

  private endpoint(key = "", query?: Record<string, string>): URL {
    const url = new URL(`https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}/${encodeKey(key)}`);
    if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  private async request(
    method: string,
    url: URL,
    body: Uint8Array = new Uint8Array(),
    amzHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const signed = authorizationHeader({
      method,
      url,
      body,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      now: this.now(),
      amzHeaders,
    });
    const init: RequestInit = {
      method,
      headers: {
        ...amzHeaders,
        authorization: signed.authorization,
        "x-amz-date": signed.amzDate,
        "x-amz-content-sha256": signed.payloadHash,
      },
    };
    if (method !== "GET" && method !== "DELETE" && method !== "HEAD") init.body = body;
    return this.fetchImpl(url, init);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.request("GET", this.endpoint(key));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`R2_GET_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}): Promise<void> {
    assertObjectMetadata(metadata);
    const amzHeaders = Object.fromEntries(
      Object.entries(metadata).map(([name, value]) => [`${METADATA_PREFIX}${name}`, value]),
    );
    const response = await this.request("PUT", this.endpoint(key), body, amzHeaders);
    if (!response.ok) throw new Error(`R2_PUT_${response.status}`);
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    const response = await this.request("HEAD", this.endpoint(key));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`R2_HEAD_${response.status}`);
    const metadata: ObjectMetadata = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      // R2 returns values containing / ? = & as RFC 2047 encoded words; we store them raw.
      if (lower.startsWith(METADATA_PREFIX))
        metadata[lower.slice(METADATA_PREFIX.length)] = decodeRfc2047Value(value);
    });
    return { size: Number(response.headers.get("content-length") ?? "0"), metadata };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", this.endpoint(key));
    if (!response.ok && response.status !== 404) throw new Error(`R2_DELETE_${response.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    // ListObjectsV2 returns at most 1000 keys per page; follow continuation tokens to the end.
    const keys: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100_000; page += 1) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const response = await this.request("GET", this.endpoint("", query));
      if (!response.ok) throw new Error(`R2_LIST_${response.status}`);
      const xml = await response.text();
      keys.push(
        ...[...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => xmlText(match[1] ?? "")).filter(Boolean),
      );
      const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u.exec(xml)?.[1];
      if (!truncated) return keys.sort();
      if (!token) throw new Error("R2_LIST_TRUNCATED_WITHOUT_TOKEN");
      token = xmlText(token);
    }
    throw new Error("R2_LIST_TOO_MANY_PAGES");
  }
}
