// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118:
// POST /api/intake-review turns one operator action into one service-only RPC,
// only for a GoTrue-validated aal2 session with a verified factor, carrying
// the caller's own id and session and nothing the body names. The database
// verdict decides the rest. tests/intake-review-db.test.js proves the RPCs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/intake-review.js";
import { intakeReviewPlan } from "../api/_lib/intakeReview.js";
import { USER_ID, bodyOf, callsTo, fetchRouter, jwt, reply, run, stubClaimEnv } from "./helpers/organization-claim-fixtures.js";
import { PORTAL_ORIGIN as ORIGIN, PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const ROW_ID = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const AAL2 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal2", role: "authenticated" });
const AAL1 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal1", role: "authenticated" });
const VERIFIED_USER = { id: USER_ID, factors: [{ id: "f1", factor_type: "totp", status: "verified" }] };

function request(body, { token = AAL2, ...overrides } = {}) {
  return {
    method: "POST",
    url: "/api/intake-review",
    headers: { host: PORTAL_HOST, origin: ORIGIN, authorization: `Bearer ${token}` },
    body,
    ...overrides,
  };
}

const rest = (fetcher) => fetcher.mock.calls.filter(([url]) => String(url).includes("/rest/v1/"));

beforeEach(() => stubClaimEnv({ PUBLIC_SITE_APP_ORIGIN: ORIGIN }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/intake-review", () => {
  it.each([
    ["summary", {}, "intake_request_summary", { p_operator_user_id: USER_ID }],
    ["list", { kind: "invite", status: "new", search: "  local 12 ", limit: 25 }, "list_intake_requests",
      { p_kind: "invite", p_status: "new", p_search: "local 12", p_before: null, p_before_id: null, p_limit: 25 }],
    ["list", { before: "2026-11-18T15:00:00.123456+00:00", beforeId: ROW_ID }, "list_intake_requests",
      { p_kind: null, p_status: null, p_search: null, p_before: "2026-11-18T15:00:00.123456+00:00", p_before_id: ROW_ID, p_limit: 50 }],
    ["export", { kind: "updates" }, "export_intake_requests", { p_kind: "updates", p_status: null, p_search: null }],
    ["status", { id: ROW_ID, status: "invited", expectedStatus: "contacted" }, "set_intake_request_status",
      { p_id: ROW_ID, p_status: "invited", p_expected_status: "contacted" }],
    ["note", { id: ROW_ID, note: "  Call back\r\nMonday " }, "set_intake_request_note", { p_id: ROW_ID, p_note: "Call back\nMonday" }],
  ])("%s calls %s as the caller's own session, ignoring operator ids in the body", async (action, fields, rpc, args) => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), [rpc]: reply({ ok: true }) });
    const out = await run(handler, request({
      action, ...fields, operatorUserId: FOREIGN, p_operator_user_id: FOREIGN, p_operator_session_id: FOREIGN,
    }));
    expect(out).toMatchObject({ status: 200, body: { result: { ok: true } } });
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    const [call] = callsTo(fetcher, rpc);
    expect(bodyOf(call)).toEqual({ p_operator_user_id: USER_ID, p_operator_session_id: SESSION_ID, ...args });
    expect(rest(fetcher)).toHaveLength(1);
  });

  it("refuses an aal1 session, an account without a verified factor and a token without a session before any RPC", async () => {
    let fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect(await run(handler, request({ action: "summary" }, { token: AAL1 }))).toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(rest(fetcher)).toHaveLength(0);
    fetcher = fetchRouter({ user: reply({ id: USER_ID, factors: [{ status: "unverified" }] }) });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(rest(fetcher)).toHaveLength(0);
    fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    const noSession = jwt({ sub: USER_ID, aal: "aal2", role: "authenticated" });
    expect(await run(handler, request({ action: "summary" }, { token: noSession }))).toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(rest(fetcher)).toHaveLength(0);
  });

  it("accepts a verified-key session without a TOTP factor", async () => {
    const token = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal2", role: "authenticated", ug_key_uv: true });
    fetchRouter({ user: reply({ id: USER_ID, factors: [] }), intake_request_summary: reply({ counts: [] }) });
    expect(await run(handler, request({ action: "summary" }, { token }))).toMatchObject({ status: 200 });
  });

  it("answers 401 for a missing or rejected token and 503 when GoTrue is unavailable", async () => {
    fetchRouter({ user: reply(VERIFIED_USER) });
    const bare = request({ action: "summary" });
    delete bare.headers.authorization;
    expect(await run(handler, bare)).toMatchObject({ status: 401, body: { error: "unauthenticated" } });
    fetchRouter({ user: reply({ message: "bad jwt" }, 401) });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 401 });
    fetchRouter({ user: reply({ message: "down" }, 502) });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 503, body: { error: "review-unavailable" } });
  });

  it("maps the database verdicts: not an intake reviewer, a refusal, and anything else", async () => {
    fetchRouter({ user: reply(VERIFIED_USER), intake_request_summary: reply({ code: "42501", message: "intake reviewer required" }, 403) });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    fetchRouter({ user: reply(VERIFIED_USER), intake_request_summary: reply({ code: "42501", message: "service role required" }, 403) });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 503, body: { error: "review-unavailable" } });
    fetchRouter({ user: reply(VERIFIED_USER), set_intake_request_note: reply({ code: "22023", message: "invalid note" }, 400) });
    expect(await run(handler, request({ action: "note", id: ROW_ID, note: "x" }))).toMatchObject({ status: 409, body: { error: "refused", reason: "invalid-note" } });
    fetchRouter({ user: reply(VERIFIED_USER), intake_request_summary: new Error("network") });
    expect(await run(handler, request({ action: "summary" }))).toMatchObject({ status: 503 });
  });

  it("refuses untrusted origins, other methods, query strings and the SAMPLE demo without touching a database", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect((await run(handler, request({ action: "summary" }, { headers: { host: PORTAL_HOST, origin: "https://evil.example", authorization: `Bearer ${AAL2}` } }))).status).toBe(403);
    expect((await run(handler, request({ action: "summary" }, { method: "GET" }))).status).toBe(405);
    expect((await run(handler, request({ action: "summary" }, { url: "/api/intake-review?x=1" }))).status).toBe(400);
    expect(await run(handler, request({ action: "summary" }, { headers: { host: SAMPLE_HOST, authorization: `Bearer ${AAL2}` } })))
      .toMatchObject({ status: 404, body: { error: "not-available" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("answers 400 for a body the plan refuses, after authentication and before any RPC", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect(await run(handler, request({ action: "delete", id: ROW_ID }))).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(rest(fetcher)).toHaveLength(0);
  });
});

describe("intakeReviewPlan", () => {
  it.each([
    ["an unknown kind", { action: "list", kind: "tenant" }],
    ["an unknown status", { action: "list", status: "done" }],
    ["a control character in search", { action: "list", search: "a\u0007" }],
    ["a long search", { action: "list", search: "x".repeat(121) }],
    ["half a cursor", { action: "list", before: "2026-11-18T15:00:00Z" }],
    ["a cursor that is not an instant", { action: "list", before: "yesterday", beforeId: ROW_ID }],
    ["a page too large", { action: "list", limit: 101 }],
    ["a fractional page", { action: "list", limit: 2.5 }],
    ["a status without an id", { action: "status", status: "new" }],
    ["an unknown target status", { action: "status", id: ROW_ID, status: "done" }],
    ["an unknown expected status", { action: "status", id: ROW_ID, status: "new", expectedStatus: "done" }],
    ["a note that is not text", { action: "note", id: ROW_ID, note: 5 }],
    ["a note too long", { action: "note", id: ROW_ID, note: "x".repeat(2001) }],
    ["a note with a control character", { action: "note", id: ROW_ID, note: "bell\u0007" }],
    ["a note with a C1 control character", { action: "note", id: ROW_ID, note: "call\u0085back" }],
    ["a C1 control character in search", { action: "list", search: "a\u009f" }],
  ])("refuses %s", (_label, body) => {
    expect(intakeReviewPlan(body, USER_ID)).toBeNull();
  });

  it("refuses without a valid operator id and keeps an empty note as a clear", () => {
    expect(intakeReviewPlan({ action: "summary" }, "not-a-uuid")).toBeNull();
    expect(intakeReviewPlan({ action: "note", id: ROW_ID, note: null }, USER_ID).args.p_note).toBe("");
  });
});
