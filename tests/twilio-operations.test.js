// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bodyDigest,
  classifyTwilioConsent,
  parseTwilioAccountRegistry,
  parseTwilioParams,
  persistTwilioResult,
  phoneDigest,
  providerReferenceDigest,
  resolveTwilioSignatureUrl,
  sendTwilioMessage,
  twilioRegistryForSurface,
  validateTwilioSignature,
} from "../api/_lib/twilioOperations.js";
import { fnBody } from "./helpers/migration.js";

const ACCOUNT = "AC11111111111111111111111111111111";
const MESSAGE = "SM22222222222222222222222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const SALT = "s".repeat(32);
const REGISTRY = JSON.stringify([{
  accountSid: ACCOUNT,
  authToken: "token-token-token-token",
  organizationId: ORG,
  fromNumber: "+15085550100",
  webhookBaseUrl: "https://app.example.org",
}]);

describe("CR-089 Twilio operations", () => {
  it("parses bounded surface-specific account custody and rejects unsafe records", () => {
    expect(parseTwilioAccountRegistry(REGISTRY).accounts.get(ACCOUNT)).toMatchObject({ organizationId: ORG });
    expect(parseTwilioAccountRegistry("[]").ok).toBe(true);
    expect(parseTwilioAccountRegistry("not-json")).toEqual({ ok: false, reason: "registry_invalid" });
    expect(parseTwilioAccountRegistry(JSON.stringify([{ ...JSON.parse(REGISTRY)[0], webhookBaseUrl: "http://127.0.0.1" }])).ok).toBe(false);
    expect(parseTwilioAccountRegistry(JSON.stringify([{ ...JSON.parse(REGISTRY)[0], webhookBaseUrl: "https://user:pass@app.example.org" }])).ok).toBe(false);
    expect(parseTwilioAccountRegistry(JSON.stringify([{ ...JSON.parse(REGISTRY)[0], webhookBaseUrl: "https://app.example.org/callback" }])).ok).toBe(false);
    expect(parseTwilioAccountRegistry(JSON.stringify([{ ...JSON.parse(REGISTRY)[0], webhookBaseUrl: "https://app.example.org:bad" }])).ok).toBe(false);
    const alternate = parseTwilioAccountRegistry(JSON.stringify([{ ...JSON.parse(REGISTRY)[0], fromNumbers: ["+15085550100", "+15085550101"] }]));
    expect(alternate.accounts.get(ACCOUNT).allowedFromNumbers.has("+15085550101")).toBe(true);
    expect(twilioRegistryForSurface({ TWILIO_ACCOUNTS_JSON: REGISTRY }, "saas").ok).toBe(true);
    expect(twilioRegistryForSurface({ TWILIO_ACCOUNTS_JSON: REGISTRY }, "demo").ok).toBe(false);
  });

  it("validates the exact Twilio URL and sorted form parameters", () => {
    const params = parseTwilioParams("Body=STOP&From=%2B15085550123&AccountSid=" + ACCOUNT + "&MessageSid=" + MESSAGE);
    const request = { url: "/api/twilio-inbound?mode=live", headers: { host: "internal.invalid", "x-forwarded-proto": "https" } };
    const url = resolveTwilioSignatureUrl(request, "https://app.example.org");
    expect(url).toBe("https://app.example.org/api/twilio-inbound?mode=live");
    let signed = url;
    for (const key of Object.keys(params).sort()) signed += `${key}${params[key]}`;
    const signature = createHmac("sha1", "token-token-token-token").update(signed).digest("base64");
    expect(validateTwilioSignature({ authToken: "token-token-token-token", signature, url, params })).toBe(true);
    expect(validateTwilioSignature({ authToken: "token-token-token-token", signature: `${signature}x`, url, params })).toBe(false);
    expect(parseTwilioParams({ Body: ["STOP"] })).toBeNull();
  });

  it("classifies consent keywords and retains only irreversible digests", () => {
    expect(classifyTwilioConsent(" stop! ")).toEqual({ eventType: "opt_out", keyword: "STOP" });
    expect(classifyTwilioConsent("anything", "START")).toEqual({ eventType: "opt_in", keyword: "START" });
    expect(classifyTwilioConsent("help")).toEqual({ eventType: "help", keyword: "HELP" });
    expect(classifyTwilioConsent("private message")).toEqual({ eventType: "unknown", keyword: null });
    expect(phoneDigest("+15085550123", SALT)).toMatch(/^[a-f0-9]{64}$/);
    expect(phoneDigest("+15085550123", SALT)).not.toContain("0123");
    expect(providerReferenceDigest(ACCOUNT, MESSAGE, SALT)).toMatch(/^[a-f0-9]{64}$/);
    expect(bodyDigest("A common policy notice", SALT)).toBe(
      createHmac("sha256", SALT).update("A common policy notice").digest("hex"),
    );
    expect(bodyDigest("A common policy notice", "t".repeat(32))).not.toBe(bodyDigest("A common policy notice", SALT));
    expect(bodyDigest("A common policy notice", "short")).toBeNull();
  });

  it("builds one bounded provider request and reduces failures to stable codes", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(String(init.body)).toContain("To=%2B15085550123");
      expect(String(init.body)).toContain("StatusCallback=https%3A%2F%2Fapp.example.org%2Fapi%2Ftwilio-status");
      return { ok: true, json: async () => ({ sid: MESSAGE, status: "queued" }) };
    });
    await expect(sendTwilioMessage({
      account: parseTwilioAccountRegistry(REGISTRY).accounts.get(ACCOUNT),
      to: "+15085550123",
      body: "A bounded notice",
      statusCallbackUrl: "https://app.example.org/api/twilio-status",
      fetchImpl,
    })).resolves.toEqual({ ok: true, messageSid: MESSAGE, status: "queued" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(sendTwilioMessage({ account: null, to: "+15085550123", body: "notice", fetchImpl })).resolves.toEqual({ ok: false, reason: "invalid_send" });
  });

  it("never marks an ambiguous Twilio 2xx response as safe to retry", async () => {
    const account = parseTwilioAccountRegistry(REGISTRY).accounts.get(ACCOUNT);
    await expect(sendTwilioMessage({
      account,
      to: "+15085550123",
      body: "A bounded notice",
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("truncated"); } }),
    })).resolves.toEqual({ ok: false, reason: "provider_response_uncertain" });
    await expect(sendTwilioMessage({
      account,
      to: "+15085550123",
      body: "A bounded notice",
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "queued" }) }),
    })).resolves.toEqual({ ok: false, reason: "provider_response_uncertain" });
    await expect(sendTwilioMessage({
      account,
      to: "+15085550123",
      body: "A bounded notice",
      fetchImpl: async () => ({ ok: false, json: async () => ({ sid: MESSAGE }) }),
    })).resolves.toEqual({ ok: false, reason: "provider_rejected" });
  });

  it("reserves every provider attempt under recipient and organization caps at claim time", () => {
    const migration = readFileSync("supabase/migrations/20260830234000_mi1_twilio_operations.sql", "utf8");
    const prepare = fnBody(migration, "public.prepare_twilio_sms_send").toLowerCase();
    const claim = fnBody(migration, "public.claim_twilio_sms_send").toLowerCase();
    const normalized = claim.replace(/\s+/g, " ");
    const organizationLock = claim.indexOf("'twilio_sms_rate_org:'");
    const recipientLock = claim.indexOf("'twilio_sms_rate_member:'");
    const lockedJobLookup = claim.indexOf("for update;");
    const recipientCount = claim.indexOf("into recent_recipient_hour");
    const organizationCount = claim.indexOf("into recent_organization_day");
    const reservation = claim.indexOf("insert into private.twilio_sms_attempts");
    const running = claim.indexOf("set status = 'running'");

    expect(prepare).not.toContain("recent_recipient_hour");
    expect(migration.toLowerCase()).toContain("create table private.twilio_sms_attempts");
    expect(organizationLock).toBeGreaterThan(-1);
    expect(recipientLock).toBeGreaterThan(organizationLock);
    expect(lockedJobLookup).toBeGreaterThan(recipientLock);
    expect(recipientCount).toBeGreaterThan(lockedJobLookup);
    expect(organizationCount).toBeGreaterThan(recipientCount);
    expect(reservation).toBeGreaterThan(organizationCount);
    expect(running).toBeGreaterThan(reservation);
    expect(normalized).toContain("max_per_recipient_hour constant integer := 12");
    expect(normalized).toContain("max_per_organization_day constant integer := 20000");
    expect(normalized).toContain("'reason', 'rate_limited'");
    expect(normalized).toContain("'scope', 'recipient_hour'");
    expect(normalized).toContain("'scope', 'organization_day'");
  });

  it("retries result persistence and accepts an idempotent confirmation", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn(async () => {});
    await expect(persistTwilioResult(write, { wait })).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("pins tenancy, consent, no-SAMPLE-egress, and service-only callback contracts", () => {
    const migration = readFileSync("supabase/migrations/20260830234000_mi1_twilio_operations.sql", "utf8");
    const inboundConsent = fnBody(migration, "public.record_twilio_inbound_consent").toLowerCase();
    const send = readFileSync("api/twilio-send.js", "utf8");
    const inbound = readFileSync("api/twilio-inbound.js", "utf8");
    const seed = readFileSync("supabase/migrations/20260830235000_demo_seed_twilio_operations.sql", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const rateProof = readFileSync("scripts/verify-twilio-sms-rate-limits-local.mjs", "utf8");
    expect(migration).toContain("private.mi1_require_integration_admin()");
    expect(migration).toContain("pref.consented and pref.revoked_at is null");
    expect(inboundConsent).toContain("authenticated_reconsent_required");
    expect(inboundConsent).toContain("set_my_sms_consent");
    expect(inboundConsent).not.toContain("set consented = true");
    expect(migration).toContain("organization_membership.status = 'active'");
    expect(migration).toContain("chapter_membership.status = 'active'");
    expect(migration).toContain("primary key (organization_id, user_id)");
    expect(migration).toContain("public.search_twilio_sms_recipients");
    expect(migration).toContain("existing.error_code in ('provider_rejected', 'invalid_send', 'registry_context_changed')");
    expect(migration).toContain("integration.status <> 'connected'");
    expect(migration).toContain("service role required");
    expect(migration).toContain("idempotency payload mismatch");
    expect(migration).toContain("p_purpose is null");
    expect(migration).toContain("p_body_digest is null");
    expect(migration).toContain("twilio disabled for chapter");
    expect(migration).not.toContain("candidate_count <> 1");
    expect(migration).toContain("private.mi1_twilio_status_rank");
    expect(migration).toContain("public.list_integration_job_page");
    expect(migration).toContain("offset page_limit - 1 limit 1");
    expect(migration.indexOf("'sms-consent:' || p_provider_reference_digest")).toBeLessThan(migration.indexOf("if p_event_type = 'opt_out'"));
    expect(send).not.toContain("prepared.toPhone");
    expect(send).toContain("claimed.toPhone");
    expect(inbound).toContain("account.allowedFromNumbers.has(to)");
    expect(send).toContain("sample_egress_suppressed");
    expect(send).toContain("registry_context_changed");
    expect(send).toContain("persistTwilioResult");
    expect(send).toContain('claimed?.reason === "rate_limited"');
    expect(send).toContain("json(response, 429");
    expect(send.indexOf("ledgerSalt.length < 32")).toBeLessThan(send.indexOf("const sent = await sendTwilioMessage"));
    expect(send).not.toMatch(/console\.(?:log|error).*body/i);
    expect(inbound).not.toMatch(/console\.(?:log|error).*params/i);
    expect(seed).toContain("where function_id = 'CR-089'");
    expect(seed).toContain("'twilio-operation-history'");
    expect(seed).toContain("for ordinal in 1..200 loop");
    expect(seed).toContain("referencing new table as inserted_twilio_evidence");
    expect(seed).toContain("private.demo_seed_twilio_operation_history(seeded_run.lane, seeded_run.run_id)");
    expect(seed).toContain("private.demo_seed_installation_bindings");
    expect(seed).not.toContain("sample-provider-disabled");
    expect(seed).not.toContain("delete from public.integration_jobs");
    expect(seed).not.toMatch(/phone_e164|message_body|body_text|auth\.users|insert into public\.organizations/i);
    expect(packageJson.scripts["verify:twilio-rate-limits:local"]).toBe(
      "node scripts/verify-twilio-sms-rate-limits-local.mjs",
    );
    for (const marker of [
      "assertDisposableProofUrl(",
      "waitForBothClaimsToBlock",
      "recipient N+1 race",
      "organization N+1 race",
      "aged queued job bypassed",
      "append-only attempt ledger",
      "delayed START callback undid a newer STOP",
      "authenticated member action did not restore organization-scoped consent",
    ]) expect(rateProof).toContain(marker);
  });
});
