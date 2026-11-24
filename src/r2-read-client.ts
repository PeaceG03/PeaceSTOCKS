import { R2ObjectClient, type ObjectHead, type ObjectListing } from "./object-store";
import type { SiteReader } from "./site-data";

/**
 * Read-only R2 access for the private site, over R2's S3 API with the separate read-only key pair
 * (an R2 API token with Object Read only). Two locks: put/delete throw before any network call, and
 * the fetch it is given refuses every method except GET and HEAD, so no code path can send a write
 * even if a caller reaches the inner client.
 */
export interface R2ReadConfig {
  accountId: string | undefined;
  bucket: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const READ_ONLY_ERROR = "READ_ONLY";

export function readOnlyFetch(base: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") return Promise.reject(new Error(`${READ_ONLY_ERROR}:${method}`));
    return base(input, init);
  }) as typeof fetch;
}

export class ReadOnlyR2Client implements SiteReader {
  private readonly inner: R2ObjectClient;

  constructor(config: R2ReadConfig) {
    this.inner = new R2ObjectClient({
      accountId: config.accountId ?? "",
      bucket: config.bucket ?? "",
      accessKeyId: config.accessKeyId ?? "",
      secretAccessKey: config.secretAccessKey ?? "",
      fetchImpl: readOnlyFetch(config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))),
      ...(config.sleep ? { sleep: config.sleep } : {}),
    });
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(key);
  }

  head(key: string): Promise<ObjectHead | undefined> {
    return this.inner.head(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  listSizes(prefix: string): Promise<ObjectListing[]> {
    return this.inner.listSizes(prefix);
  }

  async put(): Promise<void> {
    throw new Error(READ_ONLY_ERROR);
  }

  async delete(): Promise<void> {
    throw new Error(READ_ONLY_ERROR);
  }
}
