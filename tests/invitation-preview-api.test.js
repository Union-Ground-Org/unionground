// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { invitationPreviewBody } from "../api/invitation-preview.js";
import { acceptanceScope } from "../api/_lib/memberInvitations.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the invitation
// page names the organization, role, inviter and sign-in address before the
// person accepts. The route mirrors acceptance's boundary: origin bound, the
// network limit spent first (in its own bucket), one answer for every token
// that is not a pending invitation, and nothing claimed.

const SUPABASE = "https://project.supabase.co";
const TOKEN = "B".repeat(43);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function reply(payload, status = 200) {
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

function request(body = { token: TOKEN }, overrides = {}) {
  return {
    method: "POST",
    url: "/api/invitation-preview",
    headers: { origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
    body,
    ...overrides,
  };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

const PREVIEW = {
  available: true,
  email: "new.member@example.com",
  role: "steward",
  chapterName: "Harbor",
  organizationName: "Thornbury Nurses United",
  inviterName: "Rosa Diaz",
};

function backend({ limit = { allowed: true }, preview = PREVIEW, limitStatus = 200, previewStatus = 200 } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const name = String(url).split("/rpc/")[1];
    calls.push({ name, body: JSON.parse(init.body), headers: init.headers });
    if (name === "consume_member_invitation_accept_limit_for_token") return reply(limit, limitStatus);
    if (name === "preview_member_invitation") return reply(preview, previewStatus);
    return reply({ message: "unexpected" }, 500);
  }));
  return calls;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
  vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "rate-secret-at-least-32-characters-long");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the invitation preview route", () => {
  it("describes a pending invitation after spending its own rate bucket", async () => {
    const calls = backend();
    const out = await run(request());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ organization: "Thornbury Nurses United", chapter: "Harbor", role: "steward", email: "new.member@example.com", inviter: "Rosa Diaz" });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(calls.map((call) => call.name)).toEqual(["consume_member_invitation_accept_limit_for_token", "preview_member_invitation"]);
    // A bucket of its own: never the acceptance scope, so reading never uses
    // up an acceptance.
    const acceptScope = acceptanceScope(request(), "rate-secret-at-least-32-characters-long");
    expect(calls[0].body).toEqual({ p_scope_hash: sha(`member-invitation-preview-v1:${acceptScope}`), p_token_hash: sha(TOKEN) });
    expect(calls[0].body.p_scope_hash).not.toBe(acceptScope);
    expect(calls[1].body).toEqual({ p_token_hash: sha(TOKEN) });
    expect(calls[1].headers.Authorization).toBe("Bearer server-secret-key");
  });

  it("answers an unknown, spent or malformed token the same way, after the limit", async () => {
    let calls = backend({ preview: { available: false } });
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    calls = backend();
    expect(await run(request({ token: "short" }))).toMatchObject({ status: 410, body: { error: "invitation-unavailable" } });
    expect(calls.map((call) => call.name)).toEqual(["consume_member_invitation_accept_limit_for_token"]);
    expect(calls[0].body.p_token_hash).toBeNull();
  });

  it("refuses when the bucket is spent and never reads the invitation", async () => {
    const calls = backend({ limit: { allowed: false } });
    expect(await run(request())).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(calls).toHaveLength(1);
  });

  it("reports an unavailable limiter or read without describing anything", async () => {
    backend({ limitStatus: 500 });
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "preview-unavailable" } });
    backend({ previewStatus: 500 });
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "preview-unavailable" } });
  });

  it("is bound to the invitation origin, POST only, with no query and a bounded body", async () => {
    const calls = backend();
    expect(await run(request(undefined, { method: "GET" }))).toMatchObject({ status: 405 });
    expect(await run(request(undefined, { headers: { origin: "https://evil.example", "x-vercel-forwarded-for": "203.0.113.7" } }))).toMatchObject({ status: 403 });
    expect(await run(request(undefined, { url: "/api/invitation-preview?token=x" }))).toMatchObject({ status: 400 });
    expect(await run(request(undefined, { headers: { origin: PORTAL_ORIGIN } }))).toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    backend();
    expect(await run(request(JSON.stringify({ token: TOKEN, pad: "x".repeat(5000) })))).toMatchObject({ status: 410 });
    backend();
    expect(await run(request(JSON.stringify({ token: TOKEN })))).toMatchObject({ status: 200 });
    backend();
    expect(await run(request("{not json"))).toMatchObject({ status: 410 });
  });

  it("is not configured without its secrets", async () => {
    backend();
    vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "short");
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "not-configured" } });
    vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "");
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "not-configured" } });
    vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "rate-secret-at-least-32-characters-long");
    vi.stubEnv("INVITATION_APP_ORIGIN", `${PORTAL_ORIGIN}/path`);
    expect(await run(request(undefined, { headers: { origin: `${PORTAL_ORIGIN}/path`, "x-vercel-forwarded-for": "203.0.113.7" } }))).toMatchObject({ status: 503 });
  });
});

describe("the described invitation", () => {
  it("keeps only display text and a known role", () => {
    expect(invitationPreviewBody({ ...PREVIEW, role: "owner", inviterName: "rosa@example.com", chapterName: null })).toEqual({
      organization: "Thornbury Nurses United", chapter: null, role: "member", email: "new.member@example.com", inviter: null,
    });
    expect(invitationPreviewBody({ ...PREVIEW, role: null, inviterName: "Bad\u0007Name" })).toMatchObject({ role: "member", inviter: null });
    expect(invitationPreviewBody({ ...PREVIEW, inviterName: "x".repeat(161) })).toMatchObject({ inviter: null });
    expect(invitationPreviewBody({ ...PREVIEW, inviterName: "  " })).toMatchObject({ inviter: null });
  });

  it("describes nothing without an available invitation, an address and an organization", () => {
    expect(invitationPreviewBody(null)).toBeNull();
    expect(invitationPreviewBody({ ...PREVIEW, available: false })).toBeNull();
    expect(invitationPreviewBody({ ...PREVIEW, email: "" })).toBeNull();
    expect(invitationPreviewBody({ ...PREVIEW, organizationName: 42 })).toBeNull();
  });
});
