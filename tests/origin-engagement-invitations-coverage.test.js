// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import engagement from "../api/engagement-delivery.js";
import invitations from "../api/admin-invitations.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));
import { vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

const ID = "10000000-0000-4000-8000-000000000001";
const origin = PORTAL_ORIGIN;
const create = { action: "create", email: "member@example.test", fullName: "Test Member", chapterId: "test-chapter", locale: "en", initialRole: "member" };
const upstream = (value, status = 200) => ({ ok: status < 300, status, json: async () => value, text: async () => JSON.stringify(value) });
const post = (body, headers = {}) => ({ method: "POST", body, headers: { host: PORTAL_HOST, origin, authorization: "Bearer test-member", ...headers } });
const cron = () => ({ method: "GET", headers: { host: PORTAL_HOST, ...vercelCronTickHeaders("cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", "*/15 * * * *") } });
const statusRequest = (headers = {}) => ({ method: "GET", query: { status: "1" }, headers: { host: PORTAL_HOST, authorization: "Bearer test-member", ...headers } });
async function run(handler, request) {
  const out = { status: 0, body: null };
  await handler(request, { status(value) { out.status = value; return this; }, setHeader() {}, end(value) { out.body = JSON.parse(value); } });
  return out;
}
let unexpectedRequests;
function network(routes) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const name = String(url).split("/").at(-1);
    calls.push({ name, url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    if (!(name in routes)) {
      unexpectedRequests.push(String(url));
      throw new Error(`Unexpected external request: ${url}`);
    }
    const value = routes[name];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(calls.at(-1)) : value;
  }));
  return calls;
}
beforeEach(() => {
  unexpectedRequests = [];
  for (const [key, value] of Object.entries({ VITE_SUPABASE_URL: "https://project.supabase.co", UNIONGROUND_SUPABASE_PROJECT_REF: "project", VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service", CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", ENGAGEMENT_EMAIL_WEBHOOK_URL: "https://mail.example.test/send", ENGAGEMENT_EMAIL_WEBHOOK_TOKEN: "test-provider", RESEND_API_KEY: "test-resend", NOTIFY_FROM_ADDRESS: "test@example.test", INVITATION_APP_ORIGIN: origin })) vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // A handler may catch fetch errors; unexpected egress must still fail the test.
  expect(unexpectedRequests).toEqual([]);
});

describe("engagement delivery boundaries and recovery", () => {
  it.each([
    [post({}, { origin: "https://attacker.example" }), 403, "untrusted-origin"],
    [post({}), 405, "Method not allowed."],
    [statusRequest({ authorization: "" }), 401, "Sign in to view delivery status."],
  ])("refuses invalid request before external access %#", async (request, status, error) => {
    const calls = network({});
    expect(await run(engagement, request)).toEqual({ status, body: { error } });
    expect(calls).toEqual([]);
  });
  it.each([upstream({}, 401), new Error("offline")])("requires a current staff identity for status %#", async (auth) => {
    const calls = network({ user: auth });
    expect(await run(engagement, statusRequest())).toEqual({ status: 401, body: { error: "Your session expired. Sign in again." } });
    expect(calls.map(c => c.name)).toEqual(["user"]);
  });
  it("refuses a member's status request before disclosing provider setup", async () => {
    network({ user: upstream({ id: ID }), authorize_engagement_staff: upstream({}, 403) });
    expect(await run(engagement, statusRequest())).toEqual({ status: 403, body: { error: "A staff role is required." } });
  });
  // PERF-UG-ENGAGEMENT-STAFF-GATE-RUNS-THE-WHOLE-SNAPSHOT-20260920: the gate
  // answers the role question only. A status request that reached for
  // get_staff_engagement_snapshot would build every survey, poll, task, review
  // and briefing first; network() has no route for it, so it fails here.
  it.each([true, false])("reports optional provider activation to staff without building the staff snapshot: %s", async (configured) => {
    if (!configured) vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_URL", "");
    const calls = network({ user: upstream({ id: ID }), authorize_engagement_staff: upstream(true) });
    expect(await run(engagement, statusRequest())).toEqual({ status: 200, body: { configured, provider: configured ? "webhook" : null, required: ["ENGAGEMENT_EMAIL_WEBHOOK_URL", "ENGAGEMENT_EMAIL_WEBHOOK_TOKEN"] } });
    expect(calls.map(c => c.name)).toEqual(["user", "authorize_engagement_staff"]);
    expect(calls[1].init.headers.Authorization).toBe("Bearer test-member");
  });
  it("refuses cron before leasing when backend credentials are absent", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const calls = network({});
    expect(await run(engagement, cron())).toEqual({ status: 503, body: { error: "Delivery backend is not configured." } });
    expect(calls).toEqual([]);
  });
  it("reports a failed claim without attempting deliveries", async () => {
    const calls = network({ claim_engagement_delivery_batch: upstream({}, 500) });
    expect(await run(engagement, cron())).toEqual({ status: 503, body: { error: "Delivery queue is unavailable." } });
    expect(calls).toHaveLength(1);
  });
  it.each([
    [false, null, "payload_unavailable"],
    [true, upstream({}, 503), "provider_5xx"],
    [true, Object.assign(new Error("private provider error"), { code: "private@example.test" }), "provider_unavailable"],
  ])("records bounded retry failures and tolerates failure-record outages %#", async (available, provider, errorCode) => {
    let claims = 0;
    const calls = network({
      // A failed outcome write leaves the row leased, so the next just-in-time
      // claim must not return that same row while its lease is still active.
      claim_engagement_delivery_batch: () => upstream(claims++ === 0 ? [{ id: ID, deliveryKind: "broadcast" }] : []),
      get_engagement_delivery_payload: upstream({
        available, email: "private@example.test", body: "private content", subject: "Private", locale: "en", path: "/m/messages",
        category: "announcements", unsubscribeToken: `${ID}.announcements.1790000000.${"A".repeat(43)}`,
      }),
      send: provider,
      complete_engagement_delivery: upstream({}, 503),
    });
    expect(await run(engagement, cron())).toEqual({ status: 503, body: { claimed: 1, sent: 0, failed: 1, suppressed: 0 } });
    const claim = calls[0].body;
    expect(claim).toMatchObject({ p_lease_token: expect.any(String), p_limit: 1, p_lease_seconds: 240 });
    const outcomes = calls.filter(c => c.name === "complete_engagement_delivery");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].body).toEqual({ p_delivery_id: ID, p_lease_token: claim.p_lease_token, p_success: false, p_error_code: errorCode, p_retry_after_seconds: 300 });
    expect(calls.filter(c => c.name === "claim_engagement_delivery_batch")).toHaveLength(2);
    expect(calls.filter(c => c.name === "get_engagement_delivery_payload")).toHaveLength(1);
    expect(calls.filter(c => c.name === "send")).toHaveLength(available ? 1 : 0);
  });
  it("retains completed counts when a later just-in-time claim fails", async () => {
    let claims = 0;
    const calls = network({
      claim_engagement_delivery_batch: () => claims++ === 0
        ? upstream([{ id: ID, deliveryKind: "broadcast" }]) : upstream({}, 500),
      get_engagement_delivery_payload: upstream({ available: true, email: "private@example.test", body: "private content", subject: "Private", locale: "en", path: "/m/messages", category: "announcements", unsubscribeToken: `${ID}.announcements.1790000000.${"A".repeat(43)}` }),
      send: upstream({}),
      complete_engagement_delivery: upstream({ state: "sent" }),
    });
    expect(await run(engagement, cron())).toEqual({ status: 503, body: { claimed: 1, sent: 1, failed: 0, suppressed: 0, error: "Delivery queue is unavailable." } });
    expect(calls.map(c => c.name)).toEqual(["claim_engagement_delivery_batch", "get_engagement_delivery_payload", "send", "complete_engagement_delivery", "claim_engagement_delivery_batch"]);
  });
});

describe("invitation validation and durable delivery failures", () => {
  it("still requires a bearer after accepting a same-origin browser request", async () => {
    const calls = network({});
    expect(await run(invitations, post(create, { authorization: "" }))).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(calls).toEqual([]);
  });
  it.each(["VITE_SUPABASE_URL", "RESEND_API_KEY", "INVITATION_APP_ORIGIN"])("fails closed with missing %s", async (key) => {
    vi.stubEnv(key, "");
    const calls = network({});
    expect(await run(invitations, post(create))).toEqual({ status: 503, body: { error: "not-configured" } });
    expect(calls).toEqual([]);
  });
  it.each(["not a URL", `${PORTAL_ORIGIN}/path`])("rejects invalid invitation origin %s", async (value) => {
    vi.stubEnv("INVITATION_APP_ORIGIN", value);
    const calls = network({});
    expect(await run(invitations, post(create))).toEqual({ status: 503, body: { error: "not-configured" } });
    expect(calls).toEqual([]);
  });
  it.each([
    "malformed", "null", {}, { action: "unknown" },
    { ...create, email: "invalid" }, { ...create, fullName: "A" }, { ...create, fullName: "Bad\nName" },
    { ...create, chapterId: "!invalid" }, { ...create, initialRole: "owner" }, { ...create, locale: "fr" },
    { action: "revoke", invitationId: "bad" }, { action: "resend", invitationId: "bad" },
  ])("rejects invalid input without minting or sending an invitation %#", async (body) => {
    const calls = network({});
    expect(await run(invitations, post(body))).toEqual({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toEqual([]);
  });
  it.each([[401, 403, "not-permitted"], [403, 403, "not-permitted"], [400, 400, "request-unavailable"], [422, 400, "request-unavailable"], [500, 503, "service-unavailable"]])("maps revoke failure %s without exposing the invitation's existence", async (upstreamStatus, status, error) => {
    const calls = network({ revoke_member_invitation: upstream({ privateDetail: "hidden" }, upstreamStatus) });
    expect(await run(invitations, post({ action: "revoke", invitationId: ID }))).toEqual({ status, body: { error } });
    expect(calls).toHaveLength(1);
  });
  it("accepts a replay without sending again", async () => {
    const calls = network({ create_member_invitation: upstream({ send: false }) });
    expect(await run(invitations, post(JSON.stringify(create)))).toEqual({ status: 202, body: { accepted: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ p_initial_role: null, p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("rejects a resend recipient with a malformed server email before provider access", async () => {
    const calls = network({ resend_member_invitation: upstream({ send: true, normalizedEmail: "bad" }) });
    expect(await run(invitations, post({ action: "resend", invitationId: ID }))).toEqual({ status: 503, body: { error: "service-unavailable" } });
    expect(calls).toHaveLength(1);
  });
  it.each([[new Error("offline"), 200, 502, "delivery-unavailable", "failed"], [upstream({}), 500, 503, "delivery-status-unavailable", "sent"]])("reports provider and recording failures honestly %#", async (provider, recordStatus, status, error, outcome) => {
    const calls = network({
      create_member_invitation: upstream({ send: true, invitationId: ID, deliveryVersion: 3 }),
      user: upstream({ id: ID }),
      [`member_profiles?select=full_name,chapters(organizations!chapters_organization_id_fkey(name))&id=eq.${ID}&limit=1`]: upstream([
        { full_name: "Alex Rivera", chapters: { organizations: { name: "Example Workers" } } },
      ]),
      emails: provider,
      record_member_invitation_delivery: upstream({}, recordStatus),
    });
    expect(await run(invitations, post(create))).toEqual({ status, body: { error } });
    expect(calls.at(-1).body).toEqual({ p_invitation_id: ID, p_delivery_version: 3, p_outcome: outcome });
    expect(calls.find(c => c.name === "emails").init.headers["Idempotency-Key"]).toBe(`sg-invite-${ID}-3`);
  });

  it("uses trusted caller names rather than names supplied in the request", async () => {
    const calls = network({
      create_member_invitation: upstream({ send: true, invitationId: ID, deliveryVersion: 1 }),
      user: upstream({ id: ID }),
      [`member_profiles?select=full_name,chapters(organizations!chapters_organization_id_fkey(name))&id=eq.${ID}&limit=1`]: upstream([
        { full_name: "Alex Rivera", chapters: { organizations: { name: "Example Workers" } } },
      ]),
      emails: upstream({}), record_member_invitation_delivery: upstream({}),
    });
    expect((await run(invitations, post({ ...create, organization: "Forged organization", inviter: "forged@example.test" }))).status).toBe(202);
    const mail = calls.find(c => c.name === "emails").body;
    expect(mail.subject).toContain("Example Workers");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Alex Rivera");
      expect(body).not.toContain("Forged organization");
      expect(body).not.toContain("forged@example.test");
    }
  });

  it("records failure without mailing when the caller's organization cannot be read", async () => {
    const calls = network({
      create_member_invitation: upstream({ send: true, invitationId: ID, deliveryVersion: 1 }),
      user: upstream({ id: ID }),
      [`member_profiles?select=full_name,chapters(organizations!chapters_organization_id_fkey(name))&id=eq.${ID}&limit=1`]: upstream([], 503),
      record_member_invitation_delivery: upstream({}),
    });
    expect(await run(invitations, post(create))).toEqual({ status: 502, body: { error: "delivery-unavailable" } });
    expect(calls.at(-1).body.p_outcome).toBe("failed");
    expect(calls.some(c => c.name === "emails")).toBe(false);
  });
});
