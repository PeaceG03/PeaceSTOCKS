import { R2ObjectClient, type ObjectHead, type ObjectListing } from "./object-store";
import type { SiteReader } from "./site-data";
import { SiteReadError, errorNameReason, httpReadReason } from "./site-read-error";

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
  private readonly config: R2ReadConfig;

  constructor(config: R2ReadConfig) {
    this.config = config;
    this.client(() => undefined); // same R2_CONFIG_REQUIRED check as before, at construction
  }

  /**
   * A fresh inner client per call whose fetch notes the last failed answer (status and S3 <Code>
   * only) or the last thrown error's name, so a failed read can say why without leaking anything.
   */
  private client(note: (reason: string) => void): R2ObjectClient {
    const base = this.config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const noting = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let response: Response;
      try {
        response = await base(input, init);
      } catch (error) {
        note(errorNameReason(error));
        throw error;
      }
      if (!response.ok) {
        let body = "";
        try {
          body = await response.clone().text();
        } catch {
          body = "";
        }
        note(httpReadReason(response.status, body));
      }
      return response;
    }) as typeof fetch;
    return new R2ObjectClient({
      accountId: this.config.accountId ?? "",
      bucket: this.config.bucket ?? "",
      accessKeyId: this.config.accessKeyId ?? "",
      secretAccessKey: this.config.secretAccessKey ?? "",
      fetchImpl: readOnlyFetch(noting),
      ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
    });
  }

  private async read<T>(run: (inner: R2ObjectClient) => Promise<T>): Promise<T> {
    let reason: string | undefined;
    const inner = this.client((why) => {
      reason = why;
    });
    try {
      return await run(inner);
    } catch (error) {
      throw new SiteReadError(reason ?? errorNameReason(error), { cause: error });
    }
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.read((inner) => inner.get(key));
  }

  head(key: string): Promise<ObjectHead | undefined> {
    return this.read((inner) => inner.head(key));
  }

  list(prefix: string): Promise<string[]> {
    return this.read((inner) => inner.list(prefix));
  }

  listSizes(prefix: string): Promise<ObjectListing[]> {
    return this.read((inner) => inner.listSizes(prefix));
  }

  async put(): Promise<void> {
    throw new Error(READ_ONLY_ERROR);
  }

  async delete(): Promise<void> {
    throw new Error(READ_ONLY_ERROR);
  }
}
