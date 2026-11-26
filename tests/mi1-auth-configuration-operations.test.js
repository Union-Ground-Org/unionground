// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260828240000_auth_configuration_operations.sql", import.meta.url), "utf8");
const authScreen = readFileSync(new URL("../src/components/AuthScreen.jsx", import.meta.url), "utf8");
const mfaScreen = readFileSync(new URL("../src/components/MfaSettings.jsx", import.meta.url), "utf8");
const adminScreen = readFileSync(new URL("../src/components/AdminSecurityConfiguration.jsx", import.meta.url), "utf8");
const supabaseClient = readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8");
const passwordRoute = readFileSync(new URL("../api/auth-password-signin.js", import.meta.url), "utf8");
const recoveryRoute = readFileSync(new URL("../api/mfa-recovery.js", import.meta.url), "utf8");

describe("CR-100 passkeys", () => {
  // Union Ground leaves passkey, security-key and store-account sign-in
  // out (owner decision). The web client never opts into Supabase WebAuthn and
  // no screen offers passkey sign-in, enrollment, or management.
  it("keeps the web client and screens free of passkey sign-in and enrollment", () => {
    expect(supabaseClient).not.toMatch(/passkey\s*:\s*true/);
    expect(supabaseClient).not.toMatch(/experimental\s*:\s*\{[^}]*passkey/);
    expect(authScreen).not.toContain("signInWithPasskey");
    expect(authScreen).not.toContain("signInWithSSO");
    for (const call of ["registerPasskey", "auth.passkey.list", "auth.passkey.update", "auth.passkey.delete"]) {
      expect(mfaScreen, call).not.toContain(call);
      expect(adminScreen, call).not.toContain(call);
    }
  });

  it("keeps GoTrue as credential owner and gates new enrollment by organization setting", () => {
    expect(migration).not.toMatch(/create table public\.(passkeys|webauthn_credentials)/i);
    expect(migration).toContain("'features.passkey_enrollment'");
    expect(migration).toContain("'passkeyEnrollmentEnabled'");
  });
});

describe("CR-101 recovery codes", () => {
  it("generates one-time plaintext, stores bcrypt only, rotates, and rate-limits claims", () => {
    expect(migration).toContain("extensions.gen_random_bytes(8)");
    expect(migration).toContain("extensions.crypt('UG' || compact, extensions.gen_salt('bf', 12))");
    expect(migration).toContain("delete from public.mfa_recovery_codes where user_id = caller");
    expect(migration).toContain("failed_attempts >= 4");
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("jsonb_build_object('accepted', false)");
    expect(migration).not.toContain("raise exception 'recovery code not accepted' using errcode = '22023';\n  end if;\n  claim_token");
    expect(migration).toContain("claim_expires_at = pg_catalog.now() + interval '2 minutes'");
    expect(migration).toContain("used_at = pg_catalog.now()");
    expect(migration).toContain("'features.mfa_recovery_code_enrollment'");
    expect(migration).toContain("'recoveryCodeEnrollmentEnabled'");
    expect(migration).toContain("raise exception 'recovery code enrollment disabled'");
    expect(mfaScreen).toContain("!recoveryCodeEnrollmentEnabled");
    expect(migration).not.toMatch(/grant (select|insert|update|delete|all)[^;]*mfa_recovery/i);
  });

  it("consumption removes supported factors, finalizes once, revokes sessions, and requires a new sign-in", () => {
    expect(recoveryRoute).toContain("claim_mfa_recovery_code");
    expect(recoveryRoute).toContain("entry.factor_type === \"totp\"");
    expect(recoveryRoute).toContain("finalize_mfa_recovery_code");
    expect(recoveryRoute).toContain("/logout");
    expect(recoveryRoute).toContain("signInAgain: true");
    expect(mfaScreen).toContain("/api/mfa-recovery");
    expect(mfaScreen).toContain("scope: \"local\"");
  });
});

describe("CR-102 and CR-103 organization configuration", () => {
  it("seeds definitions but no tenant values and validates every typed write", () => {
    expect(migration).toContain("create table public.platform_setting_definitions");
    expect(migration).toContain("create table public.organization_setting_values");
    expect(migration).not.toMatch(/insert into public\.organizations\b/i);
    expect(migration).toContain("private.setting_value_valid");
    expect(migration).toContain("private.has_organization_role(org_id, array['admin'])");
    expect(migration).toContain("organization_configuration_audit");
    expect(adminScreen).toContain("configuration.settings");
    expect(adminScreen).toContain("api.updateOrganizationSetting");
  });

  it("allowlists labels, resolves them for members, and never changes routes or permissions", () => {
    expect(migration).toContain("create table public.organization_label_overrides");
    expect(migration).toContain("label_value !~ '[<>[:cntrl:]]'");
    expect(migration).toContain("'labelOverrides'");
    expect(adminScreen).toContain("configuration.labelKeys");
    expect(adminScreen).toContain("api.updateOrganizationLabel");
  });
});

describe("CR-105 failed sign-in operations", () => {
  it("captures only organization-attributed known accounts without raw email or IP storage", () => {
    expect(passwordRoute).toContain("/auth/v1/token?grant_type=password");
    expect(passwordRoute).toContain("record_failed_login_attempt");
    expect(passwordRoute).toContain("sign-in-failed");
    expect(migration).toContain("if subject is null then return null");
    expect(migration).toContain("if org_id is null then return null");
    expect(migration).toContain("identity_hash text not null");
    const table = migration.slice(migration.indexOf("create table public.organization_failed_login_attempts"), migration.indexOf("create index organization_failed_login_attempts_inbox_idx"));
    expect(table).not.toMatch(/\bemail\b|ip_address/i);
  });

  it("provides MFA-aware tenant filters and audited disposition instead of a global inbox", () => {
    expect(migration).toContain("list_failed_login_operations_inbox");
    expect(migration).toContain("disposition_failed_login_attempt");
    expect(migration).toContain("a.organization_id = org_id");
    expect(migration).toContain("where id = p_attempt_id and organization_id = org_id and status = 'open'");
    expect(adminScreen).toContain("api.loadFailedLoginInbox");
    expect(adminScreen).toContain("api.dispositionFailedLoginAttempt");
  });
});
