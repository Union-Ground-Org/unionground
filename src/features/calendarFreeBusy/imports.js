const MAX_IMPORTED_EVENTS = 500;

function instant(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new globalThis.Date(parsed).toISOString() : null;
}

function googleInstant(value) {
  return instant(value?.dateTime || (value?.date ? `${value.date}T00:00:00Z` : ""));
}

function microsoftInstant(value) {
  const raw = String(value?.dateTime || "");
  if (!raw) return null;
  // The importer requests UTC from Graph. Treat a timezone-free Graph value
  // as UTC instead of silently interpreting it in the server's local zone.
  return instant(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
}

export function providerSupportsEventImport(provider, scopes) {
  const values = new Set(String(scopes || "").split(/\s+/).filter(Boolean));
  if (provider === "google") {
    return values.has("https://www.googleapis.com/auth/calendar.readonly")
      || values.has("https://www.googleapis.com/auth/calendar");
  }
  if (provider === "microsoft") {
    return values.has("Calendars.ReadBasic") || values.has("Calendars.Read");
  }
  return false;
}

export function normalizeProviderEvents(provider, payload, hashEventId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof hashEventId !== "function") throw new Error("calendar_import_parse_failed");
  const rows = Array.isArray(payload.items) ? payload.items
    : (Array.isArray(payload.value) ? payload.value : null);
  if (!rows || rows.length > MAX_IMPORTED_EVENTS) throw new Error("calendar_import_parse_failed");
  const result = [];
  for (const row of rows) {
    const cancelled = provider === "google" ? row?.status === "cancelled" : row?.isCancelled === true;
    if (cancelled) continue;
    const rawId = String(row?.id || "").trim();
    const start = provider === "google" ? googleInstant(row?.start) : microsoftInstant(row?.start);
    const end = provider === "google" ? googleInstant(row?.end) : microsoftInstant(row?.end);
    if (!rawId || !start || !end || Date.parse(end) <= Date.parse(start)) {
      throw new Error("calendar_import_parse_failed");
    }
    result.push({
      eventKey: hashEventId(rawId),
      startsAt: start,
      endsAt: end,
      allDay: provider === "google" ? Boolean(row?.start?.date) : Boolean(row?.isAllDay),
      sourceUpdatedAt: instant(provider === "google" ? row?.updated : row?.lastModifiedDateTime),
    });
  }
  return result;
}
