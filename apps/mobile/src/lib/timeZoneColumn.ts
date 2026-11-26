// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the
// time_zone columns of member cases and step deadlines arrive with their
// migration, which may apply after this build is live. A database without the
// column yet answers 42703 or PGRST204 naming it; the read then runs once
// without it, and every deadline counts on New York's zone as before. Mirrors
// missingTimeZoneColumn in src/lib/memberApi.js.

type ReadError = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined;

export function missingTimeZoneColumn(error: unknown): boolean {
  const value = error as ReadError;
  if (!value || !['42703', 'PGRST204'].includes(String(value.code ?? ''))) return false;
  return /\btime_zone\b/.test([value.message, value.details, value.hint].map((part) => String(part ?? '')).join(' '));
}

export function withoutTimeZoneColumn(columns: string): string {
  return columns.split(',').filter((column) => column !== 'time_zone').join(',');
}

// A read's answer. A column list built at run time leaves the rows untyped,
// so callers name their row type where they already did.
export type ReadResult = { data: unknown; error: unknown };

// One read, and the same read without time_zone when the column is not there yet.
export async function readWithTimeZoneFallback(columns: string, read: (columns: string) => PromiseLike<ReadResult>): Promise<ReadResult> {
  const first: ReadResult = await read(columns);
  if (!missingTimeZoneColumn(first.error)) return first;
  const second: ReadResult = await read(withoutTimeZoneColumn(columns));
  return second;
}
