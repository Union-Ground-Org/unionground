// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/accept-invitation.js";
import {
  acceptanceScope,
  generateAuthLink,
  invitationUrl,
  invitationOwnedGeneratedUser,
  sendSignInPasswordEmail,
  validGeneratedLink,
} from "../api/_lib/memberInvitations.js";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { PORTAL_HOST, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";
const INVITATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN = "A".repeat(43);

function response(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = JSON.parse(body); },
  };
}

// The route refuses an acceptance that does not carry
// the versions in force, so every request that reaches the invitation lookup
// sends the clickwrap's versions, and since October 16, 2026 a listed state
// and the age attestation.
function request(body = { token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true }, overrides = {}) {
  return {
    method: "POST",
    url: "/api/accept-invitation",
    headers: { origin: "https://app.example.org", "x-vercel-forwarded-for": "203.0.113.7" },
    body,
    ...overrides,
  };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

function claim(overrides = {}) {
  return {
    available: true, recovery: false, invitationId: INVITATION_ID,
    normalizedEmail: "new.member@example.com", fullName: "New Member",
    firstName: "New", initials: "NM", chapterId: "wor", initialRole: "steward", locale: "en",
    ...overrides,
  };
}

function createdUser(overrides = {}) {
  return {
    id: USER_ID,
    email: "new.member@example.com",
    user_metadata: { union_base_invitation_id: INVITATION_ID, chapter_id: "wor" },
    app_metadata: { union_ground_provisioning: "pending" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("INVITATION_APP_ORIGIN", "https://app.example.org");
  vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "rate-secret-at-least-32-characters-long");
  vi.stubEnv("RESEND_API_KEY", "resend-secret");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <members@app.example.org>");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("uses independent message references instead of password digests for first-password mail", async () => {
  const fetchMock = vi.fn(async () => response({ id: "email-1" }));
  vi.stubGlobal("fetch", fetchMock);
  const password = "member-typed-temporary-password";
  const delivery = { resendKey: "mail-key", from: "members@example.test", to: "member@example.test",
    locale: "en", password, invitationId: INVITATION_ID };
  expect(await sendSignInPasswordEmail(delivery)).toBe(true);
  expect(await sendSignInPasswordEmail(delivery)).toBe(true);
  const keys = fetchMock.mock.calls.map(([, init]) => init.headers["Idempotency-Key"]);
  for (const key of keys) {
    expect(key).toMatch(new RegExp(`^ug-password-${INVITATION_ID}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
  }
  expect(keys[0]).not.toBe(keys[1]);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain(password);
});

describe("bounded SAMPLE invitation acceptance", () => {
  const sampleUrl = "https://sampledemoprojectref.supabase.co";
  const proofRequest = (body) => request(body, {
    headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
  });
  beforeEach(() => {
    vi.stubEnv("SAMPLE_SUPABASE_URL", sampleUrl);
    vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sample-service");
    vi.stubEnv("SAMPLE_INVITATION_PROOF_ENABLED", "true");
    vi.stubEnv("SAMPLE_INVITATION_PROOF_EXPIRES_AT", new Date(Date.now() + 600000).toISOString());
    vi.stubEnv("SAMPLE_INVITATION_APP_ORIGIN", SAMPLE_ORIGIN);
    vi.stubEnv("SAMPLE_INVITATION_RESEND_API_KEY", "isolated-sample-mail-key");
    vi.stubEnv("SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS", "Proof <proof@sample.example>");
    vi.stubEnv("SAMPLE_INVITATION_RATE_LIMIT_SECRET", "sample-only-proof-rate-secret-at-least-32");
    vi.stubEnv("SAMPLE_INVITATION_ALLOWED_EMAILS", "new.member@example.com");
  });

  function network(invitation = claim(), recovery = null) {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url); const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: u, init, body });
      if (u.includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (u.endsWith("/legal_acceptance_pack_ready")) return response(true);
      if (u.endsWith("/claim_member_invitation")) return response(invitation);
      if (u.endsWith("/get_member_invitation_recovery_user")) return response(recovery);
      if (u === `${sampleUrl}/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") return response(null, 204);
      if (u === `${sampleUrl}/auth/v1/admin/users`) return response(createdUser());
      if (u === "https://api.resend.com/emails") return response({ id: "sample-password" });
      if (u.endsWith("/finalize_member_invitation")) return response({ prepared: true, userId: USER_ID });
      if (u.endsWith("/record_invitation_legal_acceptance")) return response({ recorded: true });
      if (u === `${sampleUrl}/auth/v1/admin/users/${USER_ID}`) return response({ ...createdUser(), banned_until: null, app_metadata: { union_ground_provisioning: "active" } });
      if (u.endsWith("/complete_member_invitation_activation")) return response({ accepted: true });
      throw new Error("unexpected proof endpoint");
    }));
    return calls;
  }

  // This edition ships no sample backend (api/_lib/memberInvitations.js), so the
  // bounded proof stays off even when every proof setting is present.
  it("refuses a fully configured SAMPLE proof because this edition has no sample backend", async () => {
    const calls = network();
    expect((await run(proofRequest())).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("keeps the default SAMPLE refusal before all provider calls", async () => {
    vi.stubEnv("SAMPLE_INVITATION_PROOF_ENABLED", "false");
    const calls = network();
    expect((await run(proofRequest())).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("never falls back to the Production mail credential", async () => {
    vi.stubEnv("SAMPLE_INVITATION_RESEND_API_KEY", "");
    const calls = network();
    expect((await run(proofRequest())).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("public emailed-password invitation acceptance", () => {
  it.each([
    ["new", false], ["new", true], ["reactivation", false], ["reactivation", true],
  ])("keeps %s inactive when versioned consent cannot be stored (transport=%s)", async (kind, transportFailure) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind }));
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-consent-test" });
      if (String(url).includes("finalize_member_invitation")) return response({ prepared: true, userId: USER_ID });
      if (String(url).includes("record_invitation_legal_acceptance")) {
        if (transportFailure) throw new Error("private-provider-detail");
        return response({ recorded: false });
      }
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.some((url) => url.includes("record_invitation_legal_acceptance"))).toBe(true);
    expect(calls.some((url) => url.includes("accept_former_member_invitation") || url.includes("complete_member_invitation_activation"))).toBe(false);
    expect(calls).not.toContain(`${SUPABASE}/auth/v1/admin/users/${USER_ID}`);
  });

  // No account exists without a
  // recorded state and attestation, so the token-only wire contract of pre-D-08 installed builds
  // is refused like a stale pack, before anything is claimed.
  it("refuses a token-only acceptance from an installed build before claiming anything", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request({ token: TOKEN }))).toMatchObject({
      status: 409, body: { error: "terms-version-stale", versions: currentLegalVersions() },
    });
    expect(await run(request({ token: TOKEN, residenceState: "TX", ageAttested: true }))).toMatchObject({
      status: 409, body: { error: "terms-version-stale" },
    });
    expect(calls).toEqual([
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
    ]);
  });

  it("refuses a stale privacy 1.0.0 clickwrap before invitation side effects", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      throw new Error(`unexpected ${url}`);
    }));
    const body = { token: TOKEN, acceptedVersions: { ...currentLegalVersions(), "privacy-policy": "1.0.0" }, residenceState: "TX", ageAttested: true };
    expect(await run(request(body))).toMatchObject({
      status: 409, body: { error: "terms-version-stale", versions: currentLegalVersions() },
    });
    expect(calls).toEqual([`${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`]);
  });

  // A current clickwrap without a listed
  // state, or without the age attestation that state selects, claims, creates
  // and records nothing. The pre-October 16 "adultAttested" field alone is not
  // an answer.
  it.each([
    ["no state", { ageAttested: true }],
    ["an unlisted state", { residenceState: "ZZ", ageAttested: true }],
    ["a lower-case state", { residenceState: "tx", ageAttested: true }],
    ["the October 12 field only", { adultAttested: true }],
  ])("refuses a versioned acceptance with %s before claiming anything", async (_label, extra) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      throw new Error(`unexpected ${url}`);
    }));
    const body = { token: TOKEN, acceptedVersions: currentLegalVersions(), ...extra };
    expect(await run(request(body))).toMatchObject({ status: 400, body: { error: "residence-state-required" } });
    expect(calls).toEqual([`${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`]);
  });

  it.each([undefined, false, "true", 1])("refuses a listed state whose age attestation is %s before claiming anything", async (ageAttested) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      throw new Error(`unexpected ${url}`);
    }));
    const body = { token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "OH" };
    if (ageAttested !== undefined) body.ageAttested = ageAttested;
    expect(await run(request(body))).toMatchObject({ status: 400, body: { error: "age-attestation-required" } });
    expect(calls).toEqual([`${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`]);
  });

  // The October 13 Production observation: the deployed route created, emailed
  // and bound an identity, then failed on a missing acceptance writer. A
  // database without 20261016170000 must now stop the request before the claim.
  it.each([
    ["answers false", () => response(false)],
    ["is missing", () => response({ code: "PGRST202", message: "not found" }, 404)],
    ["is unreachable", () => { throw new Error("provider down"); }],
  ])("refuses before claiming when the state-scoped writer readiness probe %s", async (_label, probe) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return probe();
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "acceptance-unavailable" } });
    expect(calls).toEqual([
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
      `${SUPABASE}/rest/v1/rpc/legal_acceptance_pack_ready`,
    ]);
  });

  // UB-PUB-04 gate round 1 (Sol): the probe carries the exact pack this site
  // publishes, so a database pinned to another pack refuses before the claim
  // creates, emails or binds anything.
  it("asks the readiness probe about the exact published version map", async () => {
    const probes = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) {
        probes.push(JSON.parse(init.body));
        return response(false);
      }
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "acceptance-unavailable" } });
    expect(probes).toEqual([{ p_versions: currentLegalVersions() }]);
  });

  // The recorded state travels to the database, which derives the attestation
  // from it; the route never names "adult" or "band" itself.
  it.each(["TX", "CA", "AL", "UT", "LA", "OH", "PR", "outside-us"])("records the stated residence %s with the acceptance", async (residenceState) => {
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation" }));
      if (String(url).includes("record_invitation_legal_acceptance")) {
        bodies.push(JSON.parse(init.body));
        return response({ recorded: true });
      }
      if (String(url).includes("accept_former_member_invitation")) return response({ accepted: true, reactivated: true });
      throw new Error(`unexpected ${url}`);
    }));
    const body = { token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState, ageAttested: true };
    expect(await run(request(body))).toMatchObject({ status: 200, body: { accepted: true, reactivated: true } });
    expect(bodies).toEqual([{
      p_invitation_id: INVITATION_ID,
      p_versions: currentLegalVersions(),
      p_residence_state: residenceState,
      p_age_attested: true,
    }]);
  });

  it("puts the emailed invitation under the associated native path with a fragment-only token", () => {
    expect(invitationUrl("https://app.example.org", TOKEN)).toBe(`https://app.example.org/app/invite#invite=${TOKEN}`);
  });
  it("buckets IPv6 privacy addresses by /64 and IPv4-mapped addresses as IPv4", () => {
    const key = "rate-secret-at-least-32-characters-long";
    const requestFor = (address) => ({
      headers: { "x-vercel-forwarded-for": address },
      socket: {},
    });

    expect(acceptanceScope(requestFor("2001:db8:abcd:12::1"), key))
      .toBe(acceptanceScope(requestFor("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"), key));
    expect(acceptanceScope(requestFor("2001:db8:abcd:12::1"), key))
      .not.toBe(acceptanceScope(requestFor("2001:db8:abcd:13::1"), key));
    expect(acceptanceScope(requestFor("::ffff:203.0.113.7"), key))
      .toBe(acceptanceScope(requestFor("203.0.113.7"), key));
  });

  it("refuses before the rate-limit RPC when no trusted network bucket exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await run(request(undefined, {
      headers: { origin: "https://app.example.org" },
      socket: {},
    }))).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SEC-UG-INVITATION-RATE-LIMIT-IPV6-BUCKET-20260907 sends one RPC bucket for rotating addresses in a /64", async () => {
    const rateLimitBodies = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (!String(url).includes("consume_member_invitation_accept_limit")) {
        if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
      }
      rateLimitBodies.push(JSON.parse(init.body));
      return response({ allowed: true });
    }));

    for (const [address, proxy] of [
      ["2001:db8:abcd:12::1", "198.51.100.20"],
      ["2001:0db8:abcd:0012:ffff:ffff:ffff:ffff", "198.51.100.21"],
      ["2001:db8:abcd:12:1234:5678:90ab:cdef", "198.51.100.22"],
    ]) {
      const out = await run(request({ token: "invalid" }, {
        headers: {
          origin: "https://app.example.org",
          "x-vercel-forwarded-for": `${address}, ${proxy}`,
        },
      }));
      expect(out).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    }

    const scopeHashes = rateLimitBodies.map((body) => body.p_scope_hash);
    expect(scopeHashes).toHaveLength(3);
    expect(new Set(scopeHashes).size).toBe(1);
    expect(scopeHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeHashes[0]).not.toContain("2001:db8");
  });

  it("validates legacy generated invitation links without trusting malformed provider payloads", async () => {
    const invitation = claim();
    const generated = {
      id: USER_ID,
      email: invitation.normalizedEmail,
      user_metadata: {
        union_base_invitation_id: invitation.invitationId,
        chapter_id: invitation.chapterId,
      },
      action_link: `${SUPABASE}/auth/v1/verify?token=provider-token`,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(generated))
      .mockResolvedValueOnce(response(null, 503))
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("invalid json"); } }));

    const linked = await generateAuthLink(SUPABASE, "server-secret-key", invitation, "https://app.example.org");
    expect(invitationOwnedGeneratedUser(linked, invitation)).toBe(true);
    expect(validGeneratedLink({ ...linked, action_link: generated.action_link }, SUPABASE, invitation)).toBe(true);
    expect(validGeneratedLink({ ...linked, action_link: "not a URL" }, SUPABASE, invitation)).toBe(false);
    expect(validGeneratedLink({ ...linked, action_link: "https://evil.example/auth/v1/verify" }, SUPABASE, invitation)).toBe(false);
    expect(invitationOwnedGeneratedUser({ user: { id: "invalid" } }, invitation)).toBe(false);
    expect(await generateAuthLink(SUPABASE, "server-secret-key", invitation, "https://app.example.org")).toBeNull();
    expect(await generateAuthLink(SUPABASE, "server-secret-key", invitation, "https://app.example.org")).toBeNull();
  });

  it("is POST-only, same-origin, and refuses query-string secrets before lookup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ method: "GET", url: "/api/accept-invitation", headers: {}, body: null })).status).toBe(405);
    expect((await run(request(undefined, { url: `/api/accept-invitation?token=${TOKEN}` }))).status).toBe(400);
    expect((await run(request(undefined, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a malformed JSON body to the same unavailable invitation response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run(request("{not-json"))).toMatchObject({
      status: 410,
      body: { error: "invitation-unavailable" },
    });
  });

  it("fails closed with not-configured before any network call when a required setting is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "not-configured" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the keyed rate-bucket secret is too weak", async () => {
    vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "short");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "not-configured" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits, delivers a password, prepares the banned identity, activates, then consumes the lease", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method, body, headers: init.headers });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-1" });
      if (String(url).includes("finalize_member_invitation")) return response({ prepared: true, userId: USER_ID });
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true, userId: USER_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) return response(createdUser({ app_metadata: { union_ground_provisioning: "active" } }));
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(request());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accepted: true });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(calls.map((entry) => entry.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
      `${SUPABASE}/rest/v1/rpc/legal_acceptance_pack_ready`,
      `${SUPABASE}/rest/v1/rpc/claim_member_invitation`,
      `${SUPABASE}/auth/v1/admin/users`,
      "https://api.resend.com/emails",
      `${SUPABASE}/rest/v1/rpc/finalize_member_invitation`,
      // D-08: the acceptance is recorded after the identity is bound to the
      // invitation and BEFORE the invitation is marked accepted.
      `${SUPABASE}/rest/v1/rpc/record_invitation_legal_acceptance`,
      `${SUPABASE}/auth/v1/admin/users/${USER_ID}`,
      `${SUPABASE}/rest/v1/rpc/complete_member_invitation_activation`,
    ]);
    expect(calls[1].body).toEqual({ p_versions: currentLegalVersions() });
    // The readiness probe and the recorded acceptance must name the amended
    // privacy text; otherwise a site can show 1.1.0 and record the old text.
    expect(calls[1].body.p_versions).toEqual(currentLegalVersions());
    expect(calls[6].body.p_versions).toEqual(currentLegalVersions());
    expect(calls[6].body).toEqual({
      p_invitation_id: INVITATION_ID, p_versions: currentLegalVersions(), p_residence_state: "TX", p_age_attested: true,
    });
    expect(calls[0].body).toMatchObject({
      p_token_hash: createHash("sha256").update(TOKEN).digest("hex"),
    });
    expect(calls[3].body).toMatchObject({
      email: "new.member@example.com", email_confirm: true, ban_duration: "876000h",
      app_metadata: { union_ground_provisioning: "pending" },
    });
    expect(calls[3].body.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(calls[4].headers["Idempotency-Key"]).toMatch(new RegExp(`^ug-password-${INVITATION_ID}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
    expect(calls[4].body.text).toContain(calls[3].body.password);
    // The first-password email ends with the website/phone links and the
    // inline QR code for the public /get-app page.
    expect(calls[4].body.text).toContain("https://app.example.org/get-app");
    expect(calls[4].body.html).toContain('src="cid:union-ground-app-qr"');
    expect(calls[4].body.attachments).toEqual([
      expect.objectContaining({ filename: "union-ground-app.png", content_id: "union-ground-app-qr" }),
    ]);
    expect(calls[5].body).toEqual({ p_invitation_id: INVITATION_ID, p_auth_user_id: USER_ID });
    expect(calls[7].body).toEqual({ ban_duration: "none", app_metadata: { union_ground_provisioning: "active" } });
    expect(calls[8].body).toEqual({ p_invitation_id: INVITATION_ID, p_auth_user_id: USER_ID });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("returns one unavailable response before Auth for an invalid invitation", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response({ available: false });
      throw new Error("Auth provider must not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102: an
  // invitation to a government or employer address creates no account; it
  // ends as failed so an administrator can invite a personal address.
  it("refuses a new account on a government address and ends the invitation before Auth", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ normalizedEmail: "new.member@agency.gov" }));
      if (String(url).includes("fail_member_invitation_accept")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 400, body: { error: "email-domain-blocked" } });
    expect(calls.find((call) => call.url.includes("fail_member_invitation_accept"))?.body)
      .toEqual({ p_invitation_id: INVITATION_ID, p_failure_code: "auth_unavailable" });
    expect(calls.some((call) => call.url.includes("/auth/v1/"))).toBe(false);
  });

  it("returns the bounded acceptance lease retry contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response({ available: false, cause: "acceptance-in-progress", retryAfterSeconds: 73.2 });
      throw new Error("unexpected provider call");
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 409, body: { error: "acceptance-in-progress", retryAfterSeconds: 74 } });
    expect(out.headers["Retry-After"]).toBe("74");
  });

  // An exhausted, lapsed lease is released instead
  // of leaving the row accepting, where resend, revoke and re-invite refuse it.
  function exhaustedFetch(calls, recovery, { deleteFails = false } = {}) {
    return vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) {
        return response({ available: false, cause: "acceptance-exhausted", invitationId: INVITATION_ID });
      }
      if (String(url).includes("get_member_invitation_recovery_user")) return response(recovery);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") {
        if (deleteFails) throw new Error("provider unavailable");
        return response(null, 204);
      }
      if (String(url).includes("fail_member_invitation_accept")) return response({ recorded: true });
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    });
  }

  it("releases an exhausted lease after deleting only the exact pending invitation identity", async () => {
    const calls = [];
    vi.stubGlobal("fetch", exhaustedFetch(calls, { found: true, userId: USER_ID, provisioning: "pending" }));
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    const deleted = calls.findIndex((entry) => entry.method === "DELETE");
    const failed = calls.findIndex((entry) => entry.url.includes("fail_member_invitation_accept"));
    expect(calls[deleted].url).toBe(`${SUPABASE}/auth/v1/admin/users/${USER_ID}`);
    expect(failed).toBeGreaterThan(deleted);
    expect(calls[failed].body).toEqual({ p_invitation_id: INVITATION_ID, p_failure_code: "auth_unavailable" });
    expect(calls.some((entry) => entry.url === `${SUPABASE}/auth/v1/admin/users`)).toBe(false);
  });

  it("releases an exhausted lease that never created an identity", async () => {
    const calls = [];
    vi.stubGlobal("fetch", exhaustedFetch(calls, { found: false }));
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    expect(calls.some((entry) => entry.url.includes("fail_member_invitation_accept"))).toBe(true);
    expect(calls.some((entry) => entry.method === "DELETE")).toBe(false);
  });

  it("keeps an exhausted lease when its pending identity cannot be deleted", async () => {
    const calls = [];
    vi.stubGlobal("fetch", exhaustedFetch(calls, { found: true, userId: USER_ID, provisioning: "pending" }, { deleteFails: true }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.some((entry) => entry.url.includes("fail_member_invitation_accept"))).toBe(false);
  });

  it("completes an exhausted lease whose identity is already active, recording this request's state first", async () => {
    const calls = [];
    vi.stubGlobal("fetch", exhaustedFetch(calls, { found: true, userId: USER_ID, provisioning: "active" }));
    const body = { token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "OH", ageAttested: true };
    expect(await run(request(body))).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.some((entry) => entry.url.includes("fail_member_invitation_accept"))).toBe(false);
    expect(calls.some((entry) => entry.method === "DELETE")).toBe(false);
    const recorded = calls.findIndex((entry) => entry.url.includes("record_invitation_legal_acceptance"));
    expect(calls[recorded].body).toMatchObject({ p_invitation_id: INVITATION_ID, p_residence_state: "OH", p_age_attested: true });
    expect(recorded).toBeLessThan(calls.findIndex((entry) => entry.url.includes("complete_member_invitation_activation")));
  });

  // BUG-UG-RECORD-TERMS-ACCEPTANCE-INVITATION-FINISHES-THROUGH-LEASE-RECOVERY-20261013:
  // the stale-lease recovery branch records this request's attestation before it
  // completes an already-active identity, the same as the exhausted-lease branch.
  it("completes a stale lease whose identity is already active, recording this request's state first", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ recovery: true }));
      if (String(url).includes("get_member_invitation_recovery_user")) return response({ found: true, userId: USER_ID, provisioning: "active" });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "OH", ageAttested: true })))
      .toMatchObject({ status: 200, body: { accepted: true } });
    const recorded = calls.findIndex((entry) => entry.url.includes("record_invitation_legal_acceptance"));
    expect(calls[recorded].body).toMatchObject({ p_invitation_id: INVITATION_ID, p_residence_state: "OH", p_age_attested: true });
    expect(recorded).toBeGreaterThan(-1);
    expect(recorded).toBeLessThan(calls.findIndex((entry) => entry.url.includes("complete_member_invitation_activation")));
  });

  it.each([["an exhausted lease", false], ["a stale lease", true]])(
    "does not complete %s's active identity when this request's state cannot be recorded",
    async (_label, staleLease) => {
      const calls = [];
      vi.stubGlobal("fetch", vi.fn(async (url, _init = {}) => {
        calls.push({ url: String(url) });
        if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
        if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
        if (String(url).includes("claim_member_invitation")) {
          return response(staleLease ? claim({ recovery: true })
            : { available: false, cause: "acceptance-exhausted", invitationId: INVITATION_ID });
        }
        if (String(url).includes("get_member_invitation_recovery_user")) {
          return response({ found: true, userId: USER_ID, provisioning: "active" });
        }
        if (String(url).includes("record_invitation_legal_acceptance")) return response({ message: "down" }, 503);
        if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true });
        throw new Error(`unexpected ${url}`);
      }));
      expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
      expect(calls.some((entry) => entry.url.includes("complete_member_invitation_activation"))).toBe(false);
    },
  );

  it("deletes only the exact stale invitation-owned identity before retrying", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ recovery: true }));
      if (String(url).includes("get_member_invitation_recovery_user")) return response({ found: true, userId: USER_ID, confirmed: false, provisioning: "pending" });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") return response(null, 204);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-2" });
      if (String(url).includes("finalize_member_invitation")) return response({ accepted: true });
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT") return response(createdUser());
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect((await run(request())).status).toBe(200);
    expect(calls.find((entry) => entry.method === "DELETE")?.url).toBe(`${SUPABASE}/auth/v1/admin/users/${USER_ID}`);
  });

  it("fails closed when a stale pending invitation identity cannot be deleted", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ recovery: true }));
      if (String(url).includes("get_member_invitation_recovery_user")) {
        return response({ found: true, userId: USER_ID, provisioning: "pending" });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") {
        throw new Error("provider unavailable");
      }
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
  });

  it("completes a stale active invitation without deleting the usable account or emailing again", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ recovery: true }));
      if (String(url).includes("get_member_invitation_recovery_user")) {
        return response({ found: true, userId: USER_ID, provisioning: "active" });
      }
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(calls.some((entry) => entry.url === "https://api.resend.com/emails")).toBe(false);
  });

  it("removes the new banned identity if password delivery fails and records no recipient", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ error: "down" }, 503);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "DELETE") return response(null, 204);
      if (String(url).includes("fail_member_invitation_accept")) return response({ recorded: true });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    expect(calls.at(-1).body).toEqual({ p_invitation_id: INVITATION_ID, p_failure_code: "provider_unavailable" });
    expect(JSON.stringify(out)).not.toContain("new.member@example.com");
  });

  it("leaves a delivered but unfinalized banned identity recoverable and logs no secret detail", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-3" });
      if (String(url).includes("finalize_member_invitation")) return response({ message: `private ${TOKEN}` }, 503);
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(logged).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("re-bans an activated identity when lease completion fails", async () => {
    const calls = [];
    let userUpdates = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method, body });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-4" });
      if (String(url).includes("finalize_member_invitation")) return response({ prepared: true });
      if (String(url).includes("complete_member_invitation_activation")) return response({ message: "down" }, 503);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT") {
        userUpdates += 1;
        return response(createdUser());
      }
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(userUpdates).toBe(2);
    expect(calls.at(-1).body).toEqual({
      ban_duration: "876000h",
      app_metadata: { union_ground_provisioning: "pending" },
    });
  });

  it("fails closed when activation or compensating suspension cannot reach Auth", async () => {
    const fetchFor = (failAt) => vi.fn(async (url, init = {}) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users` && init.method === "POST") return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email" });
      if (String(url).includes("finalize_member_invitation")) return response({ prepared: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT") {
        if (failAt === "activation" || init.body.includes("876000h")) throw new Error("auth unavailable");
        return response(createdUser({ app_metadata: { union_ground_provisioning: "active" } }));
      }
      if (String(url).includes("complete_member_invitation_activation")) {
        return response({ error: "down" }, 503);
      }
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    });

    vi.stubGlobal("fetch", fetchFor("activation"));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });

    vi.stubGlobal("fetch", fetchFor("suspension"));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
  });

  it("returns 429 try-later and never claims the invitation when the rate limit denies", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: false });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request())).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the rate-limit RPC itself is unavailable", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("consume_member_invitation_accept_limit")) throw new Error("provider down");
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "acceptance-unavailable" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed and records unsafe_auth_state when the generated identity is not owned by the invitation", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) {
        return response(createdUser({
          user_metadata: { union_base_invitation_id: "99999999-0000-4000-8000-000000000009", chapter_id: "wor" },
        }));
      }
      if (String(url).includes("fail_member_invitation_accept")) return response({ recorded: true });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    expect(calls.some((entry) => entry.url === "https://api.resend.com/emails")).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      url: expect.stringContaining("fail_member_invitation_accept"),
      body: { p_invitation_id: INVITATION_ID, p_failure_code: "unsafe_auth_state" },
    });
  });
});

describe("former member re-activation acceptance", () => {
  it("completes a reactivation claim through the service RPC without creating an account or emailing a password", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", initialRole: null }));
      if (String(url).includes("accept_former_member_invitation")) return response({ accepted: true, reactivated: true, userId: USER_ID });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 200, body: { accepted: true, reactivated: true } });
    expect(calls.map((entry) => entry.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
      `${SUPABASE}/rest/v1/rpc/legal_acceptance_pack_ready`,
      `${SUPABASE}/rest/v1/rpc/claim_member_invitation`,
      // D-08: a reactivation binds its own identity and clears the token, so
      // the acceptance is recorded before it, never after.
      `${SUPABASE}/rest/v1/rpc/record_invitation_legal_acceptance`,
      `${SUPABASE}/rest/v1/rpc/accept_former_member_invitation`,
    ]);
    expect(calls[3].body).toEqual({
      p_invitation_id: INVITATION_ID, p_versions: currentLegalVersions(), p_residence_state: "TX", p_age_attested: true,
    });
    expect(calls[4].body).toEqual({ p_invitation_id: INVITATION_ID });
    expect(calls.some((entry) => entry.url.includes("/auth/v1/admin/users"))).toBe(false);
    expect(calls.some((entry) => entry.url === "https://api.resend.com/emails")).toBe(false);
    expect(JSON.stringify(out)).not.toContain(USER_ID);
    expect(JSON.stringify(out)).not.toContain("new.member@example.com");
  });

  it("answers acceptance-unavailable and keeps the lease when the reactivation RPC refuses, touching Auth never", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", recovery: true }));
      if (String(url).includes("accept_former_member_invitation")) return response({ message: "invitation unavailable" }, 400);
      if (String(url).includes("get_former_member_invitation_outcome")) return response({ accepted: false });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.some((entry) => entry.url.includes("get_member_invitation_recovery_user"))).toBe(false);
    // The outcome read after a refusal answers not-accepted; nothing else is called.
    expect(calls.map((entry) => entry.url).filter((url) => url.includes("get_former_member_invitation_outcome"))).toHaveLength(1);
    expect(calls.some((entry) => entry.url.includes("fail_member_invitation_accept"))).toBe(false);
    expect(calls.some((entry) => entry.url.includes("/auth/v1/"))).toBe(false);
  });

  it("reports a reactivation that committed before its reply was lost, without touching Auth", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", initialRole: null }));
      if (String(url).includes("accept_former_member_invitation")) throw new Error("socket hang up");
      if (String(url).includes("get_former_member_invitation_outcome")) return response({ accepted: true });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 200, body: { accepted: true, reactivated: true } });
    expect(calls.map((entry) => entry.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/consume_member_invitation_accept_limit_for_token`,
      `${SUPABASE}/rest/v1/rpc/legal_acceptance_pack_ready`,
      `${SUPABASE}/rest/v1/rpc/claim_member_invitation`,
      `${SUPABASE}/rest/v1/rpc/record_invitation_legal_acceptance`,
      `${SUPABASE}/rest/v1/rpc/accept_former_member_invitation`,
      `${SUPABASE}/rest/v1/rpc/get_former_member_invitation_outcome`,
    ]);
    expect(calls[4].body).toEqual({ p_invitation_id: INVITATION_ID });
  });

  it("treats a malformed reactivation reply as uncertain and stays unavailable when nothing committed", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, _init = {}) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", initialRole: null }));
      if (String(url).includes("accept_former_member_invitation")) return response({ accepted: true });
      if (String(url).includes("get_former_member_invitation_outcome")) return response({ accepted: false });
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.at(-1)).toContain("get_former_member_invitation_outcome");
    expect(calls.some((url) => url.includes("fail_member_invitation_accept"))).toBe(false);
    expect(calls.some((url) => url.includes("/auth/v1/"))).toBe(false);
  });

  it("stays unavailable and keeps the lease when both the reactivation RPC and the outcome read are lost", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", initialRole: null }));
      if (String(url).includes("accept_former_member_invitation")) throw new Error("socket hang up");
      if (String(url).includes("get_former_member_invitation_outcome")) throw new Error("socket hang up");
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.at(-1)).toContain("get_former_member_invitation_outcome");
    expect(calls.some((url) => url.includes("fail_member_invitation_accept"))).toBe(false);
    expect(calls.some((url) => url.includes("/auth/v1/"))).toBe(false);
  });

  it("does not treat a provisioning claim as a reactivation", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, _init = {}) => {
      calls.push(String(url));
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "provision" }));
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response({ message: "down" }, 503);
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request())).toMatchObject({ status: 502, body: { error: "acceptance-unavailable" } });
    expect(calls.some((url) => url.includes("accept_former_member_invitation"))).toBe(false);
    expect(calls.some((url) => url === `${SUPABASE}/auth/v1/admin/users`)).toBe(true);
  });
});

// REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110: a referral code
// given at acceptance is recorded only after the new account's acceptance has
// committed, and never turns an accepted invitation into an error.
describe("referral code at invitation acceptance", () => {
  function acceptFetch(calls, { referralFails = false } = {}) {
    return vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim());
      if (String(url) === `${SUPABASE}/auth/v1/admin/users`) return response(createdUser());
      if (String(url) === "https://api.resend.com/emails") return response({ id: "email-referral" });
      if (String(url).includes("finalize_member_invitation")) return response({ prepared: true, userId: USER_ID });
      if (String(url).includes("complete_member_invitation_activation")) return response({ accepted: true, userId: USER_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) return response(createdUser({ app_metadata: { union_ground_provisioning: "active" } }));
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      if (String(url).includes("record_member_referral")) {
        if (referralFails) throw new Error("referral-provider-detail");
        return response({ recorded: true });
      }
      throw new Error(`unexpected ${url}`);
    });
  }
  const withCode = (code) => ({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true, referralCode: code });

  it("records the normalized code after the activation completes", async () => {
    const calls = [];
    vi.stubGlobal("fetch", acceptFetch(calls));
    expect(await run(request(withCode(" ab12-cd34-ef56 ")))).toMatchObject({ status: 200, body: { accepted: true } });
    const urls = calls.map((entry) => entry.url);
    expect(urls.at(-1)).toBe(`${SUPABASE}/rest/v1/rpc/record_member_referral`);
    expect(urls.indexOf(`${SUPABASE}/rest/v1/rpc/complete_member_invitation_activation`)).toBe(urls.length - 2);
    expect(calls.at(-1).body).toEqual({ p_invitation_id: INVITATION_ID, p_code: "AB12CD34EF56" });
  });

  it("keeps the acceptance when recording the referral fails", async () => {
    const calls = [];
    vi.stubGlobal("fetch", acceptFetch(calls, { referralFails: true }));
    expect(await run(request(withCode("AB12CD34EF56")))).toMatchObject({ status: 200, body: { accepted: true } });
  });

  // BUG-UG-REFERRAL-EDGES-REJOIN-BACKFILL-AND-INVITE-CAP-20261117
  //: a former member who rejoins earns no referral, on either success
  // return. Their earlier check-ins would activate it at once, so recording it
  // would pay a referral for a returning member, not for a new one.
  it.each([
    ["the reactivation reply", { accepted: true, reactivated: true, userId: USER_ID }],
    ["the outcome read after a lost reply", null],
  ])("records no referral for a former member who rejoins (%s)", async (_label, reply) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("consume_member_invitation_accept_limit")) return response({ allowed: true });
      if (String(url).includes("legal_acceptance_pack_ready")) return response(true);
      if (String(url).includes("claim_member_invitation")) return response(claim({ kind: "reactivation", initialRole: null }));
      if (String(url).includes("record_invitation_legal_acceptance")) return response({ recorded: true });
      if (String(url).includes("accept_former_member_invitation")) {
        if (!reply) throw new Error("socket hang up");
        return response(reply);
      }
      if (String(url).includes("get_former_member_invitation_outcome")) return response({ accepted: true });
      if (String(url).includes("record_member_referral")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run(request(withCode("AB12CD34EF56")))).toMatchObject({ status: 200, body: { accepted: true, reactivated: true } });
    expect(calls.some((entry) => entry.url.includes("accept_former_member_invitation"))).toBe(true);
    expect(calls.some((entry) => entry.url.includes("record_member_referral"))).toBe(false);
  });

  it.each([undefined, "", "not-a-code", "AB12CD34EF5", 12])("sends no referral call for %s", async (code) => {
    const calls = [];
    vi.stubGlobal("fetch", acceptFetch(calls));
    expect(await run(request(withCode(code)))).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.some((entry) => entry.url.includes("record_member_referral"))).toBe(false);
  });
});
