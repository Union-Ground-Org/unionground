// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import sharp from "sharp";
import handler from "../api/admin-invitations.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";
import { deskInvitationNames } from "../api/_lib/memberInvitations.js";
import { DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";

vi.mock("../api/_lib/memberInvitations.js", async (importOriginal) => ({
  ...await importOriginal(), deskInvitationNames: vi.fn(),
}));

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/emailLinkHosts.js", async () => (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());

const SUPABASE = SUPABASE_ORIGIN;
const UUID = "10000000-0000-4000-8000-000000000001";

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

function request(body, token = "member-token") {
  return {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  vi.mocked(deskInvitationNames).mockResolvedValue({
    organization: "Example Workers", inviter: "Alex Rivera", source: "administrator",
  });
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", `Union Ground <alerts@${PORTAL_HOST}>`);
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("admin invitation endpoint", () => {
  it("rejects non-POST and missing caller tokens before any provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ method: "GET", headers: {}, body: {} })).status).toBe(405);
    expect((await run(request({ action: "create" }, null))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reserves with the caller token, emails a fragment secret, and records delivery", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("create_member_invitation")) {
        return response({ accepted: true, send: true, invitationId: UUID, deliveryVersion: 1, expiresAt: "2026-08-12T19:15:00Z" });
      }
      if (String(url) === "https://api.resend.com/emails") return response({ id: "mail-1" });
      if (String(url).includes("record_member_invitation_delivery")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(request({
      action: "create", email: " New.Member@Example.com ", fullName: "New Member",
      chapterId: "wor", initialRole: "", locale: "es",
    }));

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ accepted: true });
    expect(calls.map((call) => call.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/create_member_invitation`,
      "https://api.resend.com/emails",
      `${SUPABASE}/rest/v1/rpc/record_member_invitation_delivery`,
    ]);
    expect(calls[0].init.headers).toMatchObject({ apikey: "publishable-key", Authorization: "Bearer member-token" });
    expect(calls[0].body).toMatchObject({
      p_email: "new.member@example.com", p_full_name: "New Member", p_chapter_id: "wor",
      p_initial_role: null, p_locale: "es",
    });
    expect(calls[0].body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const message = calls[1].body;
    expect(deskInvitationNames).toHaveBeenCalledWith(SUPABASE, "publishable-key", "member-token");
    expect(message.subject).toContain("Example Workers");
    for (const body of [message.text, message.html]) {
      expect(body).toContain("Example Workers");
      expect(body).toContain("Alex Rivera");
      expect(body).toContain("contraseña de acceso en otro correo");
    }
    expect(message.to).toEqual(["new.member@example.com"]);
    expect(message.subject).toMatch(/Union Ground/i);
    expect(message.text).toContain(`${PORTAL_ORIGIN}/app/invite#invite=`);
    expect(message.html).toContain(`${PORTAL_ORIGIN}/app/invite#invite=`);
    expect(message.text).not.toContain("?invite=");
    const inviteUrl = message.text.match(new RegExp(`${PORTAL_ORIGIN.replaceAll(".", "\\.").replaceAll("/", "\\/")}\\/app\\/invite#invite=[A-Za-z0-9_-]+`))[0];
    const secret = new URL(inviteUrl).hash.slice("#invite=".length);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(calls[0].body)).not.toContain(secret);
    expect(JSON.stringify(calls[2].body)).not.toContain(secret);
    expect(calls[1].init.headers["Idempotency-Key"]).toBe(`sg-invite-${UUID}-1`);
    expect(calls[2].body).toEqual({ p_invitation_id: UUID, p_delivery_version: 1, p_outcome: "sent" });

    // The "Get Union Ground" block: the website and /get-app links, and an inline
    // QR code that opens the public /get-app page — never the private link.
    expect(message.text).toContain(`Sitio web: ${PORTAL_ORIGIN}/`);
    expect(message.text).toContain(`En tu teléfono: ${PORTAL_ORIGIN}/get-app`);
    expect(message.html).toContain('src="cid:union-ground-app-qr"');
    expect(message.attachments).toHaveLength(1);
    const [qr] = message.attachments;
    expect(qr).toMatchObject({ filename: "union-ground-app.png", content_id: "union-ground-app-qr" });
    const { data, info } = await sharp(Buffer.from(qr.content, "base64")).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(`${PORTAL_ORIGIN}/get-app`);
    expect(qr.content).not.toContain(secret);
  });

  it("returns the same accepted shape for existing identities and live duplicates", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true, send: false }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({
      action: "create", email: "member@example.com", fullName: "Member Name",
      chapterId: "wor", initialRole: null, locale: "en",
    }));
    expect(out.status).toBe(202);
    expect(out.body).toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // BUG-UG-ADMIN-INVITATIONS-503-THEN-202-20261003: during the
  // October 3 apply window the create RPC timed out twice and then succeeded.
  // A failed create sends no email, and the retry that follows a send the
  // server already holds answers accepted without a second email.
  it("sends nothing when the create times out, and a retry after a held send sends nothing again", async () => {
    const timedOut = vi.fn(async () => response({ code: "57014", message: "canceling statement due to statement timeout" }, 500));
    vi.stubGlobal("fetch", timedOut);
    const fields = { action: "create", email: "keisha@example.org", fullName: "Keisha Monroe", chapterId: "wor", initialRole: null, locale: "en" };
    const first = await run(request(fields));
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ error: "service-unavailable" });
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(timedOut.mock.calls.some(([url]) => String(url).includes("resend.com"))).toBe(false);

    const held = vi.fn(async () => response({ accepted: true, send: false }));
    vi.stubGlobal("fetch", held);
    const retry = await run(request(fields));
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual({ accepted: true });
    expect(held).toHaveBeenCalledTimes(1);
  });

  // An administrator may invite someone
  // as an Organizer. Admin is still never a starting hat.
  it("passes the Organizer hat through as starting access and still refuses admin", async () => {
    const held = vi.fn(async () => response({ accepted: true, send: false }));
    vi.stubGlobal("fetch", held);
    const fields = { action: "create", email: "organizer@example.org", fullName: "Rosa Organizer", chapterId: "wor", locale: "en" };
    const organizer = await run(request({ ...fields, initialRole: "organizer" }));
    expect(organizer.status).toBe(202);
    expect(JSON.parse(held.mock.calls[0][1].body)).toMatchObject({ p_initial_role: "organizer" });

    const refused = vi.fn();
    vi.stubGlobal("fetch", refused);
    const admin = await run(request({ ...fields, initialRole: "admin" }));
    expect(admin).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(refused).not.toHaveBeenCalled();
  });

  it("flattens admin, MFA, and chapter denials before touching Resend", async () => {
    const fetchMock = vi.fn(async () => response({ message: "foreign chapter" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({
      action: "create", email: "member@example.com", fullName: "Member Name",
      chapterId: "foreign", initialRole: null, locale: "en",
    }));
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "not-permitted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a provider failure without echoing provider or recipient detail", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("create_member_invitation")) {
        return response({ accepted: true, send: true, invitationId: UUID, deliveryVersion: 1 });
      }
      if (String(url) === "https://api.resend.com/emails") {
        return response({ message: "SMTP rejected private@example.com with provider-secret" }, 503);
      }
      if (String(url).includes("record_member_invitation_delivery")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await run(request({
      action: "create", email: "private@example.com", fullName: "Private Member",
      chapterId: "wor", initialRole: null, locale: "en",
    }));
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "delivery-unavailable" });
    expect(calls.at(-1).body.p_outcome).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("private@example.com");
    expect(JSON.stringify(out)).not.toContain("provider-secret");
    expect(logged).not.toHaveBeenCalled();
  });

  it("rotates and sends a resend using only the same-chapter RPC result", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("resend_member_invitation")) return response({
        accepted: true, send: true, invitationId: UUID, deliveryVersion: 2,
        normalizedEmail: "member@example.com", fullName: "Member Name", locale: "en",
      });
      if (String(url) === "https://api.resend.com/emails") return response({ id: "mail-2" });
      if (String(url).includes("record_member_invitation_delivery")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request({ action: "resend", invitationId: UUID }));
    expect(out.status).toBe(202);
    expect(out.body).toEqual({ accepted: true });
    expect(calls[0].body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[1].init.headers["Idempotency-Key"]).toBe(`sg-invite-${UUID}-2`);
    expect(calls[1].body.to).toEqual(["member@example.com"]);
  });

  it("revokes through the caller-bound RPC and never touches email/Auth providers", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true, revoked: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({ action: "revoke", invitationId: UUID }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("revoke_member_invitation");
  });

  it("keeps revocation available when the outbound email provider is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("NOTIFY_FROM_ADDRESS", undefined);
    const fetchMock = vi.fn(async () => response({ accepted: true, revoked: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({ action: "revoke", invitationId: UUID }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  function sampleRequest(body, token = "member-token") {
    return { method: "POST", headers: { host: SAMPLE_HOST, authorization: `Bearer ${token}` }, body };
  }

  it("refuses every invitation action on the SAMPLE surface and never touches a provider", async () => {
    // A fully-configured SAMPLE backend (and even production email env present)
    // must not open any invitation path: invitations are production-only, so
    // the SAMPLE surface can never send through the production Resend account
    // or mint an accept link.
    vi.stubEnv("SAMPLE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_SAMPLE_REF));
    vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sample-service");
    const fetchMock = vi.fn(async () => response({ accepted: true, send: true, invitationId: UUID, deliveryVersion: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const body of [
      { action: "create", email: "sample.member@example.com", fullName: "Sample Member", chapterId: "wor", initialRole: null, locale: "en" },
      { action: "resend", invitationId: UUID },
      { action: "revoke", invitationId: UUID },
    ]) {
      const out = await run(sampleRequest(body));
      expect(out.status).toBe(404);
      expect(out.body).toEqual({ error: "not-available" });
    }
    // Not a single RPC or Resend call happened on the SAMPLE surface.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("organization admin re-invitation of a former member", () => {
  it("routes a former-member invitation to the organization-admin RPC with no name and no starting access", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("create_former_member_invitation")) {
        return response({ accepted: true, send: true, invitationId: UUID, deliveryVersion: 1, expiresAt: "2026-09-27T15:15:00Z" });
      }
      if (String(url) === "https://api.resend.com/emails") return response({ id: "mail-9" });
      if (String(url).includes("record_member_invitation_delivery")) return response({ recorded: true });
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(request({
      action: "create", email: " Former.Member@Example.com ", chapterId: "wor", locale: "en", formerMember: true,
    }));

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ accepted: true });
    expect(calls.map((call) => call.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/create_former_member_invitation`,
      "https://api.resend.com/emails",
      `${SUPABASE}/rest/v1/rpc/record_member_invitation_delivery`,
    ]);
    expect(calls[0].init.headers).toMatchObject({ apikey: "publishable-key", Authorization: "Bearer member-token" });
    expect(calls[0].body).toEqual({
      p_email: "former.member@example.com", p_chapter_id: "wor", p_locale: "en",
      p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(calls[0].body)).not.toContain("p_full_name");
    expect(JSON.stringify(calls[0].body)).not.toContain("p_initial_role");
  });

  it("refuses a former-member invitation that asks for starting access before any provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({
      action: "create", email: "former.member@example.com", chapterId: "wor", locale: "en", formerMember: true, initialRole: "steward",
    }));
    expect(out).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the organization-admin refusal of a former-member invitation to not-permitted", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("create_former_member_invitation")) return response({ message: "organization admin role required" }, 403);
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request({ action: "create", email: "former.member@example.com", chapterId: "wor", locale: "es", formerMember: true }));
    expect(out).toMatchObject({ status: 403, body: { error: "not-permitted" } });
  });
});
