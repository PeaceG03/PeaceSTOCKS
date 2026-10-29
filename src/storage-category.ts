export function storageCategory(key: string): string {
  return key.split("/")[0] ?? "";
}
