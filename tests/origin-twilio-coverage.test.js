// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/twilio-send.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const MEMBER = "10000000-0000-4000-8000-000000000001";
const JOB = "20000000-0000-4000-8000-000000000002";
const ORG = "30000000-0000-4000-8000-000000000003";
const ACCOUNT = `AC${"a".repeat(32)}`;
const SID = `SM${"b".repeat(32)}`;
const SALT = "test-ledger-salt-".repeat(4);
const account = { accountSid: ACCOUNT, organizationId: ORG, fromNumber: "+15005550006", authToken: "fictional-provider-token", webhookBaseUrl: PORTAL_ORIGIN };
const prepared = { jobId: JOB, accountSid: ACCOUNT, organizationId: ORG, fromNumber: account.fromNumber };
const claimed = { ...prepared, claimed: true, toPhone: "+15005550007" };
const headers = { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer member-token" };
const body = { memberId: MEMBER, idempotencyKey: JOB, purpose: "policy_notice", body: "Policy update available." };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function run(extra = {}) {
  const res = { headers: {}, status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler({ method: "POST", headers, body, ...extra }, res);
  return { status: res.code, body: res.body, headers: res.headers };
}
function upstream(overrides = {}) {
  const routes = { prepare_twilio_sms_send: prepared, claim_twilio_sms_send: claimed,
    record_twilio_sms_send_result: true, provider: { sid: SID, status: "queued" }, ...overrides };
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const key = url.includes("/rpc/") ? url.split("/rpc/")[1] : "provider";
    calls.push({ key, url, init, body: key === "provider" ? Object.fromEntries(init.body) : JSON.parse(init.body) });
    const result = typeof routes[key] === "function" ? routes[key](calls) : routes[key];
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : reply(result);
  }));
  return calls;
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://psgfictionalproject.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
  vi.stubEnv("SMS_LEDGER_HASH_SALT", SALT);
  vi.stubEnv("TWILIO_ACCOUNTS_JSON", JSON.stringify([account]));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Twilio send boundaries", () => {
  it.each([
    ["untrusted origin", { headers: { ...headers, origin: "https://attacker.test" } }, 403, "untrusted-origin"],
    ["method", { method: "GET" }, 405, "method_not_allowed"],
    ["sample origin", { headers: { ...headers, host: SAMPLE_HOST, origin: SAMPLE_ORIGIN } }, 403, "untrusted-origin"],
    ["missing bearer", { headers: { ...headers, authorization: "" } }, 400, "invalid_request"],
    ["missing body", { body: undefined }, 400, "invalid_request"],
    ["invalid member", { body: { ...body, memberId: "bad" } }, 400, "invalid_request"],
    ["invalid idempotency key", { body: { ...body, idempotencyKey: "bad" } }, 400, "invalid_request"],
    ["invalid purpose", { body: { ...body, purpose: "marketing" } }, 400, "invalid_request"],
    ["empty message", { body: { ...body, body: " " } }, 400, "invalid_request"],
    ["oversized message", { body: { ...body, body: "x".repeat(1601) } }, 400, "invalid_request"],
  ])("rejects %s before queue or provider access", async (_, extra, status, error) => {
    upstream();
    expect(await run(extra)).toMatchObject({ status, body: { error } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SMS_LEDGER_HASH_SALT"])("requires %s before queue access", async variable => {
    upstream(); vi.stubEnv(variable, "");
    const salt = variable === "SMS_LEDGER_HASH_SALT";
    expect(await run()).toMatchObject({ status: salt ? 503 : 400, body: { error: salt ? "activation_incomplete" : "invalid_request" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads the operation key from the Idempotency-Key header when the body has none", async () => {
    const { idempotencyKey: _omitted, ...rest } = body;
    const calls = upstream({ claim_twilio_sms_send: reply({}, 503) });
    expect(await run({ headers: { ...headers, "idempotency-key": JOB }, body: rest })).toMatchObject({ status: 503, body: { error: "claim_failed" } });
    expect(calls[0].body).toMatchObject({ p_idempotency_key: JOB });
  });
  it.each([401, 403, 409])("maps prepare HTTP %i to a flat refusal without claiming", async status => {
    const calls = upstream({ prepare_twilio_sms_send: reply({}, status) });
    expect(await run()).toMatchObject({ status: status === 409 ? 409 : 403, body: { ok: false, error: "send_refused" } });
    expect(calls.map(c => c.key)).toEqual(["prepare_twilio_sms_send"]);
  });
  it.each([{ accountSid: "missing" }, { accountSid: undefined }, { organizationId: MEMBER }, { fromNumber: "+15005550008" }])("refuses prepared context outside the configured registry", async mismatch => {
    const calls = upstream({ prepare_twilio_sms_send: { ...prepared, ...mismatch } });
    expect(await run()).toMatchObject({ status: 503, body: { error: "activation_incomplete" } });
    expect(calls).toHaveLength(1);
  });
  it("refuses an invalid registry before claiming", async () => {
    const calls = upstream(); vi.stubEnv("TWILIO_ACCOUNTS_JSON", "bad");
    expect(await run()).toMatchObject({ status: 503, body: { error: "activation_incomplete" } });
    expect(calls).toHaveLength(1);
  });
  it("reports claim failure without sending", async () => {
    const calls = upstream({ claim_twilio_sms_send: reply({}, 503) });
    expect(await run()).toMatchObject({ status: 503, body: { error: "claim_failed" } });
    expect(calls.map(c => c.key)).toEqual(["prepare_twilio_sms_send", "claim_twilio_sms_send"]);
  });
  it.each([45, 0])("honors queue rate limiting with retry delay %i", async retryAfterSeconds => {
    const calls = upstream({ claim_twilio_sms_send: { claimed: false, reason: "rate_limited", scope: "organization", retryAfterSeconds } });
    expect(await run()).toMatchObject({ status: 429, body: { ok: false, error: "rate_limited", scope: "organization", retryAfterSeconds: retryAfterSeconds || 3600 }, headers: { "Retry-After": String(retryAfterSeconds || 3600) } });
    expect(calls).toHaveLength(2);
  });
  it("does not resend an already claimed job", async () => {
    const calls = upstream({ claim_twilio_sms_send: { claimed: false, reason: "already_sent" } });
    expect(await run()).toMatchObject({ status: 409, body: { error: "already_processed" } });
    expect(calls).toHaveLength(2);
  });
  it.each([true, false])("records changed registry context, persistence succeeds=%s", async stored => {
    const calls = upstream({ claim_twilio_sms_send: { ...claimed, organizationId: MEMBER }, record_twilio_sms_send_result: stored });
    expect(await run()).toMatchObject({ status: 503, body: { error: stored ? "activation_incomplete" : "result_record_failed" } });
    expect(calls.some(c => c.key === "provider")).toBe(false);
    const records = calls.filter(c => c.key === "record_twilio_sms_send_result");
    expect(records).toHaveLength(stored ? 1 : 4);
    expect(records[0].body).toEqual({ p_job_id: JOB, p_success: false, p_provider_reference_digest: null, p_provider_status: null, p_error_code: "registry_context_changed" });
  });
  it("sends once using claimed recipient and records only keyed digests", async () => {
    const calls = upstream();
    expect(await run()).toMatchObject({ status: 202, body: { ok: true, deliveryId: JOB, status: "queued" } });
    expect(calls.map(c => c.key)).toEqual(["prepare_twilio_sms_send", "claim_twilio_sms_send", "provider", "record_twilio_sms_send_result"]);
    expect(calls[0].init.headers.Authorization).toBe("Bearer member-token");
    expect(calls[0].body).toEqual({ p_member_id: MEMBER, p_purpose: body.purpose, p_body_digest: createHmac("sha256", SALT).update(body.body).digest("hex"), p_idempotency_key: JOB });
    expect(calls[1].init.headers.apikey).toBe("sb_secret_test");
    expect(calls[2].body).toEqual({ To: claimed.toPhone, From: account.fromNumber, Body: body.body, StatusCallback: `${PORTAL_ORIGIN}/api/twilio-status` });
    expect(calls[3].body).toEqual({ p_job_id: JOB, p_success: true, p_provider_reference_digest: createHmac("sha256", SALT).update(`${ACCOUNT}:${SID}`).digest("hex"), p_provider_status: "queued", p_error_code: null });
  });
  it("records provider rejection without claiming delivery success", async () => {
    const calls = upstream({ provider: reply({}, 503) });
    expect(await run()).toMatchObject({ status: 502, body: { error: "provider_failed" } });
    expect(calls.at(-1).body).toMatchObject({ p_success: false, p_provider_reference_digest: null, p_provider_status: null, p_error_code: "provider_rejected" });
  });
  it("retries durable result recording without sending the message twice", async () => {
    const calls = upstream({ record_twilio_sms_send_result: false });
    expect(await run()).toMatchObject({ status: 503, body: { error: "result_record_failed" } });
    expect(calls.filter(c => c.key === "provider")).toHaveLength(1);
    expect(calls.filter(c => c.key === "record_twilio_sms_send_result")).toHaveLength(4);
  });
});
