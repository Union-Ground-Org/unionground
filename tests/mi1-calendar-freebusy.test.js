// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  authorizeCalendarFreeBusy,
  buildAuthorizationUrl,
  CALENDAR_OAUTH_SCOPES,
  calendarFreeBusyFailure,
  createCalendarFreeBusy,
  createMemoryCalendarFreeBusy,
  isCalendarFreeBusyFailureReason,
  parseFreeBusyResponse,
  parseMicrosoftSchedule,
  presentBusyConflicts,
  presentCalendarFreeBusy,
  presentLoading,
  presentRetry,
  resolveCalendarOAuthStatus,
  slotConflictsWithBusy,
} from "../src/features/calendarFreeBusy/index.js";

const NOW = "2026-08-27T12:00:00Z";

function actor(overrides = {}) {
  return {
    membershipStatus: "active",
    selectedOrganizationId: "org-1",
    roles: ["steward"],
    userId: "user-1",
    ...overrides,
  };
}

describe("calendar free/busy domain", () => {
  it("stays unset without wrap key and client secrets", () => {
    const status = resolveCalendarOAuthStatus({}, { surface: "saas" });
    expect(status.providers.google.configured).toBe(false);
    expect(status.providers.microsoft.configured).toBe(false);
    const tools = createCalendarFreeBusy({
      actor: actor(),
      store: createMemoryCalendarFreeBusy(),
    });
    const view = presentCalendarFreeBusy(tools.snapshot());
    expect(view.state).toBe("empty");
    expect(view.message).toMatch(/unset/i);
  });

  it("uses SAMPLE_ env names on the demo surface", () => {
    const status = resolveCalendarOAuthStatus({
      SAMPLE_GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "demo.apps.googleusercontent.com",
      SAMPLE_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "demo-secret-value-16",
      SAMPLE_CALENDAR_OAUTH_TOKEN_WRAP_KEY: "x".repeat(32),
    }, { surface: "demo" });
    expect(status.providers.google.configured).toBe(true);
    expect(resolveCalendarOAuthStatus({
      GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "prod.apps.googleusercontent.com",
      GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "prod-secret-value-16",
      CALENDAR_OAUTH_TOKEN_WRAP_KEY: "y".repeat(32),
    }, { surface: "demo" }).providers.google.configured).toBe(false);
  });

  it("rejects a missing actor, empty organization, and cross-organization writes", () => {
    expect(authorizeCalendarFreeBusy({ capability: "request" }).reason).toBe("missing_actor");
    expect(authorizeCalendarFreeBusy({
      actor: actor({ selectedOrganizationId: "" }),
      organizationId: "org-1",
      capability: "request",
    }).reason).toBe("empty_organization");
    expect(authorizeCalendarFreeBusy({
      actor: actor(),
      organizationId: "org-2",
      capability: "request",
    }).reason).toBe("wrong_organization");
    expect(authorizeCalendarFreeBusy({
      actor: actor({ roles: ["member"] }),
      organizationId: "org-1",
      capability: "request",
    }).reason).toBe("unauthorized");
  });

  it("records pending Request while the provider app is unset", () => {
    const tools = createCalendarFreeBusy({ actor: actor() });
    const requested = tools.request("google");
    expect(requested.ok).toBe(true);
    expect(requested.status).toBe("pending");
    expect(requested.reason).toBe("activation_unset");
  });

  it("exercises the memory adapter without leaking mutable rows", () => {
    const seed = { provider: "google", status: "revoked" };
    const store = createMemoryCalendarFreeBusy({
      env: {
        GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "chapter.apps.googleusercontent.com",
        GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "chapter-secret-value-16",
        CALENDAR_OAUTH_TOKEN_WRAP_KEY: "x".repeat(32),
      },
      connections: [seed],
    });
    const listed = store.listConnections();
    listed[0].status = "mutated";
    expect(store.listConnections()[0].status).toBe("revoked");
    expect(store.snapshot(null, "org-1").reason).toBe("missing_actor");
    expect(store.snapshot(actor(), "org-1")).toMatchObject({
      ok: true,
      providers: [
        { provider: "google", configured: true, connection: "revoked" },
        { provider: "microsoft", configured: false, connection: "none" },
      ],
    });
    expect(store.request(actor(), "org-1", "caldav").reason).toBe("unknown_provider");
    expect(store.request(actor(), "org-1", "google")).toMatchObject({
      ok: true,
      provider: "google",
      status: "pending",
      configured: true,
      reason: null,
    });
    expect(store.request(actor(), "org-1", "google").status).toBe("pending");
  });

  it("exposes the composed loading, retry, presentation, and authorization helpers", () => {
    const tools = createCalendarFreeBusy({ actor: actor() });
    expect(tools.present()).toMatchObject({ state: "empty", providers: expect.any(Array) });
    expect(tools.presentLoading()).toEqual(presentLoading());
    expect(tools.presentRetry()).toEqual(presentRetry());
    expect(tools.canRequest()).toBe(true);
    expect(createCalendarFreeBusy({ actor: actor({ roles: ["member"] }) }).canRequest()).toBe(false);
  });

  it("builds a Google authorize URL only with a client id", () => {
    expect(buildAuthorizationUrl({ provider: "google" }).reason).toBe("activation_unset");
    const built = buildAuthorizationUrl({
      provider: "google",
      clientId: "chapter.apps.googleusercontent.com",
      redirectUri: "https://example.org/api/calendar-oauth",
      state: "state-token",
      codeChallenge: "challenge-token",
    });
    expect(built.ok).toBe(true);
    expect(built.url).toContain("accounts.google.com");
    expect(built.url).toContain("calendar.readonly");
    expect(built.url).not.toContain("client_secret");
  });

  it("requests only the Microsoft delegated permissions used by the worker", () => {
    expect(CALENDAR_OAUTH_SCOPES.microsoft).toBe("offline_access User.Read Calendars.ReadBasic");
  });

  it("parses opaque busy windows and marks slot conflicts", () => {
    const parsed = parseFreeBusyResponse("google", {
      calendars: {
        primary: {
          busy: [
            { start: "2026-08-27T15:00:00Z", end: "2026-08-27T16:00:00Z" },
          ],
        },
      },
    }, NOW);
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toEqual([
      { startsAt: "2026-08-27T15:00:00Z", endsAt: "2026-08-27T16:00:00Z" },
    ]);
    const slots = presentBusyConflicts([
      { startsAt: "2026-08-27T15:30:00Z", endsAt: "2026-08-27T16:00:00Z" },
      { startsAt: "2026-08-27T17:00:00Z", endsAt: "2026-08-27T17:30:00Z" },
    ], parsed.windows);
    expect(slots[0].conflict).toBe(true);
    expect(slots[1].conflict).toBe(false);
  });

  it.each([
    ["google", { error: { message: "private provider diagnostic" } }],
    ["google", { calendars: { primary: { errors: [{ reason: "notFound" }] } } }],
    ["google", { calendars: { primary: { busy: [], errors: [{ reason: "internalError" }] } } }],
    ["microsoft", { error: { message: "private provider diagnostic" } }],
    ["microsoft", { value: [{ error: { responseCode: "ErrorMailRecipientNotFound" } }] }],
    ["microsoft", { value: [{ scheduleItems: [], error: { responseCode: "ErrorInternalServerError" } }] }],
  ])("refuses %s provider errors instead of treating unavailable calendars as free", (provider, payload) => {
    expect(parseFreeBusyResponse(provider, payload, NOW)).toEqual({
      ok: false, reason: "provider_error", details: null,
    });
  });

  it.each([
    ["google", { calendars: { primary: { busy: [], errors: [] } } }],
    ["microsoft", { value: [{ scheduleItems: [] }] }],
  ])("accepts a confirmed empty %s calendar", (provider, payload) => {
    expect(parseFreeBusyResponse(provider, payload, NOW)).toEqual({ ok: true, provider, windows: [] });
  });

  it("ignores event titles if a provider payload smuggles them", () => {
    const parsed = parseFreeBusyResponse("google", {
      calendars: {
        primary: {
          busy: [{ start: "2026-08-28T12:00:00Z", end: "2026-08-28T13:00:00Z", summary: "Grievance 12" }],
        },
      },
    }, NOW);
    expect(JSON.stringify(parsed.windows)).not.toMatch(/grievance/i);
    expect(parsed.windows[0]).toEqual({
      startsAt: "2026-08-28T12:00:00Z",
      endsAt: "2026-08-28T13:00:00Z",
    });
  });

  it("normalizes Microsoft busy states and ignores invalid or distant windows", () => {
    const windows = parseMicrosoftSchedule({
      value: [{
        scheduleItems: [
          { status: "busy", start: { dateTime: "2026-08-27T13:00:00" }, end: { dateTime: "2026-08-27T14:00:00" } },
          { status: "tentative", start: { dateTime: "2026-08-28T13:00:00Z" }, end: { dateTime: "2026-08-28T14:00:00Z" } },
          { status: "oof", start: "2026-08-29T13:00:00Z", end: "2026-08-29T14:00:00Z" },
          { status: "free", start: { dateTime: "2026-08-30T13:00:00" }, end: { dateTime: "2026-08-30T14:00:00" } },
          { status: "busy", start: { dateTime: "not-an-instant" }, end: { dateTime: "2026-08-31T14:00:00" } },
          { status: "busy", start: { dateTime: "2027-01-01T13:00:00" }, end: { dateTime: "2027-01-01T14:00:00" } },
        ],
      }],
    }, NOW);
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({
      startsAt: "2026-08-27T13:00:00Z",
      endsAt: "2026-08-27T14:00:00Z",
    });
    expect(parseMicrosoftSchedule({}, NOW)).toEqual([]);
  });

  it("keeps Microsoft workingElsewhere windows and Graph dateTimes that already carry an offset", () => {
    const parsed = parseFreeBusyResponse("microsoft", {
      value: [{
        scheduleItems: [
          {
            status: "workingElsewhere",
            start: { dateTime: "2026-08-27T13:00:00+00:00" },
            end: { dateTime: "2026-08-27T14:00:00+00:00" },
          },
          {
            status: "busy",
            start: { dateTime: "2026-08-27T15:00:00.0000000" },
            end: { dateTime: "2026-08-27T16:00:00.0000000" },
          },
          {
            status: "free",
            start: { dateTime: "2026-08-27T16:00:00+00:00" },
            end: { dateTime: "2026-08-27T17:00:00+00:00" },
          },
        ],
      }],
    }, NOW);
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toEqual([
      { startsAt: "2026-08-27T13:00:00+00:00", endsAt: "2026-08-27T14:00:00+00:00" },
      { startsAt: "2026-08-27T15:00:00.0000000Z", endsAt: "2026-08-27T16:00:00.0000000Z" },
    ]);
    expect(slotConflictsWithBusy(
      "2026-08-27T13:30:00Z",
      "2026-08-27T14:00:00Z",
      parsed.windows,
    )).toBe(true);
    expect(presentBusyConflicts([
      { startsAt: "2026-08-27T13:30:00Z", endsAt: "2026-08-27T14:00:00Z" },
      { startsAt: "2026-08-27T17:00:00Z", endsAt: "2026-08-27T17:30:00Z" },
    ], parsed.windows)).toEqual([
      { startsAt: "2026-08-27T13:30:00Z", endsAt: "2026-08-27T14:00:00Z", conflict: true },
      { startsAt: "2026-08-27T17:00:00Z", endsAt: "2026-08-27T17:30:00Z", conflict: false },
    ]);
  });

  it("fails closed on malformed provider payloads and invalid slot bounds", () => {
    expect(parseFreeBusyResponse("caldav", {}, NOW).reason).toBe("unknown_provider");
    expect(parseFreeBusyResponse("google", {}, "not-a-time")).toMatchObject({
      reason: "invalid_input",
      details: { field: "now" },
    });
    expect(parseFreeBusyResponse("google", [], NOW).reason).toBe("provider_error");
    expect(parseFreeBusyResponse("microsoft", { value: [] }, NOW)).toEqual({
      ok: true,
      provider: "microsoft",
      windows: [],
    });
    expect(slotConflictsWithBusy("bad", NOW, [])).toBe(false);
    expect(slotConflictsWithBusy(NOW, NOW, [])).toBe(false);
    expect(slotConflictsWithBusy(
      "2026-08-27T13:00:00Z",
      "2026-08-27T14:00:00Z",
      [{ startsAt: "bad", endsAt: "2026-08-27T13:30:00Z" }],
    )).toBe(false);
    expect(presentBusyConflicts(null, null)).toEqual([]);
  });

  it("maps every presentation failure without implying live activation", () => {
    const expected = {
      activation_unset: "empty",
      empty_organization: "empty",
      wrong_organization: "wrong_organization",
      catalog_unavailable: "retry",
      invalid_input: "validation",
      unauthorized: "unauthorized",
    };
    for (const [reason, state] of Object.entries(expected)) {
      const view = presentCalendarFreeBusy({ ok: false, reason });
      expect(view.state).toBe(state);
      expect(view.providers).toEqual([]);
      expect(view.message).toBeTruthy();
    }
    expect(presentCalendarFreeBusy(null)).toMatchObject({
      state: "unauthorized",
      reason: "invalid_input",
    });
    expect(presentCalendarFreeBusy({
      ok: true,
      providers: [
        { provider: "microsoft", configured: true, connection: "connected" },
        { provider: "google", configured: false },
      ],
    })).toMatchObject({
      state: "success",
      providers: [
        { label: "Microsoft Outlook", connection: "connected" },
        { label: "Google Calendar", connection: "none" },
      ],
    });
  });

  it("normalizes failure reasons and exposes the reason vocabulary", () => {
    expect(calendarFreeBusyFailure("provider_error", { provider: "google" })).toEqual({
      ok: false,
      reason: "provider_error",
      details: { provider: "google" },
    });
    expect(calendarFreeBusyFailure("invented").reason).toBe("invalid_input");
    expect(isCalendarFreeBusyFailureReason("provider_error")).toBe(true);
    expect(isCalendarFreeBusyFailureReason("invented")).toBe(false);
  });
});
