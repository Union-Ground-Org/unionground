export async function collectPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 500,
): Promise<T[]> {
  const collected: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    collected.push(...page);
    if (page.length < pageSize) return collected;
  }
}
