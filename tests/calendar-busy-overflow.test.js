// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../api/calendar-sync.js";
import { encryptRefreshToken } from "../api/_lib/calendarOAuth.js";
import { parseFreeBusyResponse, slotConflictsWithBusy } from "../src/features/calendarFreeBusy/freebusy.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://calendar-fixture.supabase.co"));

const NOW = "2026-10-20T12:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const instant = (offset) => new Date(Date.parse(NOW) + offset).toISOString();
const busyWindows = (count) => Array.from({ length: count }, (_, index) => ({
  start: instant(index * HOUR), end: instant(index * HOUR + HOUR / 2),
}));
const ignored = [
  { start: "not-an-instant", end: "not-an-instant" },
  { start: instant(-48 * HOUR), end: instant(-47 * HOUR) },
  { start: instant(61 * 24 * HOUR), end: instant(61 * 24 * HOUR + HOUR) },
  { start: NOW, end: NOW },
];

function payload(provider, windows) {
  return provider === "google" ? { calendars: { primary: { busy: windows } } } : {
    value: [{ scheduleItems: windows.map(({ start, end }) => ({
      status: "busy", start: { dateTime: start }, end: { dateTime: end },
    })) }],
  };
}

describe.each(["google", "microsoft"])("%s busy-window capacity", (provider) => {
  it("refuses 501 disjoint in-horizon windows instead of returning a successful prefix", () => {
    const parsed = parseFreeBusyResponse(provider, payload(provider, busyWindows(501)), NOW);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("provider_error");
    expect(parsed).not.toHaveProperty("windows");
  });

  it.each([0, 1, 500])("retains every conflict in a complete %i-window response", (count) => {
    const windows = busyWindows(count);
    const parsed = parseFreeBusyResponse(provider, payload(provider, windows), NOW);
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toEqual(windows.map(({ start, end }) => ({ startsAt: start, endsAt: end })));
    if (count) {
      const last = windows.at(-1);
      expect(slotConflictsWithBusy(last.start, last.end, parsed.windows)).toBe(true);
    }
  });

  it("does not count invalid or out-of-horizon rows before or after 500 valid windows", () => {
    const windows = busyWindows(500);
    const noise = Array.from({ length: 150 }, () => ignored).flat();
    const parsed = parseFreeBusyResponse(provider, payload(provider, [...noise, ...windows, ...noise]), NOW);
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toEqual(windows.map(({ start, end }) => ({ startsAt: start, endsAt: end })));
  });

  it("finds a 501st valid window after ignored rows beyond the bound", () => {
    const windows = busyWindows(501);
    const parsed = parseFreeBusyResponse(provider, payload(provider, [
      ...windows.slice(0, 500), ...ignored, windows[500],
    ]), NOW);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("provider_error");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["google", "microsoft"])("%s calendar sync overflow", (provider) => {
  it("uses the connection-error path without replacing busy data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.stubEnv("VITE_SUPABASE_URL", "https://calendar-fixture.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "calendar-fixture");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-fixture");
    const cron = "cron-fixture-".repeat(4);
    vi.stubEnv("CRON_SECRET", cron);
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-fixture-".repeat(4));
    vi.stubEnv(`${provider.toUpperCase()}_CALENDAR_OAUTH_CLIENT_ID`, "client-fixture");
    vi.stubEnv(`${provider.toUpperCase()}_CALENDAR_OAUTH_CLIENT_SECRET`, "client-secret-fixture");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_TENANT", "organizations");
    const wrapped = encryptRefreshToken(process.env, "saas", "refresh-fixture");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes("list_steward_calendar_oauth_tokens")) return Response.json([{
        provider, refreshTokenCiphertext: wrapped, stewardId: "steward-fixture",
      }]);
      if (target.includes("/token")) return Response.json({ access_token: "access-fixture" });
      if (target.includes("/v1.0/me?")) return Response.json({ mail: "calendar@example.test" });
      if (target.includes("freeBusy") || target.includes("getSchedule")) return Response.json(payload(provider, busyWindows(501)));
      if (target.includes("set_calendar_busy") || target.includes("mark_calendar_connection_error")) return Response.json({ ok: true });
      throw new Error("Unexpected local fixture request");
    });
    vi.stubGlobal("fetch", fetcher);
    const response = {
      statusCode: 0, body: "",
      status(code) { this.statusCode = code; return this; },
      setHeader() {}, end(body) { this.body = body; },
    };
    await handler({ method: "POST", headers: { authorization: `Bearer ${cron}` } }, response);
    expect(response.statusCode).toBe(207);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, synced: 0, failed: 1 });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("set_calendar_busy"))).toBe(false);
    const errorCall = fetcher.mock.calls.find(([url]) => String(url).includes("mark_calendar_connection_error"));
    expect(errorCall).toBeDefined();
    expect(JSON.parse(errorCall[1].body)).toEqual({ p_steward: "steward-fixture", p_provider: provider });
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", { kind: "row_failed", provider, reason: "parse_failed" });
  });
});
