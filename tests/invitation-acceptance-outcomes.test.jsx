import { createHash } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/accept-invitation.js";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { PORTAL_ORIGIN, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/emailLinkHosts.js", async () => (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());

const ORIGIN = PORTAL_ORIGIN;
const BACKEND = SUPABASE_ORIGIN;
const TOKEN = "A".repeat(43);
const INVITATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const invitation = {
  available: true, invitationId: INVITATION_ID, normalizedEmail: "fixture@example.com",
  fullName: "Test Invitee", firstName: "Test", initials: "TI", chapterId: "test-chapter", locale: "en",
};
const user = {
  id: USER_ID, email: invitation.normalizedEmail,
  user_metadata: { union_base_invitation_id: INVITATION_ID, chapter_id: invitation.chapterId },
  app_metadata: { union_ground_provisioning: "pending" },
};
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => payload, text: async () => JSON.stringify(payload),
});

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", BACKEND);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  vi.stubEnv("INVITATION_APP_ORIGIN", ORIGIN);
  vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "test-rate-secret-at-least-32-characters");
  vi.stubEnv("RESEND_API_KEY", "test-mail-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <test@example.com>");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Only provider boundaries are faked. The real view posts to the real handler,
// which still performs its rate limit, claim, failure and recovery decisions.
function mountFlow({ failAt, mark = "recorded", lang = "en", recover = false } = {}) {
  let attempts = 0;
  const calls = [];
  const replies = [];
  const fetchUpstream = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    const name = path.split("/").at(-1);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, name, method: init.method, body });
    if (name === "consume_member_invitation_accept_limit_for_token") {
      attempts += 1;
      if (failAt === "preclaim" && attempts === 1) return response({ error: "down" }, 503);
      return response({ allowed: true });
    }
    // The handler asks whether the state-scoped acceptance writer is installed
    // before it claims anything (20261016170000).
    if (name === "legal_acceptance_pack_ready") return response(failAt !== "not-ready");
    if (name === "claim_member_invitation") {
      if (recover && attempts === 2) return response({ available: false, cause: "acceptance-in-progress", retryAfterSeconds: 2 });
      return response({ ...invitation, recovery: recover && attempts > 2 });
    }
    if (name === "get_member_invitation_recovery_user") return response({ found: true, userId: USER_ID, provisioning: "pending" });
    if (path === "/auth/v1/admin/users") {
      if (attempts === 1) {
        if (failAt === "auth-denied") return response({ error: "private-provider-detail" }, 422);
        if (failAt === "auth-network") throw new TypeError("private-provider-detail");
        if (failAt === "auth-503") return response({ error: "private-provider-detail" }, 503);
        if (failAt === "auth-408") return response({ error: "private-provider-detail" }, 408);
        if (failAt === "auth-429") return response({ error: "private-provider-detail" }, 429);
        if (failAt === "auth-json") return { ok: true, status: 200, json: async () => { throw new SyntaxError("private-provider-detail"); } };
        if (failAt === "auth-null") return response(null);
        if (failAt === "auth-empty") return response({});
        if (failAt === "auth-unsafe") return response({ ...user, user_metadata: { ...user.user_metadata, chapter_id: "other-chapter" } });
      }
      return response(user);
    }
    if (url === "https://api.resend.com/emails") return response({}, ["email", "email-cleanup"].includes(failAt) && attempts === 1 ? 503 : 200);
    if (path === `/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") return response(null, failAt === "email-cleanup" ? 503 : 204);
    if (path === `/auth/v1/admin/users/${USER_ID}` && init.method === "PUT") return response(user);
    if (name === "fail_member_invitation_accept") {
      if (mark === "throw") throw new TypeError("private-provider-detail");
      if (mark === "http") return response({ recorded: true }, 503);
      if (mark === "negative") return response({ recorded: false });
      if (mark === "empty") return response({});
      if (mark === "string") return response({ recorded: "true" });
      if (mark === "malformed") return { ok: true, status: 200, text: async () => "not-json" };
      return response({ recorded: true });
    }
    if (name === "finalize_member_invitation") return response({}, failAt === "finalize" ? 503 : 200);
    // D-08: the real handler records the clickwrap acceptance in the database
    // between binding the identity and marking the invitation accepted.
    if (name === "record_invitation_legal_acceptance") return response({ recorded: true }, failAt === "record" ? 503 : 200);
    if (name === "complete_member_invitation_activation") return response({ accepted: true });
    throw new Error(`Unexpected fixture provider request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchUpstream);
  const fetcher = vi.fn(async (path, init) => {
    const reply = { status: 0, headers: {}, body: null };
    await handler({
      method: init.method, url: path, body: init.body,
      headers: { origin: ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
    }, {
      setHeader(name, value) { reply.headers[name] = value; },
      status(status) { reply.status = status; return this; },
      end(body) { reply.body = JSON.parse(body); },
    });
    replies.push(reply);
    return response(reply.body, reply.status);
  });
  const schedule = vi.fn(() => 17);
  const cancelSchedule = vi.fn();
  window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
  render(<LanguageProvider lang={lang}><InvitationAcceptView fetcher={fetcher} schedule={schedule} cancelSchedule={cancelSchedule} /></LanguageProvider>);
  // D-08: the versioned clickwrap comes first and only the agree button
  // exchanges the invitation. In that state the agree button is the only
  // button on the page.
  // A state, then both boxes: the terms and, since the owner decision of
  // October 16, 2026, the age attestation that state selects.
  const state = screen.queryByRole("combobox");
  if (state) fireEvent.change(state, { target: { value: "TX" } });
  const consents = screen.queryAllByRole("checkbox");
  const [action] = screen.queryAllByRole("button");
  if (consents.length && action) {
    consents.forEach((consent) => fireEvent.click(consent));
    fireEvent.click(action);
  }
  return { calls, replies, fetcher, schedule };
}

function expectPrivate(flow) {
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/invite");
  expect(document.body.textContent).not.toContain(TOKEN);
  expect(document.body.textContent).not.toContain("private-provider-detail");
  for (const reply of flow.replies) {
    expect(reply.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    for (const secret of [TOKEN, INVITATION_ID, USER_ID, invitation.normalizedEmail, "private-provider-detail"]) {
      expect(JSON.stringify(reply.body)).not.toContain(secret);
    }
  }
  for (const [, init] of flow.fetcher.mock.calls) {
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true }) });
  }
  for (const call of flow.calls.filter(call => call.name === "claim_member_invitation")) {
    expect(call.body).toEqual({ p_token_hash: createHash("sha256").update(TOKEN).digest("hex") });
  }
}

describe("invitation handler outcomes rendered by the acceptance view", () => {
  it.each(["auth-denied", "auth-unsafe", "email"].flatMap(failAt => ["en", "es"].map(lang => ({ failAt, lang }))))(
    "$failAt: confirmed terminal failure requests a replacement in $lang", async ({ failAt, lang }) => {
      const flow = mountFlow({ failAt, lang });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(lang === "en" ? "This invitation is no longer available" : "Esta invitación ya no está disponible");
      // REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the
      // recovery step names the person who invited them, not an administrator
      // a founder or first invitee does not have.
      expect(alert).toHaveTextContent(lang === "en" ? "Ask the person who invited you to send you a new invitation" : "Pide una nueva invitación a la persona que te invitó");
      // Focus moves in a passive effect after the alert commits; await it.
      await waitFor(() => expect(alert).toHaveFocus());
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(flow.replies).toMatchObject([{ status: 410, body: { error: "invitation-unavailable" } }]);
      expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(1);
      expect(flow.calls.filter(c => c.name === "fail_member_invitation_accept")).toHaveLength(1);
      expect(flow.calls.filter(c => c.path === "/emails")).toHaveLength(failAt === "email" ? 1 : 0);
      expect(flow.calls.filter(c => c.method === "DELETE")).toHaveLength(failAt === "email" ? 1 : 0);
      expect(flow.schedule).not.toHaveBeenCalled();
      expectPrivate(flow);
    },
  );

  it.each(["auth-denied", "email"].flatMap(failAt => ["throw", "http", "negative", "empty", "string", "malformed"].map(mark => ({ failAt, mark }))))(
    "$failAt: an uncertain failure marker ($mark) never claims the link is terminal", async ({ failAt, mark }) => {
      const flow = mountFlow({ failAt, mark });
      expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
      expect(flow.replies).toMatchObject([{ status: 502, body: { error: "acceptance-unavailable" } }]);
      expect(flow.calls.filter(c => c.name === "fail_member_invitation_accept")).toHaveLength(1);
      expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(1);
      expectPrivate(flow);
    },
  );

  it.each(["auth-network", "auth-503", "auth-408", "auth-429", "auth-json", "auth-null", "auth-empty"])(
    "%s: uncertain creation retains the lease without failure-marking or another provider call", async failAt => {
      const flow = mountFlow({ failAt });
      expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
      expect(flow.replies).toMatchObject([{ status: 502, body: { error: "acceptance-unavailable" } }]);
      expect(flow.calls.filter(c => c.name === "fail_member_invitation_accept")).toHaveLength(0);
      expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(1);
      expect(flow.calls.filter(c => c.path === "/emails" || c.method === "DELETE")).toHaveLength(0);
      expectPrivate(flow);
    },
  );

  it("a preclaim 503 stays retryable and succeeds with the same private token", async () => {
    const flow = mountFlow({ failAt: "preclaim" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
    expect(flow.replies[0].status).toBe(503);
    expect(flow.calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Invitation accepted"));
    expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(1);
    expectPrivate(flow);
  });

  // October 13 Production observation: without the acceptance writer the old
  // route created, emailed and bound an identity before failing. Now a database
  // without 20261016170000 stops the request before the claim.
  it("a database without the state-scoped writer fails before claiming, creating or emailing", async () => {
    const flow = mountFlow({ failAt: "not-ready" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
    expect(flow.replies[0]).toMatchObject({ status: 503, body: { error: "acceptance-unavailable" } });
    expect(flow.calls.map((call) => call.name)).toEqual([
      "consume_member_invitation_accept_limit_for_token",
      "legal_acceptance_pack_ready",
    ]);
    expectPrivate(flow);
  });

  it("an uncertain create waits for the accepting lease and recovers its exact orphan on retry", async () => {
    const flow = mountFlow({ failAt: "auth-network", recover: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Acceptance is already in progress"));
    expect(screen.getByRole("button", { name: "Retrying automatically…" })).toBeDisabled();
    expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(1);
    // The waiting message commits before the passive effect schedules its
    // retry. Await that effect while still requiring the exact server delay.
    await waitFor(() => expect(flow.schedule).toHaveBeenCalledWith(expect.any(Function), 2000));
    await act(async () => flow.schedule.mock.calls[0][0]());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Invitation accepted"));
    expect(flow.replies.map(r => r.status)).toEqual([502, 409, 200]);
    expect(flow.calls.filter(c => c.path === "/auth/v1/admin/users")).toHaveLength(2);
    expect(flow.calls.filter(c => c.path === "/emails")).toHaveLength(1);
    expect(flow.calls.filter(c => c.method === "DELETE")).toMatchObject([{ path: `/auth/v1/admin/users/${USER_ID}` }]);
    expect(flow.calls.filter(c => c.name === "fail_member_invitation_accept")).toHaveLength(0);
    expectPrivate(flow);
  });

  it("an uncertain finalization leaves the delivered identity and token recoverable", async () => {
    const flow = mountFlow({ failAt: "finalize" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
    expect(flow.replies[0].status).toBe(502);
    expect(flow.calls.filter(c => c.path === "/emails")).toHaveLength(1);
    expect(flow.calls.filter(c => c.method === "DELETE" || c.name === "fail_member_invitation_accept")).toHaveLength(0);
    expectPrivate(flow);
  });

  it("failed orphan cleanup keeps acceptance recoverable without marking it terminal", async () => {
    const flow = mountFlow({ failAt: "email-cleanup" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground is busy");
    expect(flow.replies[0].status).toBe(502);
    expect(flow.calls.filter(c => c.path === "/emails")).toHaveLength(1);
    expect(flow.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
    expect(flow.calls.filter(c => c.name === "fail_member_invitation_accept")).toHaveLength(0);
    expectPrivate(flow);
  });
});
