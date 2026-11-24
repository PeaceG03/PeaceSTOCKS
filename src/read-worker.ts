import { verifyAccessJwt, type AccessJwtResult } from "./access-jwt";
import { ObjectMarketStorage } from "./object-storage";
import type { ObjectClient, ObjectHead } from "./object-store";
import { ReadOnlyR2Client } from "./r2-read-client";
import { readScannerRoute } from "./read-api";
import { loadSiteData } from "./site-data";
import { renderSitePage, SITE_HEADERS } from "./site-page";

export interface ReadOnlyObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ReadOnlyObjectList {
  objects: ReadonlyArray<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

export interface ReadOnlyBucket {
  get(key: string): Promise<ReadOnlyObjectBody | null>;
  /** R2 binding head(): customMetadata is the same data the S3 API returns as x-amz-meta-*. */
  head?(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  list(options: { prefix: string; cursor?: string }): Promise<ReadOnlyObjectList>;
}

export class BindingObjectClient implements ObjectClient {
  constructor(private readonly bucket: ReadOnlyBucket) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(key);
    if (!object) return undefined;
    return new Uint8Array(await object.arrayBuffer());
  }

  async put(): Promise<void> {
    throw new Error("READ_ONLY");
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    if (!this.bucket.head) throw new Error("READ_BUCKET_HEAD_UNSUPPORTED");
    const object = await this.bucket.head(key);
    return object ? { size: object.size, metadata: { ...(object.customMetadata ?? {}) } } : undefined;
  }

  async delete(): Promise<void> {
    throw new Error("READ_ONLY");
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    // Bounded listing: a bucket that keeps returning truncated pages (a cursor that never ends) fails closed after
    // 1000 pages instead of spinning the Worker.
    let pages = 0;
    while (pages < 1000) {
      pages += 1;
      const page = await this.bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
      for (const object of page.objects) keys.push(object.key);
      if (!page.truncated) return keys.sort();
      if (!page.cursor) throw new Error("READ_BUCKET_CURSOR_MISSING");
      cursor = page.cursor;
    }
    throw new Error("READ_BUCKET_LIST_PAGE_CAP");
  }
}

export function createReadWorker(bucket: ReadOnlyBucket): { fetch(request: Request): Promise<Response> } {
  const storage = new ObjectMarketStorage(new BindingObjectClient(bucket));
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json({ error: "READ_ONLY" }, { status: 405 });
      }
      const result = await readScannerRoute(storage, new URL(request.url).pathname);
      return Response.json(result.body, { status: result.status });
    },
  };
}

/**
 * Settings the deploy workflow gives the Worker. Vars: ACCESS_TEAM_DOMAIN, ACCESS_AUD. Secrets:
 * ALLOWED_EMAIL and the read-only R2 key pair. There is deliberately no R2 binding: a binding can
 * write, the read key pair cannot.
 */
export interface SiteEnv {
  ACCESS_TEAM_DOMAIN?: string | undefined;
  ACCESS_AUD?: string | undefined;
  ALLOWED_EMAIL?: string | undefined;
  R2_ACCOUNT_ID?: string | undefined;
  R2_BUCKET?: string | undefined;
  R2_READ_ACCESS_KEY_ID?: string | undefined;
  R2_READ_SECRET_ACCESS_KEY?: string | undefined;
}

const PLAIN_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: PLAIN_HEADERS });
}

/**
 * The private site. Every request, whatever its path or method, must first carry a valid Access JWT
 * for the one allowed email; nothing is read from storage before that. Then GET/HEAD only:
 * "/" is the status page, /scanner/* the existing JSON routes.
 */
export function createSiteWorker(deps: {
  verify: (request: Request) => Promise<AccessJwtResult>;
  client: (ObjectClient & { listSizes: NonNullable<ObjectClient["listSizes"]> }) | undefined;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      let verdict: AccessJwtResult;
      try {
        verdict = await deps.verify(request);
      } catch {
        verdict = { ok: false, reason: "VERIFY_FAILED" };
      }
      if (!verdict.ok)
        return verdict.reason === "ACCESS_NOT_CONFIGURED" ? plain(503, "Not configured.") : plain(403, "Forbidden.");
      if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Read only.");
      if (!deps.client) return plain(503, "Storage not configured.");
      const path = new URL(request.url).pathname;
      if (path === "/") {
        const html = renderSitePage(await loadSiteData(deps.client));
        return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: SITE_HEADERS });
      }
      if (path.startsWith("/scanner/")) {
        const result = await readScannerRoute(new ObjectMarketStorage(deps.client), path);
        return Response.json(result.body, { status: result.status, headers: { "cache-control": "private, no-store" } });
      }
      return plain(404, "Not found.");
    },
  };
}

export function siteReadClient(env: SiteEnv, fetchImpl?: typeof fetch): ReadOnlyR2Client | undefined {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET || !env.R2_READ_ACCESS_KEY_ID || !env.R2_READ_SECRET_ACCESS_KEY) return undefined;
  return new ReadOnlyR2Client({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_READ_ACCESS_KEY_ID,
    secretAccessKey: env.R2_READ_SECRET_ACCESS_KEY,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * The one host the site answers on: the Access-protected custom domain (wrangler.toml route). Any other
 * host (a *.workers.dev or preview URL, if ever switched on) sits outside Access, so it gets 404 before
 * the JWT check or any storage read.
 */
export const SITE_HOSTNAME = "stocks.jjpeace.com";

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    if (new URL(request.url).hostname !== SITE_HOSTNAME) return plain(404, "Not found.");
    return createSiteWorker({
      verify: (incoming) =>
        verifyAccessJwt(incoming.headers.get("cf-access-jwt-assertion"), {
          teamDomain: env.ACCESS_TEAM_DOMAIN,
          aud: env.ACCESS_AUD,
          allowedEmail: env.ALLOWED_EMAIL,
        }),
      client: siteReadClient(env),
    }).fetch(request);
  },
};
