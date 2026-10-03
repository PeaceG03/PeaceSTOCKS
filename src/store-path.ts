import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

export function prepareSafeStoreDirectory(root: string, errorCode: string): string {
  const normalized = resolve(root);
  if (normalized === parse(normalized).root) throw new Error(errorCode);
  assertNoReparseAncestors(normalized, errorCode);
  const existing = tryLstat(normalized, errorCode);
  if (existing && !existing.isDirectory()) throw new Error(errorCode);
  mkdirSync(normalized, { recursive: true });
  assertNoReparseAncestors(normalized, errorCode);
  const created = tryLstat(normalized, errorCode);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) throw new Error(errorCode);
  return normalized;
}

export function assertSafeStoreDirectory(directory: string, errorCode: string): void {
  const normalized = resolve(directory);
  if (normalized === parse(normalized).root) throw new Error(errorCode);
  assertNoReparseAncestors(normalized, errorCode);
  const existing = tryLstat(normalized, errorCode);
  if (!existing || existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(errorCode);
}
export function prepareSafeStoreFile(file: string, errorCode: string): string {
  const normalized = resolve(file);
  if (normalized === parse(normalized).root) throw new Error(errorCode);
  prepareSafeStoreDirectory(dirname(normalized), errorCode);
  assertSafeStoreFile(normalized, errorCode);
  return normalized;
}

export function assertSafeStoreFile(file: string, errorCode: string): void {
  const normalized = resolve(file);
  if (normalized === parse(normalized).root) throw new Error(errorCode);
  assertNoReparseAncestors(normalized, errorCode);
  const existing = tryLstat(normalized, errorCode);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(errorCode);
}

function assertNoReparseAncestors(path: string, errorCode: string): void {
  let current = resolve(path);
  const leaf = current;
  const filesystemRoot = parse(current).root;
  while (true) {
    const existing = tryLstat(current, errorCode);
    if (existing?.isSymbolicLink()) throw new Error(errorCode);
    if (current !== leaf && existing && !existing.isDirectory()) throw new Error(errorCode);
    if (current === filesystemRoot) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function tryLstat(path: string, errorCode: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(errorCode);
  }
}

/** Resolve a relative child under an existing store root; reject traversal before outside access. */
export function resolveSafeStoreChild(
  root: string,
  relativePath: string,
  errorCode: string,
): string {
  assertSafeStoreDirectory(root, errorCode);
  const normalizedRoot = resolve(root);
  if (
    typeof relativePath !== "string" ||
    relativePath.length < 1 ||
    relativePath.length > 240 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(errorCode);
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(errorCode);
  }
  const candidate = resolve(normalizedRoot, ...parts);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (candidate === normalizedRoot || !candidate.startsWith(prefix)) {
    throw new Error(errorCode);
  }
  assertNoReparseAncestors(candidate, errorCode);
  const existing = tryLstat(candidate, errorCode);
  if (existing?.isSymbolicLink()) throw new Error(errorCode);
  return candidate;
}
