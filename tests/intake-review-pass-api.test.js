// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): POST /api/intake-review's organizations, pass and passes
// actions each turn into one service-only RPC with the caller's own operator
// id and session, behind the same stepped-up session checks as the queue
// (tests/intake-review-api.test.js). tests/intake-review-pass-db.test.js
// proves the RPCs.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/intake-review.js";
import { INVITE_REQUEST_PASS_PATH, intakeReviewFailure, intakeReviewPlan } from "../api/_lib/intakeReview.js";
import { USER_ID, bodyOf, callsTo, fetchRouter, jwt, reply, run, stubClaimEnv } from "./helpers/organization-claim-fixtures.js";
import { PORTAL_ORIGIN as ORIGIN, PORTAL_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

// Open stands in for a published, verified privacy release. Closed exercises
// the real server gate and baseline stamp, without mocking that refusal.
const legalGate = vi.hoisted(() => ({ open: false, paths: [] }));
vi.mock("../api/_lib/legalReleaseGate.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runVerifiedServerLegalOperation: async (config, path, operation, root) => {
      legalGate.paths.push(path);
      return legalGate.open
        ? { ran: true, plane: "server", reason: "released", result: operation() }
        : actual.runVerifiedServerLegalOperation(config, path, operation, root);
    },
  };
});

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const ROW_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const AAL2 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal2", role: "authenticated" });
const AAL1 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal1", role: "authenticated" });
const VERIFIED_USER = { id: USER_ID, factors: [{ id: "f1", factor_type: "totp", status: "verified" }] };

function request(body, { token = AAL2 } = {}) {
  return {
    method: "POST",
    url: "/api/intake-review",
    headers: { host: PORTAL_HOST, origin: ORIGIN, authorization: `Bearer ${token}` },
    body,
  };
}

const rest = (fetcher) => fetcher.mock.calls.filter(([url]) => String(url).includes("/rest/v1/"));

beforeEach(() => {
  stubClaimEnv({ PUBLIC_SITE_APP_ORIGIN: ORIGIN });
  legalGate.open = true;
  legalGate.paths = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/intake-review pass actions", () => {
  it("packages the privacy release evidence with both intake endpoints", () => {
    const { functions } = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(functions["api/intake-review.js"].includeFiles).toBe(functions["api/invite-request.js"].includeFiles);
  });

  it("refuses sharing on the unpublished privacy path before any pass RPC, even with a forced environment flag", async () => {
    legalGate.open = false;
    vi.stubEnv("LEGAL_RELEASE_FORCE", "1");
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), pass_intake_invite_request: reply({ passed: true }) });
    expect(await run(handler, request({ action: "pass", id: ROW_ID, organizationId: ORG_ID })))
      .toMatchObject({ status: 200, body: { result: { passed: false, refusal: "privacy-not-released" } } });
    expect(legalGate.paths).toEqual([INVITE_REQUEST_PASS_PATH]);
    expect(callsTo(fetcher, "pass_intake_invite_request")).toHaveLength(0);
    expect(rest(fetcher)).toHaveLength(0);
  });

  it.each([
    ["organizations", { search: "  Example Work " }, "search_intake_pass_organizations", { p_prefix: "Example Work" }],
    ["pass", { id: ROW_ID, organizationId: ORG_ID }, "pass_intake_invite_request", { p_id: ROW_ID, p_organization_id: ORG_ID }],
    ["passes", { ids: [ROW_ID, ROW_ID.toUpperCase(), FOREIGN] }, "list_intake_request_passes", { p_ids: [ROW_ID, FOREIGN] }],
  ])("%s calls %s as the caller's own session, ignoring operator ids in the body", async (action, fields, rpc, args) => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), [rpc]: reply({ ok: true }) });
    const out = await run(handler, request({ action, ...fields, p_operator_user_id: FOREIGN, p_operator_session_id: FOREIGN }));
    expect(out).toMatchObject({ status: 200, body: { result: { ok: true } } });
    const [call] = callsTo(fetcher, rpc);
    expect(bodyOf(call)).toEqual({ p_operator_user_id: USER_ID, p_operator_session_id: SESSION_ID, ...args });
    expect(rest(fetcher)).toHaveLength(1);
  });

  it("refuses an aal1 session before the pass reaches the database", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect(await run(handler, request({ action: "pass", id: ROW_ID, organizationId: ORG_ID }, { token: AAL1 })))
      .toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(rest(fetcher)).toHaveLength(0);
  });

  it("answers 403 when the database says the caller is not an intake reviewer, and a pass refusal as the RPC's own answer", async () => {
    fetchRouter({ user: reply(VERIFIED_USER), pass_intake_invite_request: reply({ code: "42501", message: "intake reviewer required" }, 403) });
    expect(await run(handler, request({ action: "pass", id: ROW_ID, organizationId: ORG_ID }))).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    fetchRouter({ user: reply(VERIFIED_USER), pass_intake_invite_request: reply({ passed: false, refusal: "stopped" }) });
    expect(await run(handler, request({ action: "pass", id: ROW_ID, organizationId: ORG_ID })))
      .toMatchObject({ status: 200, body: { result: { passed: false, refusal: "stopped" } } });
  });
});

describe("intakeReviewPlan pass actions", () => {
  it.each([
    ["a one-letter search", { action: "organizations", search: " a " }],
    ["a search that is not text", { action: "organizations", search: 12 }],
    ["a long search", { action: "organizations", search: "x".repeat(121) }],
    ["a search with a control character", { action: "organizations", search: "ab\u0007" }],
    ["a pass without an organization", { action: "pass", id: ROW_ID }],
    ["a pass to an organization that is not an id", { action: "pass", id: ROW_ID, organizationId: "Example Workers" }],
    ["a pass without a request", { action: "pass", organizationId: ORG_ID }],
    ["no ids", { action: "passes", ids: [] }],
    ["ids that are not a list", { action: "passes", ids: ROW_ID }],
    ["a bad id", { action: "passes", ids: [ROW_ID, "x"] }],
    ["more than 100 ids", { action: "passes", ids: Array.from({ length: 101 }, () => ROW_ID) }],
  ])("refuses %s", (_label, body) => {
    expect(intakeReviewPlan(body, USER_ID)).toBeNull();
  });

  it("maps the new input refusals to stable reasons", () => {
    expect(intakeReviewFailure({ code: "22023", detail: "organization id required" }).body).toEqual({ error: "refused", reason: "invalid-organization" });
    expect(intakeReviewFailure({ code: "22023", detail: "invalid request ids" }).body).toEqual({ error: "refused", reason: "invalid-request" });
  });
});
