export function categoryBytes(objects: { category: string; size: number }[], category: string): number {
  return objects.filter((x) => x.category === category).reduce((n, x) => n + x.size, 0);
}
