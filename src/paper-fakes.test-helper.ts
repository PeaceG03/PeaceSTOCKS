import type { PaperObjectClient } from "./paper-ledger";

/** In-memory client that records every call; delete is not part of the ledger's surface. */
export class RecordingClient implements PaperObjectClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly calls: string[] = [];
  failPutOn?: (key: string) => boolean;
  async get(key: string) {
    this.calls.push(`get ${key}`);
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : undefined;
  }
  async put(key: string, body: Uint8Array) {
    this.calls.push(`put ${key}`);
    if (this.failPutOn?.(key)) throw new Error("INJECTED_CRASH");
    this.puts.push(key);
    this.objects.set(key, new Uint8Array(body));
  }
  async list(prefix: string) {
    this.calls.push(`list ${prefix}`);
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
