import { createHash, createHmac } from "node:crypto";

export interface ObjectClient {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class MemoryObjectClient implements ObjectClient {
  private readonly objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : undefined;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(body));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
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
}): { authorization: string; amzDate: string; payloadHash: string } {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const canonicalQuery = [...input.url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonicalHeaders = `host:${input.url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
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

  private async request(method: string, url: URL, body: Uint8Array = new Uint8Array()): Promise<Response> {
    const signed = authorizationHeader({
      method,
      url,
      body,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      now: this.now(),
    });
    const init: RequestInit = {
      method,
      headers: {
        authorization: signed.authorization,
        "x-amz-date": signed.amzDate,
        "x-amz-content-sha256": signed.payloadHash,
      },
    };
    if (method !== "GET" && method !== "DELETE") init.body = body;
    return this.fetchImpl(url, init);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.request("GET", this.endpoint(key));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`R2_GET_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const response = await this.request("PUT", this.endpoint(key), body);
    if (!response.ok) throw new Error(`R2_PUT_${response.status}`);
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", this.endpoint(key));
    if (!response.ok && response.status !== 404) throw new Error(`R2_DELETE_${response.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const response = await this.request("GET", this.endpoint("", { "list-type": "2", prefix }));
    if (!response.ok) throw new Error(`R2_LIST_${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => match[1] ?? "").filter(Boolean);
  }
}
