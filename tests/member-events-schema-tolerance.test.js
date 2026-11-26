import { describe, expect, it } from "vitest";
import { LEGACY_EVENT_COLUMNS } from "../src/lib/eventSchemaCompatibility.js";
import { fetchMemberEventsForChapter, loadAuthorizedCalendarEvent, MEMBER_EVENT_COLUMNS } from "../src/lib/memberApi.js";

// A schema without check_in_offered predates rsvp_open too
// (REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030), so that retry
// drops both columns.
const legacyColumns = MEMBER_EVENT_COLUMNS.split(",").filter((column) => column !== "check_in_offered" && column !== "rsvp_open").join(",");
const event = { id: "event", chapter_id: "home", title: "Meeting", starts_at: "2026-10-09T12:00:00Z" };
const missingColumn = (code) => ({ code, message: "column member_events.check_in_offered does not exist" });

function mockClient(respond) {
  const calls = [];
  return {
    calls,
    from(table) {
      const operations = [];
      const query = new Proxy({}, {
        get(_target, name) {
          if (name === "then") return (resolve, reject) => {
            calls.push({ table, operations });
            return Promise.resolve(respond(table, operations)).then(resolve, reject);
          };
          return (...args) => { operations.push([name, ...args]); return query; };
        },
      });
      return query;
    },
  };
}

function assertRetryScope(calls) {
  for (const current of calls.filter(({ operations }) => operations[0][1] === MEMBER_EVENT_COLUMNS)) {
    const legacy = calls.find((candidate) => candidate.operations[0][1] === legacyColumns
      && JSON.stringify(candidate.operations.slice(1)) === JSON.stringify(current.operations.slice(1)));
    expect(legacy).toBeDefined();
  }
}

describe("member event reads across the hosted schema cutover", () => {
  it("preserves both retries when check-in and event-model columns are absent", async () => {
    const client = mockClient((table, operations) => {
      if (table !== "member_events") return { data: null, error: null };
      const columns = operations[0][1];
      if (columns === MEMBER_EVENT_COLUMNS) return { data: null, error: missingColumn("42703") };
      if (columns !== LEGACY_EVENT_COLUMNS) return { data: null, error: { code: "42703", message: "column member_events.event_kind does not exist" } };
      return { data: event, error: null };
    });
    await expect(loadAuthorizedCalendarEvent(client, event.id, "member")).resolves.toMatchObject({ id: event.id, checkInOffered: false });
    const calls = client.calls.filter(({ table }) => table === "member_events");
    expect(calls.map(({ operations }) => operations[0][1])).toEqual([MEMBER_EVENT_COLUMNS, legacyColumns, LEGACY_EVENT_COLUMNS]);
    expect(calls.every(({ operations }) => JSON.stringify(operations.slice(1)) === JSON.stringify(calls[0].operations.slice(1)))).toBe(true);
  });

  it.each(["42703", "PGRST204"])("retries every archive page and discovery with identical scope for %s", async (code) => {
    const client = mockClient((_table, operations) => {
      if (operations[0][1] === MEMBER_EVENT_COLUMNS) return { data: null, error: missingColumn(code) };
      const range = operations.find(([name]) => name === "range");
      const own = operations.some(([name, column]) => name === "eq" && column === "chapter_id");
      const organization = operations.some(([name, column, value]) => name === "eq" && column === "is_public_across_agencies" && value);
      if (range?.[1] === 0) return { data: Array.from({ length: 500 }, (_, i) => ({ ...event, id: `${own ? "own" : "org"}-${i}` })), error: null };
      return { data: [{ ...event, id: own ? "own-last" : organization ? "org-last" : "discovery" }], error: null };
    });
    const result = await fetchMemberEventsForChapter(client, "home", Date.parse(event.starts_at));
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1003);
    expect(client.calls).toHaveLength(10);
    assertRetryScope(client.calls);
    expect(client.calls.filter(({ operations }) => operations.some(([name, from]) => name === "range" && from === 500))).toHaveLength(4);
  });

  it.each(["42703", "PGRST204"])("loads an authorized legacy calendar row with check-in disabled for %s", async (code) => {
    const client = mockClient((table, operations) => table !== "member_events"
      ? { data: null, error: null }
      : operations[0][1] === MEMBER_EVENT_COLUMNS
        ? { data: null, error: missingColumn(code) }
        : { data: event, error: null });
    await expect(loadAuthorizedCalendarEvent(client, event.id, "member")).resolves.toMatchObject({ id: event.id, checkInOffered: false });
    const calls = client.calls.filter(({ table }) => table === "member_events");
    expect(calls).toHaveLength(2);
    assertRetryScope(calls);
  });

  it.each([
    { code: "42501", message: "permission denied" },
    { code: "42703", message: "column member_events.unrelated does not exist" },
    { code: "PGRST204", message: "another column is missing" },
    { code: "500", message: "check_in_offered service failure" },
  ])("propagates unrelated errors without retry: $code / $message", async (error) => {
    const client = mockClient(() => ({ data: null, error }));
    await expect(loadAuthorizedCalendarEvent(client, event.id, "member")).rejects.toBe(error);
    expect(client.calls).toHaveLength(1);
  });

  it("propagates the retry error without a third attempt", async () => {
    const error = missingColumn("42703");
    const client = mockClient(() => ({ data: null, error }));
    await expect(loadAuthorizedCalendarEvent(client, event.id, "member")).rejects.toBe(error);
    expect(client.calls).toHaveLength(2);
  });

  it("keeps the migrated calendar value and never retries successful reads", async () => {
    const client = mockClient((table) => ({ data: table === "member_events" ? { ...event, check_in_offered: true } : null, error: null }));
    await expect(loadAuthorizedCalendarEvent(client, event.id, "member")).resolves.toMatchObject({ checkInOffered: true });
    expect(client.calls.filter(({ table }) => table === "member_events")).toHaveLength(1);
  });

  it("never retries successful chapter, organization or discovery reads", async () => {
    const client = mockClient(() => ({ data: [event], error: null }));
    await expect(fetchMemberEventsForChapter(client, "home")).resolves.toEqual({ data: [event], error: null });
    expect(client.calls).toHaveLength(3);
  });
});
