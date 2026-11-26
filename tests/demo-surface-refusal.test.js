// @vitest-environment node
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import acceptInvitation from "../api/accept-invitation.js";
import inviteRequest from "../api/invite-request.js";
import publicInterest from "../api/public-interest.js";
import publicInterestStop from "../api/public-interest-stop.js";
import publicInterestStopConfirm from "../api/public-interest-stop-confirm.js";
import notificationsDispatch from "../api/notifications-dispatch.js";
import openSignup from "../api/open-signup.js";
import openSignupConfirm from "../api/open-signup-confirm.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// Production-only endpoints must refuse on the SAMPLE (demo) surface rather
// than pair the SAMPLE project with production senders/origins. Notification
// dispatch has a separately authenticated SAMPLE push path, but a production
// CRON_SECRET call must still never reach that queue.
//
// Union Ground names no product host, so the SAMPLE surface is addressed
// the way the API helpers recognise it without one: a demo-surface build
// (VITE_APP_SURFACE=demo) answering on loopback.

const SAMPLE_HOST = "localhost:5173";
const SAMPLE_ORIGIN = "http://localhost:5173";

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = body ? JSON.parse(body) : null; },
  };
}

// Open signup is browser-only. On the SAMPLE surface a browser request gets
// the missing-route answer, and a caller with no Origin is refused before the
// surface gate is even consulted; neither reaches a network.
async function expectBearerOnlyRefused(handler, req, status, error) {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { origin: _origin, ...headers } = req.headers;
  const out = await run(handler, { ...req, headers });
  expect(out.status).toBe(status);
  expect(out.body).toEqual({ error });
  expect(fetchMock).not.toHaveBeenCalled();
}

async function run(handler, req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  // Fully configure the SAMPLE and production backends so the only thing that
  // stops these handlers is the demo-surface refusal, not a missing env.
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("VITE_APP_SURFACE", "demo");
  vi.stubEnv("SAMPLE_SUPABASE_URL", "https://sampleproject.supabase.co");
  vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
  vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sample-service");
  vi.stubEnv("INVITATION_APP_ORIGIN", SAMPLE_ORIGIN);
  vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "invitation-rate-secret-at-least-32-chars-long");
  vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", SAMPLE_ORIGIN);
  vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "public-interest-rate-secret-at-least-32-chars");
  vi.stubEnv("CRON_SECRET", "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx");
  vi.stubEnv("SAMPLE_NOTIFICATION_DISPATCH_SECRET", "sample-notification-dispatch-secret-value");
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.invalid>");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production-only endpoints refuse the SAMPLE surface", () => {
  it("accept-invitation refuses on the SAMPLE host without touching the SAMPLE project", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(acceptInvitation, {
      method: "POST",
      url: "/api/accept-invitation",
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN },
      body: { token: "x".repeat(43) },
    });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("public-interest refuses on the SAMPLE host without writing to the SAMPLE database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(publicInterest, {
      method: "POST",
      url: "/api/public-interest",
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
      body: { email: "a@b.co", name: "A", interest: "chapter_updates", locale: "en", website: "" },
    });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invite-request refuses on the SAMPLE host without sending mail", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(inviteRequest, {
      method: "POST",
      url: "/api/invite-request",
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN },
      body: { name: "Alex", email: "a@b.co", organization: "Local 12", locale: "en", website: "" },
    });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("public-interest stop refuses on the SAMPLE host without writing to the SAMPLE database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(publicInterestStop, {
      method: "POST",
      url: "/api/public-interest-stop",
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
      body: { email: "a@b.co", locale: "en", website: "" },
    });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("public-interest stop confirmation refuses on the SAMPLE host without writing to the SAMPLE database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(publicInterestStopConfirm, {
      method: "POST",
      url: "/api/public-interest-stop-confirm",
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
      body: { token: "stop-confirm-proof-".padEnd(43, "x") },
    });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The public chapter directory, its event RSVP and the organization claim
  // flow are left out of Union Ground: no such endpoint may be deployed.
  it.each([
    "api/public/event-rsvp.js",
    "api/public-page.js",
    "api/organization-claim.js",
    "api/organization-claim-confirm.js",
    "api/organization-claim-review.js",
  ])("does not ship the left-out endpoint %s", (path) => {
    expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(false);
  });

  it("notifications-dispatch refuses a production CRON_SECRET call to the SAMPLE push path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(notificationsDispatch, {
      method: "POST",
      url: "/api/notifications-dispatch",
      headers: { host: SAMPLE_HOST, authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" },
      body: {},
    });
    // The bearer is the deployment's real CRON_SECRET, so the refusal comes
    // from the provider boundary, not from the cron check.
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "not configured" });
    // The SAMPLE notification queue is never drained through production senders.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: the signup routes cannot
  // read the owner's switch from SAMPLE, so they answer as missing routes
  // there whatever the switch says, without touching any Auth project.
  it.each([
    ["open-signup", openSignup, { email: "person@example.invalid", acceptedTerms: true, turnstileToken: "token", locale: "en", website: "" }],
    ["open-signup-confirm", openSignupConfirm, { token: "v1.x", password: "a-long-enough-password", locale: "en" }],
  ])("%s answers as a missing route on the SAMPLE host without touching any Auth project", async (name, handler, body) => {
    vi.stubEnv("OPEN_SIGNUP_SECRET", "open-signup-secret-at-least-32-characters");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      method: "POST",
      url: `/api/${name}`,
      headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
      body,
    };
    const out = await run(handler, request);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-found" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expectBearerOnlyRefused(handler, request, 403, "not-permitted");
  });
});
