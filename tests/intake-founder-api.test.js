// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/intake-review.js";
import { runVerifiedServerLegalOperation } from "../api/_lib/legalReleaseGate.js";
import { INTAKE_FOUNDER_PATH } from "../api/_lib/intakeFounderInvitation.js";
import { USER_ID, bodyOf, callsTo, fetchRouter, jwt, reply, run, stubClaimEnv } from "./helpers/organization-claim-fixtures.js";
import { PORTAL_ORIGIN as ORIGIN, PORTAL_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const gate = vi.hoisted(() => ({ live: true }));
vi.mock("../api/_lib/legalReleaseGate.js", async (original) => {
  const actual = await original();
  return { ...actual, runVerifiedServerLegalOperation: async (config, path, operation) => gate.live
    ? { ran: true, result: operation() } : actual.runVerifiedServerLegalOperation(config, path, operation) };
});
const SESSION = "12345678-1234-4234-8234-123456789abc";
const ROW = "33333333-3333-4333-8333-333333333333";
const INVITATION = "44444444-4444-4444-8444-444444444444";
const EXPIRES = "2099-01-01T00:00:00Z";
const SENT = "2026-11-20T20:00:00Z";
const USER = { id: USER_ID, factors: [{ status: "verified" }] };
const fields = { action: "founder", id: ROW, organizationName: " Fictional Intake Union ", fullName: " Alex Fixtureperson " };
const issued = { invited: true, repeated: false, send: true, normalizedEmail: "founder@example.invalid", locale: "en",
  invitationId: INVITATION, organizationId: ROW, deliveryVersion: 1, expiresAt: "2026-11-20T10:00:00Z",
  request: { id: ROW, kind: "join", status: "invited", founderInvitation: { id: INVITATION, status: "pending" } } };
function request(body = fields, aal = "aal2") {
  return { method: "POST", url: "/api/intake-review", body,
    headers: { host: PORTAL_HOST, origin: ORIGIN, authorization: `Bearer ${jwt({ sub: USER_ID, session_id: SESSION, aal, role: "authenticated" })}` } };
}
function routes(extra = {}) {
  return fetchRouter({ user: reply(USER), create_intake_founder_invitation: reply(issued),
    record_organization_founder_invitation_delivery: (init) => reply({ recorded: true, invitation: {
      id: INVITATION, status: JSON.parse(init.body).p_outcome === "sent" ? "pending" : "delivery_failed",
      expiresAt: EXPIRES, sentAt: JSON.parse(init.body).p_outcome === "sent" ? SENT : null,
    } }), ...extra });
}
beforeEach(() => { gate.live = true; stubClaimEnv({ INVITATION_APP_ORIGIN: ORIGIN }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("founder invitation from a join row", () => {
  it("returns only the recorder's persisted delivery fields after a successful send", async () => {
    routes({ record_organization_founder_invitation_delivery: reply({ recorded: true, invitation: {
      id: INVITATION, status: "pending", expiresAt: EXPIRES, sentAt: SENT,
      full_name: "Must not escape", normalized_email: "private@example.invalid", token_hash: "private-token",
    } }) });
    const out = await run(handler, request());
    expect(out.body.result.delivery).toBe("sent");
    expect(out.body.result.request.founderInvitation).toEqual({ id: INVITATION, status: "pending", expiresAt: EXPIRES, sentAt: SENT });
    expect(JSON.stringify(out.body)).not.toMatch(/Must not escape|private@example|private-token/);
  });
  it.each([
    { recorded: true },
    { recorded: true, invitation: { id: INVITATION, status: "pending", expiresAt: EXPIRES, sentAt: null } },
    { recorded: true, invitation: { id: ROW, status: "pending", expiresAt: EXPIRES, sentAt: SENT } },
  ])("does not claim a recorded send without authoritative fields for that invitation (%j)", async (receipt) => {
    routes({ record_organization_founder_invitation_delivery: reply(receipt) });
    expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { delivery: "unknown" } } });
  });
  it("uses the caller's session, typed name, server secret and row's email, then records delivery without disclosing recipient or secret", async () => {
    const fetcher = routes();
    const out = await run(handler, request({ ...fields, email: "attacker@example.invalid", p_operator_user_id: ROW }));
    expect(out).toMatchObject({ status: 200, body: { result: { invited: true, delivery: "sent", invitationId: INVITATION, request: { status: "invited" } } } });
    expect(bodyOf(callsTo(fetcher, "create_intake_founder_invitation")[0])).toEqual({
      p_operator_user_id: USER_ID, p_operator_session_id: SESSION, p_id: ROW,
      p_organization_name: "Fictional Intake Union", p_full_name: "Alex Fixtureperson", p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const mail = bodyOf(callsTo(fetcher, "resend")[0]);
    expect(mail.to).toEqual(["founder@example.invalid"]);
    expect(bodyOf(callsTo(fetcher, "record_organization_founder_invitation_delivery")[0])).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 1, p_outcome: "sent" });
    expect(JSON.stringify(out.body)).not.toMatch(/normalizedEmail|token_hash|founder@example|Alex Fixtureperson/);
  });
  it("refuses the pending name-collection path before any database write or email", async () => {
    gate.live = false;
    const fetcher = routes();
    expect(await run(handler, request())).toMatchObject({ status: 409, body: { error: "refused", reason: "legal-release-pending" } });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(0);
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
    const operation = vi.fn();
    expect(await runVerifiedServerLegalOperation({}, INTAKE_FOUNDER_PATH, operation)).toMatchObject({ ran: false, reason: "pending-release" });
    // The rebased bundle must retain #9159's separate sharing disclosure too.
    expect(await runVerifiedServerLegalOperation({}, "invite-request-pass", operation)).toMatchObject({ ran: false, reason: "pending-release" });
    expect(operation).not.toHaveBeenCalled();
  });
  it.each(["", "x", "x".repeat(121), "Alex\u0007"])("refuses invalid founder name %j before writing", async (fullName) => {
    const fetcher = routes();
    expect(await run(handler, request({ ...fields, fullName }))).toMatchObject({ status: 400 });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(0);
  });
  it("refuses a non-aal2 session and a non-operator, and never sends on a database refusal or duplicate", async () => {
    let fetcher = routes();
    expect(await run(handler, request(fields, "aal1"))).toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(0);
    routes({ create_intake_founder_invitation: reply({ code: "42501", message: "intake reviewer required" }, 403) });
    expect(await run(handler, request())).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    for (const result of [{ invited: false, refusal: "stopped" }, { ...issued, repeated: true, send: false }]) {
      fetcher = routes({ create_intake_founder_invitation: reply(result) });
      expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { invited: result.invited } } });
      expect(callsTo(fetcher, "resend")).toHaveLength(0);
    }
  });
  it("returns a dedicated phone-number refusal without sending or exposing the database message", async () => {
    const fetcher = routes({ create_intake_founder_invitation: reply({ code: "22023", message: "invalid founder invitation",
      details: "organization name holds a phone number" }, 400) });
    expect(await run(handler, request())).toMatchObject({ status: 409, body: { error: "refused", reason: "organization-name-phone" } });
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
  });
  it("reports mail refusal and a missing delivery receipt honestly, without creating another invitation", async () => {
    let fetcher = routes({ resend: reply({ error: "unavailable" }, 503) });
    expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { invited: true, delivery: "failed",
      request: { founderInvitation: { status: "delivery_failed" } } } } });
    expect(bodyOf(callsTo(fetcher, "record_organization_founder_invitation_delivery")[0]).p_outcome).toBe("failed");
    fetcher = routes({ record_organization_founder_invitation_delivery: new Error("offline") });
    expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { invited: true, delivery: "unknown" } } });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(1);
  });
  it("refuses missing mail configuration before creating an invitation", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetcher = routes();
    expect(await run(handler, request())).toMatchObject({ status: 503 });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(0);
  });
  it("records a thrown provider failure and reports an obsolete delivery receipt as unknown", async () => {
    let fetcher = routes({ resend: new Error("offline") });
    expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { delivery: "failed" } } });
    expect(bodyOf(callsTo(fetcher, "record_organization_founder_invitation_delivery")[0]).p_outcome).toBe("failed");
    fetcher = routes({ record_organization_founder_invitation_delivery: reply({ recorded: false }) });
    expect(await run(handler, request())).toMatchObject({ status: 200, body: { result: { delivery: "unknown" } } });
    expect(callsTo(fetcher, "create_intake_founder_invitation")).toHaveLength(1);
  });
});
