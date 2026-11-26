// @vitest-environment node
// scripts/invite-organization-founder.mjs: the operator command that starts a
// new organization by inviting its founder. The network is faked; nothing
// leaves the process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, PHONE_NUMBER_DETAIL, PHONE_NUMBER_REFUSAL, readConfig, run } from "../scripts/invite-organization-founder.mjs";
import { keyFingerprint } from "../scripts/lib/supabase-server-key.mjs";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The command's backend must pass the API's provider rule: an approved
// fictional pair here (tests/provider-boundary-fail-closed.test.js proves the
// refusals under the shipped empty table).
// HOSTED_ORIGIN is a fictional hosted-shape project (a 20-letter ref) for the
// Management API key path; it is approved here the same way.
vi.mock("../src/lib/trustedBackends.js", async () =>
  (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://examplehostedproject.supabase.co"));
const HOSTED_REF = "examplehostedproject";
const HOSTED_ORIGIN = `https://${HOSTED_REF}.supabase.co`;

const ENV = {
  VITE_SUPABASE_URL: SUPABASE_ORIGIN,
  UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
  SUPABASE_SERVICE_ROLE_KEY: "service-key-fixture",
  RESEND_API_KEY: "resend-key-fixture",
  NOTIFY_FROM_ADDRESS: "Union Ground <notify@example.invalid>",
  INVITATION_APP_ORIGIN: "https://app.example.invalid",
};
const ORG = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const CREATE = ["create", "--organization", "Example Workers Union", "--email", "Founder@Example.invalid", "--name", "Example Founder"];

// `errors` answers an RPC with a PostgREST error body and status instead.
function fakeNetwork({ rpc = {}, errors = {}, resendOk = true, organizationOk = true } = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init?.headers, body });
    if (String(url).includes("/rest/v1/organizations?")) {
      return new Response(JSON.stringify([{ name: "Example Workers Union" }]), { status: organizationOk ? 200 : 503 });
    }
    if (String(url).startsWith("https://api.resend.com/")) {
      return new Response(JSON.stringify({ id: "email" }), { status: resendOk ? 200 : 500 });
    }
    const name = String(url).split("/rpc/")[1];
    if (errors[name]) return new Response(JSON.stringify(errors[name]), { status: 400, headers: { "Content-Type": "application/json" } });
    const answer = rpc[name] ?? { recorded: true };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const invited = {
  status: "invited", send: true, organizationId: ORG, chapterId: "c-0123456789",
  invitationId: INVITATION, deliveryVersion: 1, expiresAt: "2026-10-03T15:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("invite-organization-founder command", () => {
  it("parses commands and flags, and refuses stray arguments", () => {
    expect(parseArgs(["create", "--email", "a@b.co", "--dry-run"])).toEqual({ command: "create", flags: { email: "a@b.co", dryRun: true } });
    expect(() => parseArgs(["create", "stray"])).toThrow("unexpected argument");
    expect(() => parseArgs(["create", "--email"])).toThrow("unexpected argument");
    expect(() => parseArgs(["create", "--name", "--dry-run"])).toThrow("unexpected argument: --name");
  });

  it("needs every environment value and a bare app origin", () => {
    expect(() => readConfig({})).toThrow("missing environment: SUPABASE_URL or VITE_SUPABASE_URL, RESEND_API_KEY, NOTIFY_FROM_ADDRESS, INVITATION_APP_ORIGIN");
    expect(() => readConfig({ ...ENV, INVITATION_APP_ORIGIN: "https://app.example.invalid/m" })).toThrow("bare origin");
    expect(readConfig(ENV).supabaseUrl).toBe(SUPABASE_ORIGIN);
  });

  it("validates flags before touching the network, and a dry run resolves the key but writes nothing", async () => {
    const calls = fakeNetwork();
    await expect(run(["create", "--organization", "x", "--email", "a@b.co", "--name", "Ann Lee"], ENV, () => {})).rejects.toThrow("--organization");
    await expect(run(["create", "--organization", "Example Union", "--email", "nope", "--name", "Ann Lee"], ENV, () => {})).rejects.toThrow("--email");
    await expect(run([...CREATE, "--locale", "fr"], ENV, () => {})).rejects.toThrow("--locale");
    await expect(run([...CREATE, "--key", "not-a-uuid"], ENV, () => {})).rejects.toThrow("--key");
    const offline = [];
    expect(await run([...CREATE, "--dry-run"], {}, (line) => offline.push(line))).toBe(0);
    expect(offline[0]).toBe("Server key: not checked (missing environment: SUPABASE_URL or VITE_SUPABASE_URL, RESEND_API_KEY, NOTIFY_FROM_ADDRESS, INVITATION_APP_ORIGIN).");
    expect(offline[1]).toContain("Dry run: would start");
    await expect(run(CREATE, { VITE_SUPABASE_URL: ENV.VITE_SUPABASE_URL }, () => {})).rejects.toThrow("missing environment");
    const lines = [];
    expect(await run([...CREATE, "--dry-run"], ENV, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([
      `Server key: SUPABASE_SERVICE_ROLE_KEY from the environment, fingerprint ${keyFingerprint(ENV.SUPABASE_SERVICE_ROLE_KEY)}.`,
      'Dry run: would start "Example Workers Union" and invite founder@example.invalid (en) as its founder. Nothing was created.',
    ]);
    expect(await run(["resend", "--invitation", INVITATION, "--dry-run"], ENV, (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toBe(`Dry run: would resend founder invitation ${INVITATION}. Nothing was sent.`);
    expect(calls).toEqual([]);
  });

  it("reads an empty server key from the Management API for the project the URL names, printing only its fingerprint", async () => {
    const secret = "sb_secret_fictionalExampleKey0001";
    const management = vi.fn(async () => ({ ok: true, status: 200, json: async () => [
      { type: "legacy", name: "service_role", api_key: "eyJ.legacy.fictional" },
      { type: "secret", name: "union_base_vercel_20261016", api_key: secret },
    ] }));
    const calls = fakeNetwork();
    const hosted = { ...ENV, VITE_SUPABASE_URL: HOSTED_ORIGIN, UNIONGROUND_SUPABASE_PROJECT_REF: HOSTED_REF, SUPABASE_SERVICE_ROLE_KEY: "" };
    const lines = [];
    expect(await run([...CREATE, "--dry-run"], hosted, (line) => lines.push(line), { token: () => "management-token-fixture", fetchImpl: management })).toBe(0);
    expect(management).toHaveBeenCalledTimes(1);
    expect(management.mock.calls[0][0]).toBe(`https://api.supabase.com/v1/projects/${HOSTED_REF}/api-keys?reveal=true`);
    expect(lines[0]).toBe(`Server key: secret key "union_base_vercel_20261016" from the Management API for project ${HOSTED_REF}, fingerprint ${keyFingerprint(secret)}.`);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("management-token-fixture");
    expect(calls).toEqual([]);
  });

  it("fails safely, without key material, when no key source fits", async () => {
    const noToken = () => { throw new Error("supabase-server-key: supabase-cli-token-missing"); };
    await expect(run([...CREATE, "--dry-run"], { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, () => {}, { token: noToken }))
      .rejects.toThrow("supabase-server-key: no-key-source");
    const hosted = { ...ENV, VITE_SUPABASE_URL: HOSTED_ORIGIN, UNIONGROUND_SUPABASE_PROJECT_REF: HOSTED_REF };
    await expect(run([...CREATE, "--dry-run"], { ...hosted, SUPABASE_SERVICE_ROLE_KEY: "" }, () => {}, { token: noToken }))
      .rejects.toThrow("supabase-server-key: supabase-cli-token-missing");
    // A legacy JWT in the environment is refused for a hosted project, and the message never echoes it.
    const refusal = await run([...CREATE, "--dry-run"], hosted, () => {}).catch((error) => error.message);
    expect(refusal).toContain("environment-key-not-secret");
    expect(refusal).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    const denied = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await expect(run([...CREATE, "--dry-run"], { ...hosted, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SERVER_KEY_NAME: "missing" }, () => {},
      { token: () => "t", fetchImpl: denied })).rejects.toThrow("supabase-server-key: api-keys-http-403");
  });

  it("creates the organization, emails the one-time link and records the delivery, logging ids only", async () => {
    const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: invited } });
    const lines = [];
    expect(await run([...CREATE, "--locale", "es"], ENV, (line) => lines.push(line))).toBe(0);

    const [create, organization, email, record] = calls;
    expect(organization.url).toBe(`${SUPABASE_ORIGIN}/rest/v1/organizations?select=name&id=eq.${ORG}&limit=1`);
    expect(organization.headers.Authorization).toBe("Bearer service-key-fixture");
    expect(create.url).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/create_organization_founder_invitation`);
    expect(create.body).toMatchObject({ p_organization_name: "Example Workers Union", p_email: "founder@example.invalid", p_full_name: "Example Founder", p_locale: "es" });
    expect(create.body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.body.p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);

    expect(email.url).toBe("https://api.resend.com/emails");
    expect(email.body.to).toEqual(["founder@example.invalid"]);
    expect(email.body.subject).toContain("Example Workers Union");
    for (const body of [email.body.text, email.body.html]) {
      expect(body).toContain("Union Ground te invita a configurar Example Workers Union");
      expect(body).toContain("contraseña de acceso en otro correo");
      expect(body).not.toContain("Example Founder");
    }
    const link = email.body.text.match(/https:\/\/app\.example\.invalid\/app\/invite#invite=[A-Za-z0-9_-]{43}/)?.[0];
    expect(link).toBeTruthy();
    expect(email.headers["Idempotency-Key"]).toBe(`sg-invite-${INVITATION}-1`);

    expect(record.url).toContain("/rpc/record_organization_founder_invitation_delivery");
    expect(record.body).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 1, p_outcome: "sent" });

    const output = lines.join("\n");
    expect(lines[0]).toBe(`Server key: SUPABASE_SERVICE_ROLE_KEY from the environment, fingerprint ${keyFingerprint(ENV.SUPABASE_SERVICE_ROLE_KEY)}.`);
    expect(lines[1]).toMatch(/^Key [0-9a-f-]{36}\. If this command is interrupted, rerun it with --key [0-9a-f-]{36}\.$/);
    expect(lines[1]).toContain(create.body.p_idempotency_key);
    expect(output).toContain(ORG);
    expect(output).toContain(INVITATION);
    expect(output).not.toContain(link);
    expect(output).not.toContain(link.split("=")[1]);
    expect(output).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it("records a refused email as failed and exits non-zero", async () => {
    const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: invited }, resendOk: false });
    const lines = [];
    expect(await run(CREATE, ENV, (line) => lines.push(line))).toBe(1);
    expect(calls.at(-1).body).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 1, p_outcome: "failed" });
    expect(lines.at(-1)).toContain("Nothing was sent");
  });

  it("reports a taken name or address without sending anything", async () => {
    for (const status of ["name_unavailable", "email_unavailable"]) {
      const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: { status } } });
      const lines = [];
      expect(await run(CREATE, ENV, (line) => lines.push(line))).toBe(2);
      expect(calls).toHaveLength(1);
      expect(lines.at(-1)).toContain("Nothing was created");
      vi.unstubAllGlobals();
    }
  });

  // #9164: the database's phone-number detail becomes a plain refusal; any
  // other refusal still fails with the call's code.
  it("says in plain words when the organization name holds a phone number", async () => {
    const phone = { code: "22023", message: "invalid founder invitation", details: PHONE_NUMBER_DETAIL };
    const calls = fakeNetwork({ errors: { create_organization_founder_invitation: phone } });
    const lines = [];
    expect(await run(CREATE, ENV, (line) => lines.push(line))).toBe(2);
    expect(calls).toHaveLength(1);
    expect(lines.at(-1)).toBe(PHONE_NUMBER_REFUSAL);
    expect(PHONE_NUMBER_REFUSAL).toContain("holds a phone number");
    expect(PHONE_NUMBER_REFUSAL).toContain("Nothing was created");
    vi.unstubAllGlobals();
    fakeNetwork({ errors: { create_organization_founder_invitation: { code: "22023", message: "invalid founder invitation", details: null } } });
    await expect(run(CREATE, ENV, () => {})).rejects.toThrow("create_organization_founder_invitation-failed");
  });

  it("does not resend on an idempotent replay", async () => {
    const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: { ...invited, send: false, idempotent: true } } });
    const lines = [];
    expect(await run([...CREATE, "--key", "33333333-3333-4333-8333-333333333333"], ENV, (line) => lines.push(line))).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.p_idempotency_key).toBe("33333333-3333-4333-8333-333333333333");
    expect(lines.at(-1)).toContain(`resend --invitation ${INVITATION}`);
  });

  it("resends a founder invitation to the address the database holds", async () => {
    const calls = fakeNetwork({ rpc: { resend_organization_founder_invitation: {
      ...invited, deliveryVersion: 2, normalizedEmail: "founder@example.invalid", locale: "en",
    } } });
    expect(await run(["resend", "--invitation", INVITATION], ENV, () => {})).toBe(0);
    expect(calls[0].body).toMatchObject({ p_invitation_id: INVITATION });
    expect(calls[2].body.to).toEqual(["founder@example.invalid"]);
    expect(calls[2].body.text).toContain("Union Ground is inviting you to set up Example Workers Union");
    expect(calls[3].body).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 2, p_outcome: "sent" });

    vi.unstubAllGlobals();
    const refused = fakeNetwork({ rpc: { resend_organization_founder_invitation: { status: "unavailable", send: false } } });
    const refusalLines = [];
    expect(await run(["resend", "--invitation", INVITATION], ENV, (line) => refusalLines.push(line))).toBe(2);
    expect(refused).toHaveLength(1);
    expect(refusalLines.at(-1)).toContain("or the address asked to stop mail");
  });

  it("records a failed delivery when the trusted organization name cannot be read", async () => {
    const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: invited }, organizationOk: false });
    expect(await run(CREATE, ENV, () => {})).toBe(1);
    expect(calls.some((call) => call.url.includes("api.resend.com"))).toBe(false);
    expect(calls.at(-1).body.p_outcome).toBe("failed");
  });
  // REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
  describe("from-request", () => {
    const REQUEST = "44444444-4444-4444-8444-444444444444";
    const waiting = {
      id: REQUEST, status: "pending", contactName: "Dana Ruiz", contactEmail: "dana@example.invalid", locale: "es",
      unionOrgId: "office-1", officeName: "Riverside Transit Workers", invitingChapter: "Garage 7",
      offerTitle: "Shared training", onPlatform: false,
    };
    const FROM = ["from-request", "--request", REQUEST];

    it("validates flags, and a dry run reads the request but writes nothing", async () => {
      fakeNetwork();
      await expect(run(["from-request", "--request", "nope"], ENV, () => {})).rejects.toThrow("--request");
      await expect(run([...FROM, "--organization", "x"], ENV, () => {})).rejects.toThrow("--organization");
      const offline = [];
      expect(await run([...FROM, "--dry-run"], {}, (line) => offline.push(line))).toBe(0);
      expect(offline.at(-1)).toBe(`Dry run: would send partner invitation request ${REQUEST}. Nothing was read or sent.`);
      expect(await run([...FROM, "--decline", "--dry-run"], {}, (line) => offline.push(line))).toBe(0);
      expect(offline.at(-1)).toBe(`Dry run: would decline partner invitation request ${REQUEST}. Nothing was read or sent.`);
      vi.unstubAllGlobals();
      const calls = fakeNetwork({ rpc: { take_partner_invitation_request: waiting } });
      const lines = [];
      expect(await run([...FROM, "--dry-run"], ENV, (line) => lines.push(line))).toBe(0);
      expect(lines.at(-1)).toBe('Dry run: would start "Riverside Transit Workers" and invite dana@example.invalid (es) as its founder for Garage 7. Nothing was created.');
      expect(await run([...FROM, "--decline", "--dry-run"], ENV, (line) => lines.push(line))).toBe(0);
      expect(lines.at(-1)).toBe(`Dry run: would decline partner invitation request ${REQUEST} from Garage 7. Nothing was recorded.`);
      expect(calls.map((call) => call.url.split("/rpc/")[1])).toEqual(["take_partner_invitation_request", "take_partner_invitation_request"]);
    });

    it("starts the office's organization keyed by the request, names the chapter and its offer, and closes the request", async () => {
      const calls = fakeNetwork({ rpc: { take_partner_invitation_request: waiting, create_organization_founder_invitation: invited } });
      const lines = [];
      expect(await run(FROM, ENV, (line) => lines.push(line))).toBe(0);
      const names = calls.map((call) => call.url.split("/rpc/")[1] || call.url);
      expect(names).toEqual(["take_partner_invitation_request", "create_organization_founder_invitation", "note_partner_founder_invitation",
        `${SUPABASE_ORIGIN}/rest/v1/organizations?select=name&id=eq.${ORG}&limit=1`, "https://api.resend.com/emails",
        "record_organization_founder_invitation_delivery", "finish_partner_invitation_request"]);
      expect(calls[2].body).toEqual({ p_request_id: REQUEST, p_invitation_id: INVITATION });
      expect(calls[1].body).toMatchObject({ p_organization_name: "Riverside Transit Workers", p_email: "dana@example.invalid", p_full_name: "Dana Ruiz", p_locale: "es", p_idempotency_key: REQUEST });
      const email = calls[4].body;
      expect(email.to).toEqual(["dana@example.invalid"]);
      for (const body of [email.text, email.html]) {
        expect(body).toContain("Garage 7 pidió a Union Ground que te invitara");
        expect(body).toContain("Shared training");
        expect(body).not.toContain("Dana Ruiz");
      }
      expect(calls[6].body).toEqual({ p_request_id: REQUEST, p_outcome: "sent" });
      expect(lines.at(-1)).toContain("recorded as sent");
      expect(lines.join("\n")).not.toMatch(/#invite=/);
    });

    it("uses an operator-chosen organization name", async () => {
      const calls = fakeNetwork({ rpc: { take_partner_invitation_request: { ...waiting, offerTitle: null }, create_organization_founder_invitation: invited } });
      expect(await run([...FROM, "--organization", "Riverside Transit Workers Local"], ENV, () => {})).toBe(0);
      expect(calls[1].body.p_organization_name).toBe("Riverside Transit Workers Local");
      expect(calls[4].body.text).toContain("Garage 7 pidió a Union Ground");
      expect(calls[4].body.text).not.toContain("oferta de acuerdo permanente");
    });

    it("issues a fresh link on a rerun instead of starting a second organization", async () => {
      const calls = fakeNetwork({ rpc: {
        take_partner_invitation_request: waiting,
        create_organization_founder_invitation: { ...invited, send: false, idempotent: true },
        resend_organization_founder_invitation: { ...invited, deliveryVersion: 2 },
      } });
      expect(await run(FROM, ENV, () => {})).toBe(0);
      expect(calls.map((call) => call.url.split("/rpc/")[1]).filter(Boolean)).toEqual([
        "take_partner_invitation_request", "create_organization_founder_invitation", "note_partner_founder_invitation",
        "take_partner_invitation_request", "resend_organization_founder_invitation", "note_partner_founder_invitation",
        "record_organization_founder_invitation_delivery", "finish_partner_invitation_request"]);
      expect(calls[2].body).toEqual({ p_request_id: REQUEST, p_invitation_id: INVITATION });
      expect(calls[4].body).toMatchObject({ p_invitation_id: INVITATION });
      expect(calls.at(-2).body).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 2, p_outcome: "sent" });
      expect(calls.at(-1).body).toEqual({ p_request_id: REQUEST, p_outcome: "sent" });
      vi.unstubAllGlobals();
      const refused = fakeNetwork({ rpc: {
        take_partner_invitation_request: waiting,
        create_organization_founder_invitation: { ...invited, send: false },
        resend_organization_founder_invitation: { send: false },
      } });
      const refusalLines = [];
      expect(await run(FROM, ENV, (line) => refusalLines.push(line))).toBe(2);
      expect(refused).toHaveLength(5);
      expect(refusalLines.at(-1)).toContain("or the address asked to stop mail");
    });

    it("replaces the newest invitation in the chain when an earlier resend was never recorded", async () => {
      const LATEST = "77777777-7777-4777-8777-777777777777";
      let takes = 0;
      const calls = fakeNetwork({ rpc: {
        // The first read has nothing recorded; once the root is recorded the
        // database follows its resend chain to the newest invitation.
        get take_partner_invitation_request() { takes += 1; return takes === 1 ? waiting : { ...waiting, invitationId: LATEST }; },
        create_organization_founder_invitation: { ...invited, send: false, idempotent: true },
        resend_organization_founder_invitation: { ...invited, invitationId: "88888888-8888-4888-8888-888888888888", deliveryVersion: 4 },
      } });
      expect(await run(FROM, ENV, () => {})).toBe(0);
      expect(calls[4].url).toContain("/rpc/resend_organization_founder_invitation");
      expect(calls[4].body).toMatchObject({ p_invitation_id: LATEST });
      expect(calls[5].body).toEqual({ p_request_id: REQUEST, p_invitation_id: "88888888-8888-4888-8888-888888888888" });
    });

    it("resends the invitation a previous run recorded, never the first one", async () => {
      const LATEST = "55555555-5555-4555-8555-555555555555";
      const calls = fakeNetwork({ rpc: {
        take_partner_invitation_request: { ...waiting, invitationId: LATEST },
        resend_organization_founder_invitation: { ...invited, invitationId: "66666666-6666-4666-8666-666666666666", deliveryVersion: 3 },
      } });
      const lines = [];
      expect(await run(FROM, ENV, (line) => lines.push(line))).toBe(0);
      expect(calls.map((call) => call.url.split("/rpc/")[1] || call.url).filter((name) => !name.startsWith("https://"))).toEqual([
        "take_partner_invitation_request", "resend_organization_founder_invitation", "note_partner_founder_invitation",
        "record_organization_founder_invitation_delivery", "finish_partner_invitation_request"]);
      expect(calls[1].body).toMatchObject({ p_invitation_id: LATEST });
      expect(calls[2].body).toEqual({ p_request_id: REQUEST, p_invitation_id: "66666666-6666-4666-8666-666666666666" });
      expect(lines.join("\n")).toContain("version 3");
      vi.unstubAllGlobals();
      const refused = fakeNetwork({ rpc: { take_partner_invitation_request: { ...waiting, invitationId: LATEST }, resend_organization_founder_invitation: { send: false } } });
      const refusalLines = [];
      expect(await run(FROM, ENV, (line) => refusalLines.push(line))).toBe(2);
      expect(refused).toHaveLength(2);
      expect(refusalLines.at(-1)).toContain("or the address asked to stop mail");
    });

    it("keeps the request waiting when the email is refused", async () => {
      const calls = fakeNetwork({ rpc: { take_partner_invitation_request: waiting, create_organization_founder_invitation: invited }, resendOk: false });
      expect(await run(FROM, ENV, () => {})).toBe(1);
      expect(calls.at(-1).body).toEqual({ p_invitation_id: INVITATION, p_delivery_version: 1, p_outcome: "failed" });
      expect(calls.some((call) => call.url.includes("finish_partner_invitation_request"))).toBe(false);
    });

    it("refuses a missing request, an office already on the platform, a taken name or address, and an unexpected answer", async () => {
      const cases = [
        [{ take_partner_invitation_request: false }, "no waiting partner invitation request", 1],
        [{ take_partner_invitation_request: { ...waiting, onPlatform: true } }, "already on Union Ground", 1],
        [{ take_partner_invitation_request: waiting, create_organization_founder_invitation: { status: "name_unavailable" } }, "pass --organization", 2],
        [{ take_partner_invitation_request: waiting, create_organization_founder_invitation: { status: "email_unavailable" } }, "run with --decline", 2],
        [{ take_partner_invitation_request: waiting }, "holds a phone number", 2,
          { create_organization_founder_invitation: { code: "22023", message: "invalid founder invitation", details: PHONE_NUMBER_DETAIL } }],
      ];
      for (const [rpc, text, count, errors = {}] of cases) {
        const calls = fakeNetwork({ rpc, errors });
        const lines = [];
        expect(await run(FROM, ENV, (line) => lines.push(line))).toBe(2);
        expect(lines.at(-1)).toContain(text);
        expect(calls).toHaveLength(count);
        vi.unstubAllGlobals();
      }
      fakeNetwork({ rpc: { take_partner_invitation_request: waiting, create_organization_founder_invitation: { status: "odd" } } });
      await expect(run(FROM, ENV, () => {})).rejects.toThrow("unexpected response from create_organization_founder_invitation");
    });

    it("declines a request, erasing the contact, without sending anything", async () => {
      const calls = fakeNetwork({ rpc: { take_partner_invitation_request: { ...waiting, onPlatform: true } } });
      const lines = [];
      expect(await run([...FROM, "--decline"], ENV, (line) => lines.push(line))).toBe(0);
      expect(calls.map((call) => call.url.split("/rpc/")[1])).toEqual(["take_partner_invitation_request", "finish_partner_invitation_request"]);
      expect(calls[1].body).toEqual({ p_request_id: REQUEST, p_outcome: "declined" });
      expect(lines.at(-1)).toContain("declined");
    });
  });

  it("records a failed delivery when the trusted organization name cannot be read", async () => {
    const calls = fakeNetwork({ rpc: { create_organization_founder_invitation: invited }, organizationOk: false });
    expect(await run(CREATE, ENV, () => {})).toBe(1);
    expect(calls.some((call) => call.url.includes("api.resend.com"))).toBe(false);
    expect(calls.at(-1).body.p_outcome).toBe("failed");
  });
});
