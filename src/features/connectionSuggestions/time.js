// Date-only values mean midnight; datetimes must include their offset.
export function connectionDateMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !Number.isFinite(calendar.getTime())
    || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return parsed;
}
