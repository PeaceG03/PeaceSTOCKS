// Test-only fake R2 endpoint for R2ObjectClient: PUT/GET/HEAD/DELETE/ListObjectsV2 in memory.
// Like real R2, HEAD returns metadata values containing / ? = & as RFC 2047 Q-encoded words.
import { R2ObjectClient } from "./object-store";

/** Q-encode like R2 does: short encoded words up to just past the last "?", the rest plain. */
export function encodeLikeR2(value: string): string {
  if (!/[/?=&]/u.test(value)) return value;
  const q = value.lastIndexOf("?");
  const head = value.slice(0, q >= 0 ? Math.min(q + 6, value.length) : value.length);
  const words: string[] = [];
  for (let i = 0; i < head.length; i += 9) {
    const chunk = [...Buffer.from(head.slice(i, i + 9), "utf8")]
      .map((b) => (/[A-Za-z0-9.-]/u.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`))
      .join("");
    words.push(`=?utf-8?Q?${chunk}?=`);
  }
  return words.join(" ") + value.slice(head.length);
}

export function fakeR2(): { objects: Map<string, { body: Uint8Array; meta: Record<string, string> }>; client: R2ObjectClient } {
  const objects = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }
    if (method === "PUT") {
      const meta: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        if (name.startsWith("x-amz-meta-")) meta[name.slice(11)] = value;
      });
      objects.set(key, { body: new Uint8Array(init?.body as Uint8Array), meta });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const found = objects.get(key);
    if (!found) return new Response(null, { status: 404 });
    if (method === "HEAD") {
      const headers: Record<string, string> = { "content-length": String(found.body.length) };
      for (const [name, value] of Object.entries(found.meta)) headers[`x-amz-meta-${name}`] = encodeLikeR2(value);
      return new Response(null, { status: 200, headers });
    }
    return new Response(found.body, { status: 200 });
  };
  return {
    objects,
    client: new R2ObjectClient({ accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", fetchImpl }),
  };
}
