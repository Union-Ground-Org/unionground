import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAdminEvent, updateAdminEvent,
  fetchMemberEventsForChapter,
  MEMBER_EVENT_COLUMNS,
  MEMBER_EVENT_DISCOVERY_LIMIT,
} from "../src/lib/memberApi.js";

function queryClient({ archivePages, organizationPages = [{ data: [], error: null }], discovery }) {
  const calls = [];
  const from = vi.fn((table) => {
    const operations = [];
    let proxy;
    proxy = new Proxy({}, {
      get(_target, property) {
        if (property === "then") {
          return (resolve, reject) => {
            calls.push({ table, operations });
            const isOrganizationArchive = operations.some(([name, column, value]) => (
              name === "eq" && column === "is_public_across_agencies" && value === true
            ));
            const isChapterArchive = operations.some(([name, column]) => (
              name === "eq" && column === "chapter_id"
            ));
            const pages = isOrganizationArchive ? organizationPages : archivePages;
            const result = isOrganizationArchive || isChapterArchive
              ? (pages.length > 1 ? pages.shift() : pages[0])
              : discovery;
            return Promise.resolve(result).then(resolve, reject);
          };
        }
        return (...args) => {
          operations.push([property, ...args]);
          return proxy;
        };
      },
    });
    return proxy;
  });
  return { calls, client: { from }, from };
}

describe("member event query scope", () => {
  it("loads current-chapter and organization-wide archives plus one bounded regional window", async () => {
    const organizationPast = { id: "organization-past", chapter_id: "neighbor", starts_at: "2025-08-01T12:00:00Z", is_public_across_agencies: true };
    const current = { id: "current", chapter_id: "home", starts_at: "2026-08-01T12:00:00Z" };
    const future = { id: "future", chapter_id: "neighbor", starts_at: "2026-09-20T12:00:00Z" };
    const floor = Date.parse("2026-09-02T12:00:00Z");
    const harness = queryClient({
      archivePages: [{ data: [current], error: null }],
      organizationPages: [{ data: [organizationPast], error: null }],
      discovery: { data: [future], error: null },
    });

    const result = await fetchMemberEventsForChapter(harness.client, "home", floor);

    expect(result).toEqual({ data: [organizationPast, current, future], error: null });
    expect(harness.from).toHaveBeenCalledTimes(3);
    const archive = harness.calls.find((call) => call.operations.some(([name, column]) => (
      name === "eq" && column === "chapter_id"
    )));
    const organization = harness.calls.find((call) => call.operations.some(([name, column, value]) => (
      name === "eq" && column === "is_public_across_agencies" && value === true
    )));
    const discovery = harness.calls.find((call) => call.operations.some(([name]) => name === "or"));
    expect(archive.operations).toContainEqual(["eq", "chapter_id", "home"]);
    expect(archive.operations).toContainEqual(["range", 0, 499]);
    expect(organization.operations).toContainEqual(["eq", "is_public_across_agencies", true]);
    expect(organization.operations).toContainEqual(["neq", "chapter_id", "home"]);
    expect(organization.operations).toContainEqual(["range", 0, 499]);
    expect(discovery.operations).toContainEqual(["neq", "chapter_id", "home"]);
    expect(discovery.operations).toContainEqual(["eq", "is_public_across_agencies", false]);
    expect(discovery.operations).toContainEqual(["or", "and(event_kind.eq.meeting,sort_at.gte.2026-09-02T12:00:00.000Z),and(event_kind.neq.meeting,event_date.gte.2026-09-02)"]);
    expect(discovery.operations).toContainEqual(["limit", MEMBER_EVENT_DISCOVERY_LIMIT]);
    expect(discovery.operations.some(([name]) => name === "range")).toBe(false);
  });

  it("preserves the own-chapter archive when additive discovery fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const current = { id: "current", chapter_id: "home", starts_at: "2026-08-01T12:00:00Z" };
    const organization = { id: "organization", chapter_id: "neighbor", starts_at: "2026-08-02T12:00:00Z", is_public_across_agencies: true };
    const harness = queryClient({
      archivePages: [{ data: [current], error: null }],
      organizationPages: [{ data: [organization], error: null }],
      discovery: { data: null, error: { message: "regional timeout" } },
    });

    await expect(fetchMemberEventsForChapter(harness.client, "home"))
      .resolves.toEqual({ data: [current, organization], error: null });
    warn.mockRestore();
  });

  it("preserves own-chapter and regional rows when organization-wide history fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const current = { id: "current", chapter_id: "home", starts_at: "2026-08-01T12:00:00Z" };
    const future = { id: "future", chapter_id: "neighbor", starts_at: "2026-09-20T12:00:00Z" };
    const harness = queryClient({
      archivePages: [{ data: [current], error: null }],
      organizationPages: [{ data: null, error: { message: "organization timeout" } }],
      discovery: { data: [future], error: null },
    });

    await expect(fetchMemberEventsForChapter(harness.client, "home"))
      .resolves.toEqual({ data: [current, future], error: null });
    warn.mockRestore();
  });

  it("walks every current-chapter archive page without widening the query", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `current-${String(index).padStart(3, "0")}`,
      chapter_id: "home",
      starts_at: "2025-01-01T12:00:00Z",
    }));
    const finalRow = { id: "current-final", chapter_id: "home", starts_at: "2024-01-01T12:00:00Z" };
    const harness = queryClient({
      archivePages: [
        { data: firstPage, error: null },
        { data: [finalRow], error: null },
      ],
      discovery: { data: [], error: null },
    });

    const result = await fetchMemberEventsForChapter(harness.client, "home");

    expect(result.data).toHaveLength(501);
    const archiveCalls = harness.calls.filter((call) => call.operations.some(([name, column]) => (
      name === "eq" && column === "chapter_id"
    )));
    expect(archiveCalls.map((call) => call.operations.find(([name]) => name === "range")))
      .toEqual([["range", 0, 499], ["range", 500, 999]]);
    expect(archiveCalls.every((call) => call.operations.some((operation) => (
      operation[0] === "eq" && operation[1] === "chapter_id" && operation[2] === "home"
    )))).toBe(true);
  });

  it("selects and surfaces event cancellation columns", async () => {
    // Regression: MEMBER_EVENT_COLUMNS omitted cancelled_at/cancelled_reason,
    // so the web projection could not mark cancelled events and they rendered
    // as normal upcoming events whose RSVP/check-in fail server-side.
    expect(MEMBER_EVENT_COLUMNS.split(",")).toEqual(
      expect.arrayContaining(["cancelled_at", "cancelled_reason"]),
    );
    const cancelled = {
      id: "cancelled",
      chapter_id: "home",
      starts_at: "2026-09-20T12:00:00Z",
      cancelled_at: "2026-09-19T12:00:00Z",
      cancelled_reason: "Weather",
    };
    const harness = queryClient({
      archivePages: [{ data: [cancelled], error: null }],
      discovery: { data: [], error: null },
    });

    const result = await fetchMemberEventsForChapter(harness.client, "home");

    expect(result).toEqual({ data: [cancelled], error: null });
    for (const call of harness.calls) {
      expect(call.operations).toContainEqual(["select", MEMBER_EVENT_COLUMNS]);
    }
    // The member event projection must expose the columns camelCase so views
    // can gate on them; pinned against the map in the dashboard loader.
    const source = readFileSync(resolve(process.cwd(), "src/lib/memberApi.js"), "utf8");
    expect(source).toContain("cancelledAt: item.cancelled_at ?? null");
    expect(source).toContain("cancelledReason: item.cancelled_reason ?? null");
  });

  it("walks every organization-wide history page independently of regional discovery", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `organization-${String(index).padStart(3, "0")}`,
      chapter_id: "neighbor",
      starts_at: "2025-01-01T12:00:00Z",
      is_public_across_agencies: true,
    }));
    const finalRow = {
      id: "organization-final",
      chapter_id: "neighbor",
      starts_at: "2024-01-01T12:00:00Z",
      is_public_across_agencies: true,
    };
    const harness = queryClient({
      archivePages: [{ data: [], error: null }],
      organizationPages: [
        { data: firstPage, error: null },
        { data: [finalRow], error: null },
      ],
      discovery: { data: [], error: null },
    });

    const result = await fetchMemberEventsForChapter(harness.client, "home");

    expect(result.data).toHaveLength(501);
    const organizationCalls = harness.calls.filter((call) => call.operations.some(([name, column, value]) => (
      name === "eq" && column === "is_public_across_agencies" && value === true
    )));
    expect(organizationCalls.map((call) => call.operations.find(([name]) => name === "range")))
      .toEqual([["range", 0, 499], ["range", 500, 999]]);
    expect(organizationCalls.every((call) => (
      call.operations.some((operation) => (
        operation[0] === "neq" && operation[1] === "chapter_id" && operation[2] === "home"
      ))
    ))).toBe(true);
  });

  it("does not query events before onboarding assigns a chapter", async () => {
    const harness = queryClient({
      archivePages: [{ data: [], error: null }],
      discovery: { data: [], error: null },
    });

    await expect(fetchMemberEventsForChapter(harness.client, "  "))
      .resolves.toEqual({ data: [], error: null });
    expect(harness.from).not.toHaveBeenCalled();
  });
});

describe('event model reads', () => {
  it('selects dates and ends without exposing the admission code', () => {
    for (const column of ['ends_at', 'event_kind', 'event_date', 'series_id', 'sort_at', 'check_in_offered']) expect(MEMBER_EVENT_COLUMNS.split(',')).toContain(column);
    expect(MEMBER_EVENT_COLUMNS.split(',')).not.toContain('check_in_code');
  });
});

it('maps creation and end removal onto the model RPCs', async () => {
  const rpc = vi.fn(async () => ({ data: { created: true }, error: null }));
  await createAdminEvent({ rpc }, { id: 'deadline', title: 'Submit', startsAt: null, eventKind: 'deadline', eventDate: '2027-02-01', location: 'Online', summary: 'Submit form' });
  expect(rpc).toHaveBeenCalledWith('create_member_event_model', expect.objectContaining({ p_starts_at: null, p_event_date: '2027-02-01', p_kind: 'deadline', p_check_in_code: null }));
  const schedule = { kind: 'meeting', startsAt: '2027-02-01T15:00:27Z', eventDate: null, endsAt: null };
  await updateAdminEvent({ rpc }, 'meeting', { schedule, eventModelRequired: true, removeCheckInCode: true });
  expect(rpc).toHaveBeenLastCalledWith('update_member_event_model', expect.objectContaining({ p_schedule: schedule, p_check_in_code: '' }));
});


it('keeps today’s regional deadline in discovery after its midnight sort key', async () => {
  const deadline = { id: 'regional-deadline', chapter_id: 'neighbor', event_kind: 'deadline', event_date: '2026-09-02', sort_at: '2026-09-02T00:00:00Z', starts_at: null };
  const harness = queryClient({ archivePages: [{ data: [], error: null }], discovery: { data: [deadline], error: null } });
  const result = await fetchMemberEventsForChapter(harness.client, 'home', Date.parse('2026-09-02T10:00:00Z'));
  expect(result.data).toEqual([deadline]);
  const query = harness.calls.find((call) => call.operations.some(([name]) => name === 'limit'));
  expect(query.operations).toContainEqual(['or', 'and(event_kind.eq.meeting,sort_at.gte.2026-09-02T10:00:00.000Z),and(event_kind.neq.meeting,event_date.gte.2026-09-02)']);
  expect(query.operations.some(([name]) => name === 'gte')).toBe(false);
});
