export interface Item {
  readonly id: string;
  readonly name: string;
}

function isItem(candidate: unknown): candidate is Item {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const record: Record<string, unknown> = candidate as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['name'] === 'string';
}

export function collectItems(candidates: readonly unknown[]): readonly Item[] {
  const items: Item[] = [];
  for (const candidate of candidates) {
    if (isItem(candidate)) items.push(candidate);
  }
  return items;
}

export function firstLabel(items: readonly Item[]): string {
  const head: Item | undefined = items[0];
  return head === undefined ? '' : head.name.trim();
}
