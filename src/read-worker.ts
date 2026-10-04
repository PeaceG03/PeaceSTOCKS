import { ObjectMarketStorage } from "./object-storage";
import type { ObjectClient } from "./object-store";
import { readScannerRoute } from "./read-api";

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
  list(options: { prefix: string; cursor?: string }): Promise<ReadOnlyObjectList>;
}

class BindingObjectClient implements ObjectClient {
  constructor(private readonly bucket: ReadOnlyBucket) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(key);
    if (!object) return undefined;
    return new Uint8Array(await object.arrayBuffer());
  }

  async put(): Promise<void> {
    throw new Error("READ_ONLY");
  }

  async delete(): Promise<void> {
    throw new Error("READ_ONLY");
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
      for (const object of page.objects) keys.push(object.key);
      if (!page.truncated) break;
      if (!page.cursor) throw new Error("READ_BUCKET_CURSOR_MISSING");
      cursor = page.cursor;
    } while (cursor);
    return keys.sort();
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

export default {
  async fetch(request: Request, env: { PEACESTOCKS: ReadOnlyBucket }): Promise<Response> {
    return createReadWorker(env.PEACESTOCKS).fetch(request);
  },
};
