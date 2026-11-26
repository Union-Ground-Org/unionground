// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("public_site_content_and_interest");
const code = stripComments(sql);
const initialGuardSql = loadMigrationSql("20260813202500_public_interest_submission_guard");
const initialGuardCode = stripComments(initialGuardSql);
const guardSql = loadMigrationSql("public_interest_submission_guard_followup");
const guardCode = stripComments(guardSql);
const contractDropSql = loadMigrationSql("public_interest_compat_contract_drop");
const contractDropCode = stripComments(contractDropSql);
const suppressionSql = loadMigrationSql("public_interest_suppression");
const suppressionCode = stripComments(suppressionSql);

describe("public site content and interest migration", () => {
  it("uses an explicit publishable projection instead of exposing member data", () => {
    expect(code).toContain("create table public.public_site_records");
    expect(code).toContain("create table public.public_interest_submissions");
    expect(code).not.toMatch(/grant\s+select[^;]+member_(events|profiles|cases)[^;]+anon/i);
    expect(fnBody(code, "get_public_site_content")).toContain("where r.is_published");
    expect(fnBody(code, "get_public_site_content")).toContain("coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()");
  });

  it("locks both tables behind RLS, MFA, and staff-only direct access", () => {
    for (const table of ["public_site_records", "public_interest_submissions"]) {
      expect(code).toContain(`alter table public.${table} enable row level security`);
      expect(code).toContain(`create policy mfa_assurance on public.${table}`);
      expect(code).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    }
    expect(code).not.toMatch(/grant\s+(insert|update|delete)[^;]+public_interest_submissions[^;]+to\s+anon/i);
    expect(code).toContain("public.member_has_role(array['coordinator', 'admin', 'vp'])");
  });

  it("publishes only narrow definer RPCs to anonymous visitors", () => {
    const body = fnBody(code, "get_public_site_content");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(code).toContain("grant execute on function public.get_public_site_content(text) to anon, authenticated, service_role");
  });

  it("replaces the anonymous write with a service-only, durably rate-limited boundary", () => {
    const limiter = fnBody(initialGuardCode, "private.consume_public_interest_submission_limit");
    const legacySubmit = fnBody(initialGuardCode, "submit_public_interest");
    const submit = fnBody(guardCode, "submit_public_interest");
    expect(initialGuardCode).toContain("create or replace function public.submit_public_interest(");
    expect(initialGuardCode).not.toContain("drop function if exists public.submit_public_interest(text, text, text, text, text, text)");
    expect(initialGuardCode).toContain("create table private.public_interest_submission_limits");
    expect(initialGuardCode).toMatch(/revoke all on private\.public_interest_submission_limits\s+from public, anon, authenticated, service_role/);
    expect(guardCode).toContain("drop function if exists public.submit_public_interest(text, text, text, text, text, text, text)");
    expect(limiter).toContain("pg_advisory_xact_lock");
    expect(limiter).toContain("for update");
    expect(limiter).toContain("current_row.request_count >= p_limit");
    expect(legacySubmit).toContain("'network-15m', 60, interval '15 minutes'");
    expect(legacySubmit).toContain("'email-interest-day', 3, interval '1 day'");
    expect(legacySubmit).toContain("legacy_scope_hash, 'network-15m', 60, interval '15 minutes'");
    expect(legacySubmit).toContain("email_scope_hash, 'email-interest-day', 3, interval '1 day'");
    expect(legacySubmit).toContain("p_interest is null or p_interest not in");
    expect(legacySubmit).toContain("p_locale is null or p_locale not in");
    expect(legacySubmit).toContain("p_source is distinct from 'public-landing'");
    expect(legacySubmit.indexOf("if pg_catalog.btrim(coalesce(p_website, '')) <> '' then"))
      .toBeLessThan(legacySubmit.indexOf("legacy_scope_hash, 'network-15m', 60, interval '15 minutes'"));
    const legacyNetworkLimiter = legacySubmit.indexOf("legacy_scope_hash, 'network-15m', 60, interval '15 minutes'");
    const legacyCleanup = legacySubmit.indexOf("delete from private.public_interest_submission_limits");
    expect(legacyCleanup).toBeGreaterThan(legacyNetworkLimiter);
    const legacyBeforeCleanup = legacySubmit.slice(legacyNetworkLimiter, legacyCleanup);
    expect(legacyBeforeCleanup).not.toContain("return pg_catalog.jsonb_build_object('accepted', true)");
    expect(legacyBeforeCleanup).toMatch(/ {4}end if;\s+ {2}end if;\s*$/);
    expect(legacySubmit).toContain("window_started_at < moment - interval '2 days'");
    expect(legacySubmit).toContain("order by candidate.window_started_at");
    expect(legacySubmit).toMatch(/select candidate\.ctid[\s\S]*limit 200\s+for update skip locked/);
    expect(legacySubmit).toContain("on conflict (email, interest) do nothing");
    expect(legacySubmit).not.toContain("status = 'new'");
    expect(initialGuardCode).toMatch(/grant execute on function public\.submit_public_interest\(text, text, text, text, text, text\)\s+to anon, authenticated, service_role/);
    expect(guardCode).toContain("create index public_interest_submission_limits_window_idx");
    expect(submit).toContain("delete from private.public_interest_submission_limits");
    expect(submit.indexOf("if pg_catalog.btrim(coalesce(p_website, '')) <> '' then"))
      .toBeLessThan(submit.indexOf("p_scope_hash, 'network-15m', 20, interval '15 minutes'"));
    expect(submit.indexOf("if pg_catalog.btrim(coalesce(p_website, '')) <> '' then"))
      .toBeLessThan(submit.indexOf("delete from private.public_interest_submission_limits"));
    expect(submit.indexOf("'network-15m', 20, interval '15 minutes'"))
      .toBeLessThan(submit.indexOf("delete from private.public_interest_submission_limits"));
    const serviceBeforeCleanup = submit.slice(
      submit.indexOf("p_scope_hash, 'network-15m', 20, interval '15 minutes'"),
      submit.indexOf("delete from private.public_interest_submission_limits"),
    );
    expect(serviceBeforeCleanup).not.toContain("return pg_catalog.jsonb_build_object('accepted', true)");
    expect(serviceBeforeCleanup).toMatch(/ {4}end if;\s+ {2}end if;\s*$/);
    expect(submit).toContain("window_started_at < moment - interval '2 days'");
    expect(submit).toContain("order by candidate.window_started_at");
    expect(submit).toContain("limit 200");
    expect(submit).toMatch(/select candidate\.ctid[\s\S]*limit 200\s+for update skip locked/);
    expect(submit).toContain("candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)");
    expect(submit.indexOf("on conflict (email, interest) do nothing"))
      .toBeLessThan(submit.indexOf("delete from private.public_interest_submission_limits"));
    expect(submit).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
    expect(submit).toContain("p_email_scope_hash !~ '^[0-9a-f]{64}$'");
    expect(submit).toContain("p_interest is null or p_interest not in");
    expect(submit).toContain("p_locale is null or p_locale not in");
    expect(submit).toContain("p_source is distinct from 'public-landing'");
    expect(submit).toContain("'network-15m', 20, interval '15 minutes'");
    expect(submit).toContain("'email-interest-day', 3, interval '1 day'");
    expect(submit).toContain("p_scope_hash, 'network-15m', 20, interval '15 minutes'");
    expect(submit).toContain("p_email_scope_hash, 'email-interest-day', 3, interval '1 day'");
    expect(submit).not.toContain("extensions.digest");
    expect(guardCode).toMatch(/grant execute on function public\.submit_public_interest\(text, text, text, text, text, text, text, text\)\s+to service_role/);
    expect(guardCode).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.submit_public_interest\(text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*text\)\s+to\s+[^;]*(?:anon|authenticated)/i);
  });

  it("contracts only the six-argument compatibility overload", () => {
    const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
    const sixArgument = "public.submit_public_interest(p_email text, p_name text, p_interest text, p_locale text, p_source text, p_website text)";
    const absentSixArgument = "public.submit_public_interest(text, text, text, text, text, text)";
    const absent = contract.functionsAbsent.find((entry) => entry.sig === absentSixArgument);

    expect(contractDropCode).toMatch(/revoke all on function public\.submit_public_interest\(text, text, text, text, text, text\)\s+from public, anon, authenticated, service_role/);
    expect(contractDropCode).toContain("drop function if exists public.submit_public_interest(text, text, text, text, text, text)");
    expect(contractDropCode).not.toContain("submit_public_interest(text, text, text, text, text, text, text, text)");
    expect(contractDropCode).not.toContain("private.consume_public_interest_submission_limit");
    expect(contract.functions.some((entry) => entry.sig === sixArgument)).toBe(false);
    expect(absent?.droppedBy).toBe("20260817000245_public_interest_compat_contract_drop");
  });

  it("validates and accepts contact intent without exposing or mutating duplicate state", () => {
    const submit = fnBody(guardCode, "submit_public_interest");
    expect(submit).toContain("char_length(normalized_email) > 254");
    expect(submit).toContain("normalized_email !~");
    expect(submit).toContain("p_interest not in ('chapter_updates', 'public_meetings', 'union_news')");
    expect(submit).toContain("if pg_catalog.btrim(coalesce(p_website, '')) <> '' then");
    expect(submit).toContain("on conflict (email, interest) do nothing");
    expect(submit).not.toContain("status = 'new'");
    expect(submit).not.toContain("last_submitted_at = now()");
    expect(submit).not.toContain("raise exception 'a valid email address is required'");
    expect(submit.match(/jsonb_build_object\('accepted', true\)/g)).toHaveLength(2);
  });

  it("adds a Vault-keyed service-only stop ledger behind the deployed submit signature", () => {
    const submit = fnBody(suppressionCode, "submit_public_interest");
    const stop = fnBody(suppressionCode, "stop_public_interest");
    const suppressionScope = fnBody(suppressionCode, "private.public_interest_suppression_scope");
    const suppressionTable = suppressionCode.slice(
      suppressionCode.indexOf("create table private.public_interest_suppressions"),
      suppressionCode.indexOf("alter table private.public_interest_suppressions enable row level security"),
    );

    expect(suppressionTable).toContain("suppression_scope_hash text primary key");
    expect(suppressionTable).not.toMatch(/^\s*email\s+text/im);
    expect(suppressionCode).toContain("alter table private.public_interest_suppressions enable row level security");
    expect(suppressionCode).toMatch(/revoke all on private\.public_interest_suppressions\s+from public, anon, authenticated, service_role/);
    expect(suppressionCode).not.toMatch(/grant\s+[^;]+on\s+private\.public_interest_suppressions/i);
    expect(suppressionCode).toContain("vault.create_secret(");
    expect(suppressionCode).toContain("extensions.gen_random_bytes(32)");
    expect(suppressionScope).toContain("security definer");
    expect(suppressionScope).toContain("set search_path = ''");
    expect(suppressionScope).toContain("vault.decrypted_secrets");
    expect(suppressionScope).toContain("extensions.hmac(");
    expect(suppressionScope).toContain("pg_catalog.convert_to(suppression_secret, 'UTF8')");
    expect(suppressionScope).not.toContain("p_suppression_scope_hash");
    expect(suppressionCode).toMatch(/revoke all on function private\.public_interest_suppression_scope\(text\)\s+from public, anon, authenticated, service_role/);

    for (const body of [submit, stop]) {
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
      expect(body).toContain("private.public_interest_suppression_scope(normalized_email)");
      expect(body).toContain("'public-interest-suppression:' || derived_suppression_scope_hash");
      expect(body).not.toContain("p_suppression_scope_hash");
    }
    expect(submit).toContain("where suppression.suppression_scope_hash = derived_suppression_scope_hash");
    expect(stop).toContain("insert into private.public_interest_suppressions");
    expect(stop).toContain("delete from public.public_interest_submissions");
    expect(stop.indexOf("pg_advisory_xact_lock"))
      .toBeLessThan(stop.indexOf("insert into private.public_interest_suppressions"));
    expect(stop.indexOf("insert into private.public_interest_suppressions"))
      .toBeLessThan(stop.indexOf("delete from public.public_interest_submissions"));

    expect(suppressionCode).toMatch(/grant execute on function public\.submit_public_interest\(text, text, text, text, text, text, text, text\)\s+to service_role/);
    expect(suppressionCode).toMatch(/grant execute on function public\.stop_public_interest\(text, text, text, text, text, text\)\s+to service_role/);
    expect(suppressionCode).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.(?:submit|stop)_public_interest\([^;]+\)\s+to\s+[^;]*(?:anon|authenticated)/i);
    expect(suppressionCode).not.toContain("drop function if exists public.submit_public_interest(text, text, text, text, text, text, text, text)");
    expect(suppressionCode).toContain("drop function if exists public.submit_public_interest(text, text, text, text, text, text, text, text, text)");
    expect(suppressionCode).toContain("drop function if exists public.stop_public_interest(text, text, text, text, text, text, text)");
    expect(suppressionCode).not.toContain("p_suppression_scope_hash");
    expect(suppressionCode).toContain("notify pgrst, 'reload schema'");
  });
});
