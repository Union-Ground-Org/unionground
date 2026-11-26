// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/invite-request.js";
import { inviteRequestEmail, inviteRequestFields, scheduleInviteRequestEmail } from "../api/_lib/inviteRequest.js";
import { findMigrationName, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF, SUPPORT_EMAIL } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
// Union Ground publishes no support mailbox. A suite that sends to one
// publishes the fictional mailbox; the "no mailbox" test switches it off.
const mailbox = vi.hoisted(() => ({ published: true }));
vi.mock("../src/lib/publicContact.js", async () => {
  const fictional = (await import("./helpers/fictional-provider.js")).publicContactModule();
  return { ...fictional, publicContact: (role) => (mailbox.published ? fictional.publicContact(role) : null) };
});
// The store runs only on its legal path. The real checkout holds that path
// pending; a case that sets legalGate.open stands in for a live, verified
// release of it.
const legalGate = vi.hoisted(() => ({ open: false, paths: [] }));
vi.mock("../api/_lib/legalReleaseGate.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runVerifiedServerLegalOperation: async (config, pathId, operation, root) => {
      legalGate.paths.push(pathId);
      return legalGate.open
        ? { ran: true, plane: "server", reason: "released", result: operation() }
        : actual.runVerifiedServerLegalOperation(config, pathId, operation, root);
    },
  };
});

function response(payload, status = 200) {
  const body = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => payload };
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

function request(body = {}, overrides = {}) {
  return {
    method: "POST",
    url: "/api/invite-request",
    headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN },
    body: {
      name: " Alex Rivera ",
      email: " Alex@Example.org ",
      organization: " Example Workers Local 12 ",
      note: "Steward at the north site.\r\nStarting next month.",
      locale: "es",
      website: "",
      ...body,
    },
    ...overrides,
  };
}

// The database limiter (consume_invite_request_attempt) answers `allow` for
// every charge; every other request goes to `mail`. `charges` records each.
let charges = [];
function withLimiter(mail, allow = () => true) {
  return vi.fn(async (url, init) => {
    if (String(url) === `${SUPABASE_ORIGIN}/rest/v1/rpc/consume_invite_request_attempt`) {
      const body = JSON.parse(init.body);
      charges.push(body);
      return response(allow(body));
    }
    return mail(url, init);
  });
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  mailbox.published = true;
  charges = [];
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", PORTAL_ORIGIN);
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", `Union Ground <alerts@${PORTAL_HOST}>`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /api/invite-request", () => {
  it("emails the request to the support mailbox with the requester as Reply-To", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T23:30:00Z"));
    const calls = [];
    vi.stubGlobal("fetch", withLimiter(async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return response({ id: "mail-1" });
    }));

    const out = await run(request());

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ accepted: true });
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const message = calls[0].body;
    expect(message.to).toEqual([SUPPORT_EMAIL]);
    expect(message.from).toBe(`Union Ground <alerts@${PORTAL_HOST}>`);
    expect(message.reply_to).toBe("alex@example.org");
    expect(message.subject).toBe("Invite request: Alex Rivera (Example Workers Local 12)");
    expect(message.text).toContain("Email: alex@example.org");
    expect(message.text).toContain("Language: Spanish");
    expect(message.text).toContain("Received: Oct 1, 2026, 7:30 PM ET");
    expect(message.text).toContain("Steward at the north site.\nStarting next month.");
    expect(calls[0].init.headers["Idempotency-Key"]).toMatch(/^ug-invite-request-[0-9a-f]{40}$/);
  });

  it("collapses the same address and organization to one email a day", async () => {
    const keys = [];
    vi.stubGlobal("fetch", withLimiter(async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"]);
      return response({ id: "mail" });
    }));
    await run(request());
    await run(request({ email: "alex@example.org", organization: "example workers local 12", note: "" }));
    await run(request({ organization: "Another Local" }));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("answers the honeypot like a success and sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({ website: "https://spam.example" }));
    expect(out).toMatchObject({ status: 202, body: { accepted: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing name", { name: " " }],
    ["a one-letter name", { name: "A" }],
    ["a bad email", { email: "not-an-email" }],
    ["a missing organization", { organization: "" }],
    ["a control character", { name: "Alex\u0007Rivera" }],
    ["a C1 control character", { note: "call\u0085back" }],
    ["an oversized note", { note: "x".repeat(1001) }],
    ["an oversized organization", { organization: "x".repeat(161) }],
  ])("refuses %s without sending", async (_label, body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request(body));
    expect(out).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses other origins, query strings, other methods and a non-object body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run(request({}, { headers: { host: PORTAL_HOST, origin: "https://evil.example" } }))).status).toBe(403);
    expect((await run(request({}, { headers: { host: PORTAL_HOST } }))).status).toBe(403);
    expect((await run(request({}, { url: "/api/invite-request?x=1" }))).status).toBe(400);
    expect((await run(request({}, { method: "GET" }))).status).toBe(405);
    expect((await run(request({}, { body: "[1]" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not available on the SAMPLE demo origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request({}, { headers: { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN } }));
    expect(out).toMatchObject({ status: 404, body: { error: "not-available" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when mail is not configured and 502 when delivery fails", async () => {
    vi.stubGlobal("fetch", withLimiter(async () => response({ error: "down" }, 500)));
    expect((await run(request())).body).toEqual({ error: "delivery-unavailable" });
    vi.stubGlobal("fetch", withLimiter(async () => { throw new Error("network"); }));
    expect((await run(request())).status).toBe(502);
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await run(request())).body).toEqual({ error: "request-unavailable" });
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", `${PORTAL_ORIGIN}/path`);
    expect((await run(request())).status).toBe(503);
  });
});

describe("POST /api/invite-request rate limit", () => {
  it("charges the network bucket, then the normalized address, before sending", async () => {
    const mail = vi.fn(async () => response({ id: "mail" }));
    vi.stubGlobal("fetch", withLimiter(mail));
    const out = await run(request({}, { socket: { remoteAddress: "203.0.113.9" } }));
    expect(out).toMatchObject({ status: 202, body: { accepted: true } });
    expect(charges).toEqual([
      { p_scope: "network", p_key: "ipv4:203.0.113.9" },
      { p_scope: "email", p_key: "alex@example.org" },
    ]);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("answers 429 and sends nothing when the network is over its limit, without charging the address", async () => {
    const mail = vi.fn(async () => response({ id: "mail" }));
    vi.stubGlobal("fetch", withLimiter(mail, (body) => body.p_scope !== "network"));
    expect(await run(request())).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(charges).toEqual([{ p_scope: "network", p_key: "unknown" }]);
    expect(mail).not.toHaveBeenCalled();
  });

  it("answers 429 and sends nothing when the address is over its limit", async () => {
    const mail = vi.fn(async () => response({ id: "mail" }));
    vi.stubGlobal("fetch", withLimiter(mail, (body) => body.p_scope !== "email"));
    expect(await run(request())).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(mail).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter cannot answer or the backend is not configured", async () => {
    const mail = vi.fn(async () => response({ id: "mail" }));
    vi.stubGlobal("fetch", withLimiter(mail, () => ({ unexpected: true })));
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "request-unavailable" } });
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("/rpc/") ? response({ message: "missing" }, 404) : mail())));
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "request-unavailable" } });
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "request-unavailable" } });
    expect(mail).not.toHaveBeenCalled();
  });
});

describe("invite request limiter migration", () => {
  it("adds a service-role-only limiter on the HMAC-keyed attempt throttle", () => {
    expect(findMigrationName("invite_request_rate_limit")).toBe("20261125120200_invite_request_rate_limit.sql");
    const sql = stripComments(loadMigrationSql("invite_request_rate_limit"));
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const body = latestFnBody("public.consume_invite_request_attempt(");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("<> 'service_role' then");
    expect(body).toContain("private.auth_attempt_check('invite-request-network', v_key, 10, interval '1 hour')");
    expect(body).toContain("private.auth_attempt_check('invite-request-email', v_key, 3, interval '1 day')");
    expect(sql).toContain("revoke all on function public.consume_invite_request_attempt(text, text)\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.consume_invite_request_attempt(text, text) to service_role;");
    expect(sql).not.toMatch(/grant execute on function public\.consume_invite_request_attempt\(text, text\) to (anon|authenticated)/);
  });
});

describe("POST /api/invite-request without a published mailbox", () => {
  it("answers request-unavailable and sends nothing while no support mailbox is published", async () => {
    mailbox.published = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request());
    expect(out).toMatchObject({ status: 503, body: { error: "request-unavailable" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("invite request edge answers", () => {
  it("refuses a body that is not JSON and answers 503 for an origin setting that is not a URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request({}, { body: "{not json" }))).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", "not a url");
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "request-unavailable" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles a scheduled email to false when sending throws, even outside the Vercel runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const fields = inviteRequestFields({ name: "Alex Rivera", email: "alex@example.org", organization: "Example Workers Local 12" });
    const pending = scheduleInviteRequestEmail({
      resendKey: "resend-key", from: "Union Ground <alerts@unionground.test>", to: SUPPORT_EMAIL, request: fields,
      waitUntilImpl: () => { throw new Error("outside the runtime"); },
    });
    await expect(pending).resolves.toBe(false);
  });
});

describe("invite request email", () => {
  it("escapes every requester value in the HTML", () => {
    const fields = inviteRequestFields({
      name: "<script>x</script>",
      email: "a@example.org",
      organization: "\"Local\" & <b>Co</b>",
      note: "<img src=x onerror=alert(1)>",
    });
    const { html, subject } = inviteRequestEmail(fields, "Oct 1, 2026, 7:30 PM ET");
    expect(html).not.toMatch(/<script>|<img src=x|<b>Co/);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&quot;Local&quot; &amp; &lt;b&gt;Co&lt;/b&gt;");
    expect(subject.length).toBeLessThanOrEqual(150);
  });

  it("keeps a long subject bounded", () => {
    const fields = inviteRequestFields({ name: "N".repeat(120), email: "a@example.org", organization: "O".repeat(160) });
    expect([...inviteRequestEmail(fields, "now").subject]).toHaveLength(150);
  });
});
