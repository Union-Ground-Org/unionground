// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHART_VALIDATOR_MIGRATION, legalAcceptanceMigrationPlan } from "../scripts/lib/legal-release.mjs";
import { LEGAL_INSTRUMENTS, compareLegalVersions, currentLegalVersions, latestMaterialLegalVersion } from "../src/lib/legalInstruments.js";
import { legalAcceptanceRequirement } from "../src/lib/legalAcceptance.js";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261010213000_versioned_legal_acceptance.sql", import.meta.url), "utf8");
// REQ-UG-ADULTS-ONLY-18-PLUS-20261012: both writers now take the
// "I'm 18 or older" attestation, and terms of use 0.2.0 is the published pack.
const adultsOnly = readFileSync(new URL("../supabase/migrations/20261012233000_adults_only_attestation.sql", import.meta.url), "utf8");
// REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: both writers take the
// stated residence and the age attestation it selects, and terms of use 0.3.0
// is the published pack.
const appStoreStates = readFileSync(new URL("../supabase/migrations/20261016170000_app_store_states_age_rule.sql", import.meta.url), "utf8");
// UB-PUB-04: the operative 1.0.0 pin and the version-aware readiness probe.
const operativePack = readFileSync(new URL("../supabase/migrations/20261016230000_legal_pack_operative_1_0_0.sql", import.meta.url), "utf8");
const privacyRevision = readFileSync(new URL("../supabase/migrations/20261018060310_privacy_1_0_1_acceptance_pin.sql", import.meta.url), "utf8");
const termsRevision = readFileSync(new URL("../supabase/migrations/20261023174600_terms_1_0_1_free_pilot_acceptance_pin.sql", import.meta.url), "utf8");
const pkcePrivacyRevision = readFileSync(new URL("../supabase/migrations/20261027055000_privacy_1_0_2_pkce_storage_disclosure.sql", import.meta.url), "utf8");
// REQ-UG-COMPASS-TRAINING-DATA-RETENTION-20261017: only its predecessor guard;
// the full migration needs the account schema the real-stack proof provides.
const trainingMigration = readFileSync(new URL("../supabase/migrations/20261027060200_compass_training_retention.sql", import.meta.url), "utf8");
const trainingGuard = trainingMigration.slice(trainingMigration.indexOf("do $previous_pack$"), trainingMigration.indexOf("$previous_pack$;") + "$previous_pack$;".length);
const trainingValidatorStart = trainingMigration.indexOf("create or replace function private.legal_acceptance_versions(");
const trainingValidator = trainingMigration.slice(trainingValidatorStart, trainingMigration.indexOf("$function$;", trainingValidatorStart) + "$function$;".length);
// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027 (#6247): material privacy 1.2.0.
const analyticsRevision = readFileSync(new URL("../supabase/migrations/20261028214849_privacy_1_2_0_member_product_analytics.sql", import.meta.url), "utf8");
const heatmapsRevision = readFileSync(new URL("../supabase/migrations/20261029230836_privacy_1_2_1_public_page_heatmaps.sql", import.meta.url), "utf8");
const published = currentLegalVersions();

function latestValidator(directory) {
  const definition = readMigrationFunctions(directory).find((entry) =>
    entry.name === "private.legal_acceptance_versions" && entry.arity === 1);
  if (!definition) throw new Error("No active legal version validator");
  const tail = readFileSync(join(directory, definition.file), "utf8").slice(definition.offset);
  const opening = /\bas\s+(\$[\w]*\$)/i.exec(tail);
  const bodyStart = opening.index + opening[0].length;
  const bodyEnd = tail.indexOf(opening[1], bodyStart) + opening[1].length;
  // Replay the actual latest definition, including its language and settings.
  // OR REPLACE also allows the initial definition to be replayed unchanged.
  return tail.slice(0, bodyEnd).replace(/^(\s*create)\s+function/i, "$1 or replace function") + ";";
}

const validator = latestValidator(fileURLToPath(new URL("../supabase/migrations", import.meta.url)));

it("pins the database write authority to the exact published client pack", () => {
  const pin = validator.match(/if p_versions <> '([^']+)'::jsonb/);
  expect(pin).not.toBeNull();
  expect(JSON.parse(pin[1])).toEqual(published);
});

// Execute the actual migration, writers and read query on a disposable local
// PostgreSQL. Minimal surrounding tables/functions stand in for unrelated
// account lifecycle machinery; the full-schema race proof covers that boundary.
// The catalogue as it stood when a replay stage's pack was in force: each
// instrument's history up to that pack's version. A later generated release
// cannot change what a historical stage asked of the person.
function instrumentsAt(pack) {
  return LEGAL_INSTRUMENTS.map((entry) => ({
    ...entry, changelog: entry.changelog.filter((change) => compareLegalVersions(change.version, pack[entry.key]) <= 0),
  }));
}

describe.skipIf(!postgresBin)("legal version integrity in PostgreSQL", () => {
  let db;
  const user = "00000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    // This suite checks transaction/version rules; avoid disposable fsync I/O.
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema private; create schema auth;
      create role anon; create role authenticated; create role service_role;
      grant usage on schema public, auth to authenticated;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('test.user', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select jsonb_build_object('role', current_setting('test.role', true)) $$;
      create function private.mfa_satisfied() returns boolean language sql as $$ select true $$;
      create function private.lock_case_graph(uuid[], uuid[]) returns void language sql as $$ select $$;
      create table public.member_profiles(id uuid primary key, chapter_id text);
      create table auth.users(id uuid, email text, deleted_at timestamptz, banned_until timestamptz);
      create table public.member_invitations(id uuid, status text, auth_user_id uuid, normalized_email text, chapter_id text);
      create table private.account_lifecycle_trigger_review(kind text, schema_name text, table_name text, object_name text, definition_hash text);
      create function private.account_lifecycle_trigger_surface()
        returns setof private.account_lifecycle_trigger_review language sql as
        $$ select * from private.account_lifecycle_trigger_review $$;
    `);
    await db.client.query(migration);
    await db.client.query(adultsOnly);
    await db.client.query(appStoreStates);
    await db.client.query(operativePack);
    await db.client.query(validator);
    await db.client.query("insert into public.member_profiles values ($1, 'chapter-a')", [user]);
    await db.client.query("select set_config('test.user', $1, false)", [user]);
  // The helper permits 90 seconds for container bootstrap on a loaded runner.
  }, runnerTimeout(120_000));
  afterAll(async () => { await db?.close(); }, runnerTimeout(30_000));

  async function signedIn(query, params) {
    await db.client.query("set role authenticated");
    try { return await db.client.query(query, params); }
    finally { await db.client.query("reset role"); }
  }

  it("refuses fabricated future, stale, missing and extra versions through the actual authenticated RPC", async () => {
    for (const invalid of [
      Object.fromEntries(Object.keys(published).map((key) => [key, "99999.0.0"])),
      { ...published, "terms-of-use": "0.0.1" },
      { "terms-of-use": published["terms-of-use"] },
      { ...published, invented: "0.1.0" },
    ]) {
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(invalid)]))
        .rejects.toMatchObject({ code: "22023" });
    }
    expect((await db.client.query("select count(*)::int n from private.legal_acceptances")).rows[0].n).toBe(0);
  });

  it("records the published pack once without altering its acceptance timestamp on retries", async () => {
    const params = [JSON.stringify(published)];
    expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", params)).rows[0].r.recorded).toBe(true);
    const original = (await db.client.query("select accepted_at from private.legal_acceptances")).rows[0].accepted_at;
    await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", params);
    const rows = (await db.client.query("select accepted_at from private.legal_acceptances")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].accepted_at).toEqual(original);
  });

  async function invitationAcceptance(invitationId, state = "TX") {
    await db.client.query("select set_config('test.role', 'service_role', false)");
    await db.client.query("set role service_role");
    await db.client.query("savepoint acceptance_attempt");
    try {
      return (await db.client.query("select public.record_invitation_legal_acceptance($1, $2::jsonb, $3, true) r",
        [invitationId, JSON.stringify(published), state])).rows[0].r;
    } catch (error) {
      await db.client.query("rollback to savepoint acceptance_attempt");
      throw error;
    } finally {
      await db.client.query("release savepoint acceptance_attempt");
      await db.client.query("reset role");
    }
  }

  it("retains both organizations' invitation acceptances even after sign-in accepted the same pack", async () => {
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    await db.client.query("begin");
    try {
      await db.client.query(`insert into public.member_invitations
        (id, status, auth_user_id, chapter_id) values
        ($1, 'accepting', $3, 'chapter-a'), ($2, 'accepting', $3, 'chapter-b')`, [first, second, user]);
      expect(await invitationAcceptance(first)).toEqual({ recorded: true });
      expect(await invitationAcceptance(second)).toEqual({ recorded: true });
      const beforeRetry = (await db.client.query(`select chapter_id, source, accepted_at
        from private.legal_acceptances where user_id = $1 order by chapter_id, source`, [user])).rows;
      expect(beforeRetry.map(({ chapter_id, source }) => ({ chapter_id, source }))).toEqual([
        { chapter_id: "chapter-a", source: "invitation" },
        { chapter_id: "chapter-a", source: "signin" },
        { chapter_id: "chapter-b", source: "invitation" },
      ]);
      await invitationAcceptance(first);
      await invitationAcceptance(second);
      expect((await db.client.query(`select chapter_id, source, accepted_at
        from private.legal_acceptances where user_id = $1 order by chapter_id, source`, [user])).rows)
        .toEqual(beforeRetry);
    } finally { await db.client.query("rollback"); }
  });

  it.each([null, "2000-01-01"])("resolves a padded reactivation email and excludes deleted and banned duplicates (%s)", async (ban) => {
    const invitation = "10000000-0000-4000-8000-000000000003";
    const eligible = "00000000-0000-4000-8000-000000000002";
    await db.client.query("begin");
    try {
      await db.client.query("insert into public.member_profiles values ($1, 'chapter-b')", [eligible]);
      await db.client.query(`insert into auth.users (id, email, deleted_at, banned_until) values
        ($1, '  Former@Example.Invalid  ', null, $2),
        ('00000000-0000-4000-8000-000000000003', 'former@example.invalid', null, 'infinity'),
        ('00000000-0000-4000-8000-000000000004', 'former@example.invalid', now(), null)`, [eligible, ban]);
      await db.client.query(`insert into public.member_invitations
        (id, status, normalized_email, chapter_id) values ($1, 'accepting', 'former@example.invalid', 'chapter-b')`, [invitation]);
      expect(await invitationAcceptance(invitation)).toEqual({ recorded: true });
      expect((await db.client.query("select user_id, chapter_id from private.legal_acceptances where source = 'invitation'")).rows)
        .toEqual([{ user_id: eligible, chapter_id: "chapter-b" }]);
    } finally { await db.client.query("rollback"); }
  });

  it("refuses a reactivation with only a banned identity and writes nothing", async () => {
    const invitation = "10000000-0000-4000-8000-000000000004";
    await db.client.query("begin");
    try {
      await db.client.query("insert into auth.users values ($1, 'banned@example.invalid', null, 'infinity')", [user]);
      await db.client.query(`insert into public.member_invitations
        (id, status, normalized_email, chapter_id) values ($1, 'accepting', 'banned@example.invalid', 'chapter-a')`, [invitation]);
      await expect(invitationAcceptance(invitation)).rejects.toMatchObject({ code: "22023", message: "invitation identity unavailable" });
    } finally { await db.client.query("rollback"); }
    expect((await db.client.query("select count(*)::int n from private.legal_acceptances where source = 'invitation'")).rows[0].n).toBe(0);
  });

  it("retains sign-in acceptance for the current organization after a chapter change", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("update public.member_profiles set chapter_id = 'chapter-b' where id = $1", [user]);
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(published)]);
      expect((await db.client.query(`select chapter_id from private.legal_acceptances
        where user_id = $1 and source = 'signin' order by chapter_id`, [user])).rows)
        .toEqual([{ chapter_id: "chapter-a" }, { chapter_id: "chapter-b" }]);
    } finally { await db.client.query("rollback"); }
  });

  it("refuses two eligible identities for the same normalized address", async () => {
    const invitation = "10000000-0000-4000-8000-000000000005";
    await db.client.query("begin");
    try {
      await db.client.query(`insert into auth.users (id, email) values
        ($1, 'ambiguous@example.invalid'),
        ('00000000-0000-4000-8000-000000000005', '  Ambiguous@Example.Invalid  ')`, [user]);
      await db.client.query(`insert into public.member_invitations
        (id, status, normalized_email, chapter_id) values ($1, 'accepting', 'ambiguous@example.invalid', 'chapter-a')`, [invitation]);
      await expect(invitationAcceptance(invitation)).rejects.toMatchObject({ code: "22023", message: "invitation identity unavailable" });
      expect((await db.client.query("select count(*)::int n from private.legal_acceptances where source = 'invitation'")).rows[0].n).toBe(0);
    } finally { await db.client.query("rollback"); }
  });

  it("uses a forward migration's validator without rewriting the historical migration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "legal-forward-"));
    const next = { ...published, "terms-of-use": "0.4.0" };
    const future = validator.replace(/if p_versions <> '[^']+'::jsonb/,
      `if p_versions <> '${JSON.stringify(next)}'::jsonb`);
    try {
      writeFileSync(join(directory, "20261010213000_initial.sql"), migration);
      writeFileSync(join(directory, "20261012233000_adults_only.sql"), adultsOnly);
      writeFileSync(join(directory, "20261016170000_app_store_states.sql"), appStoreStates);
      writeFileSync(join(directory, "20261017000000_next.sql"), future);
      await db.client.query("begin");
      await db.client.query(latestValidator(directory));
      expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [JSON.stringify(next)]))
        .rows[0].r.recorded).toBe(true);
    } finally {
      await db.client.query("rollback");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains each highest numeric version when older packs arrive later", async () => {
    // Model accepted historical releases as owner-held rows; public writes
    // still refuse every pack except the current published one above.
    for (const [versions, time] of [
      [{ ...published, "terms-of-use": "1.10.0", "privacy-policy": "2.0.0" }, "2026-10-10 12:00:00+00"],
      [{ ...published, "terms-of-use": "1.9.0", "privacy-policy": "1.2.0" }, "2026-10-11 12:00:00+00"],
    ]) {
      await db.client.query(`insert into private.legal_acceptances
        (user_id, chapter_id, terms_version, instrument_versions, source, accepted_at, residence_state, adult_attested)
        values ($1, 'chapter-a', $2, $3::jsonb, 'signin', $4, 'TX', true)`,
      [user, versions["terms-of-use"], JSON.stringify(versions), time]);
    }
    const read = () => signedIn("select public.get_my_legal_acceptance_state() r");
    expect((await read()).rows[0].r.versions).toEqual({ ...published, "terms-of-use": "1.10.0", "privacy-policy": "2.0.0" });
    await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(published)]);
    expect((await read()).rows[0].r.versions["terms-of-use"]).toBe("1.10.0");
  });

  it("refuses either writer without a listed state or the age attestation and records the rule the state selects", async () => {
    const invitation = "10000000-0000-4000-8000-000000000006";
    const count = async () => (await db.client.query("select count(*)::int n from private.legal_acceptances")).rows[0].n;
    const before = await count();
    await db.client.query("begin");
    try {
      for (const [state, attested, message] of [
        [null, true, "residence state required"], ["ZZ", true, "residence state required"], ["tx", true, "residence state required"],
        ["TX", false, "age attestation required"], ["OH", null, "age attestation required"],
      ]) {
        await db.client.query("savepoint refused");
        await db.client.query("set role authenticated");
        await expect(db.client.query("select public.record_legal_acceptance($1::jsonb, $2, $3)", [JSON.stringify(published), state, attested]))
          .rejects.toMatchObject({ code: "22023", message });
        await db.client.query("rollback to savepoint refused");
        await db.client.query("reset role");
      }
      await db.client.query(`insert into public.member_invitations
        (id, status, auth_user_id, chapter_id) values ($1, 'accepting', $2, 'chapter-a')`, [invitation, user]);
      await db.client.query("select set_config('test.role', 'service_role', false)");
      await db.client.query("set role service_role");
      for (const [state, attested, message] of [["CA", false, "age attestation required"], [null, true, "residence state required"]]) {
        await db.client.query("savepoint refused");
        await expect(db.client.query("select public.record_invitation_legal_acceptance($1, $2::jsonb, $3, $4)",
          [invitation, JSON.stringify(published), state, attested])).rejects.toMatchObject({ code: "22023", message });
        await db.client.query("rollback to savepoint refused");
      }
        // The previous site's probe is retired: after the 1.0.0 pin it answers
      // false, so a site still sending an earlier pack refuses before a claim.
      expect((await db.client.query("select public.legal_acceptance_residence_ready() r")).rows[0].r).toBe(false);
      // The version-aware probe the route reads now: true for the published
      // pack, false (not an error) for any other map, so a mismatched deploy
      // refuses before it creates, emails or binds an identity.
      expect((await db.client.query("select public.legal_acceptance_pack_ready($1::jsonb) r",
        [JSON.stringify(published)])).rows[0].r).toBe(true);
      expect((await db.client.query("select public.legal_acceptance_pack_ready($1::jsonb) r",
        [JSON.stringify({ ...published, "terms-of-use": "0.3.0" })])).rows[0].r).toBe(false);
      await db.client.query("reset role");
      expect(await count()).toBe(before);
      // An app-store age-law state records the 18-or-older attestation; any
      // other listed region records the D-03 B band.
      const second = "10000000-0000-4000-8000-000000000007";
      await db.client.query(`insert into public.member_invitations
        (id, status, auth_user_id, chapter_id) values ($1, 'accepting', $2, 'chapter-b')`, [second, user]);
      expect(await invitationAcceptance(invitation, "LA")).toEqual({ recorded: true });
      expect(await invitationAcceptance(second, "outside-us")).toEqual({ recorded: true });
      // The same pack from the same source is one event, but a retry with a
      // different state (say after a lost response) records the latest state
      // and the rule it selects; a retry with the same state changes nothing.
      const signinRow = () => db.client.query(`select id, accepted_at, residence_state from private.legal_acceptances
        where user_id = $1 and instrument_versions = $2::jsonb and source = 'signin'`, [user, JSON.stringify(published)]);
      const original = (await signinRow()).rows[0];
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(published)]);
      expect((await signinRow()).rows).toEqual([original]);
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'outside-us', true)", [JSON.stringify(published)]);
      expect((await signinRow()).rows).toEqual([{ ...original, residence_state: "outside-us" }]);
      expect(await invitationAcceptance(invitation, "OH")).toEqual({ recorded: true });
      expect((await db.client.query(`select residence_state, adult_attested, band_attested from private.legal_acceptances
        where user_id = $1 and chapter_id = 'chapter-a' and source = 'invitation'`, [user])).rows)
        .toEqual([{ residence_state: "OH", adult_attested: false, band_attested: true }]);
      expect(await invitationAcceptance(invitation, "LA")).toEqual({ recorded: true });
      expect((await db.client.query(`select chapter_id, source, terms_version, residence_state, adult_attested, band_attested
        from private.legal_acceptances where user_id = $1 and instrument_versions = $2::jsonb order by chapter_id, source`,
        [user, JSON.stringify(published)])).rows).toEqual([
        { chapter_id: "chapter-a", source: "invitation", terms_version: published["terms-of-use"], residence_state: "LA", adult_attested: true, band_attested: false },
        { chapter_id: "chapter-a", source: "signin", terms_version: published["terms-of-use"], residence_state: "outside-us", adult_attested: false, band_attested: true },
        { chapter_id: "chapter-b", source: "invitation", terms_version: published["terms-of-use"], residence_state: "outside-us", adult_attested: false, band_attested: true },
      ]);
    } finally { await db.client.query("rollback"); }
  });

  it.each([["TX", "adult"], ["CA", "adult"], ["AL", "adult"], ["UT", "adult"], ["LA", "adult"],
    ["NY", "band"], ["DC", "band"], ["PR", "band"], ["outside-us", "band"], ["ZZ", null], ["", null], [null, null]])(
    "derives the age rule for %s as %s",
    async (state, rule) => {
      expect((await db.client.query("select private.residence_age_rule($1) r", [state])).rows[0].r).toBe(rule);
    },
  );

  it("keeps each row to the rule of the terms version it accepted", async () => {
    const row = (version, state, adult, band) => db.client.query(`insert into private.legal_acceptances
      (user_id, chapter_id, terms_version, instrument_versions, source, residence_state, adult_attested, band_attested)
      values ($1, 'chapter-a', $2, $3::jsonb, 'signin', $4, $5, $6)`,
    [user, version, JSON.stringify({ ...published, "terms-of-use": version, n: `${state}-${adult}-${band}` }), state, adult, band]);
    const refused = async (...args) => {
      await db.client.query("savepoint refused");
      await expect(row(...args)).rejects.toMatchObject({ code: "23514" });
      await db.client.query("rollback to savepoint refused");
    };
    await db.client.query("begin");
    try {
      // 0.1.x asked nothing about age; 0.2.x required 18 or older everywhere.
      await row("0.1.0", null, false, false);
      await refused("0.2.0", null, false, false);
      await row("0.2.0", null, true, false);
      // From 0.3.0 the stated residence selects exactly one attestation.
      await refused("0.3.0", null, true, false);
      await refused("0.3.0", "ZZ", false, true);
      await refused("0.3.0", "TX", false, true);
      await refused("0.3.0", "TX", true, true);
      await refused("0.3.0", "OH", true, false);
      await refused("0.10.0", "OH", false, false);
      await row("0.3.0", "TX", true, false);
      await row("0.3.0", "OH", false, true);
      await row("0.10.0", "outside-us", false, true);
    } finally { await db.client.query("rollback"); }
  });

  it("upgrades invitation readiness through privacy 1.2.1 without rewriting prior acceptance", async () => {
    // The privacy 1.0.2 pin: privacy 1.0.2 and terms 1.0.1, the rest at 1.0.0.
    const pkcePack = { ...Object.fromEntries(Object.keys(published).map(key => [key, "1.0.0"])),
      "privacy-policy": "1.0.2", "terms-of-use": "1.0.1" };
    const privacyPack = { ...pkcePack, "privacy-policy": "1.0.1", "terms-of-use": "1.0.0" };
    const termsPack = { ...pkcePack, "privacy-policy": "1.0.1" };
    const previous = { ...privacyPack, "privacy-policy": "1.0.0" };
    const existingUser = "00000000-0000-4000-8000-000000000008";
    const ready = async (pairs) => {
      await db.client.query("set role service_role");
      try {
        for (const [versions, expected] of pairs) {
          expect((await db.client.query("select public.legal_acceptance_pack_ready($1::jsonb) r", [JSON.stringify(versions)])).rows[0].r).toBe(expected);
        }
      } finally { await db.client.query("reset role"); }
    };
    const existingRows = async () => (await db.client.query("select * from private.legal_acceptances where user_id = $1 order by accepted_at", [existingUser])).rows;
    await db.client.query("insert into public.member_profiles values ($1, 'chapter-a')", [existingUser]);
    await db.client.query("select set_config('test.user', $1, false)", [existingUser]);
    try {
      // Restore only the exact previous validator, not the one-time CREATE of
      // the readiness probe that is already installed by beforeAll.
      await db.client.query(operativePack.slice(
        operativePack.indexOf("create or replace function private.legal_acceptance_versions"),
        operativePack.indexOf("-- api/accept-invitation.js creates"),
      ));
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(previous)]);
      const snapshot = await existingRows();
      expect(snapshot.length).toBeGreaterThan(0);
      await db.client.query(privacyRevision);
      expect(await existingRows()).toEqual(snapshot);
      await ready([[previous, false], [privacyPack, true], [termsPack, false], [pkcePack, false]]);
      // Terms 1.0.1 (free pilot) lands on the privacy 1.0.1 validator.
      await db.client.query(termsRevision);
      expect(await existingRows()).toEqual(snapshot);
      await ready([[previous, false], [privacyPack, false], [termsPack, true], [pkcePack, false]]);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(privacyPack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      // Privacy 1.0.2 (PKCE storage) lands on the terms 1.0.1 validator.
      await db.client.query(pkcePrivacyRevision);
      expect(await existingRows()).toEqual(snapshot);
      await ready([[previous, false], [privacyPack, false], [termsPack, false], [pkcePack, true]]);
      const state = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(state.versions).toEqual(previous);
      // 1.0.1 and 1.0.2 alone are nonmaterial; the material 1.1.0 is what re-prompts.
      expect(legalAcceptanceRequirement(state).reacceptanceRequired).toBe(true);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(termsPack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [JSON.stringify(pkcePack)])).rows[0].r)
        .toEqual({ recorded: true, chapterId: "chapter-a" });
      expect((await db.client.query("select terms_version from private.legal_acceptances where user_id = $1 order by terms_version", [existingUser])).rows)
        .toEqual([{ terms_version: "1.0.0" }, { terms_version: "1.0.1" }]);
      // The predecessor guard refuses to replay over its own result.
      await expect(db.client.query(pkcePrivacyRevision)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      // Compass training 1.1.0 lands only on the privacy 1.0.2 validator; this
      // leaves the current validator installed, as beforeAll did.
      // Compass training 1.1.0 lands only on the privacy 1.0.2 validator.
      await db.client.query(trainingGuard);
      await db.client.query(trainingValidator);
      const trainingPack = { "privacy-policy": "1.1.0", "terms-of-use": "1.1.0", "accessibility-statement": "1.0.0", "ai-disclosure": "1.1.0", "retention-schedule": "1.1.0" };
      expect(trainingPack).toEqual({ "privacy-policy": "1.1.0", "terms-of-use": "1.1.0", "accessibility-statement": "1.0.0", "ai-disclosure": "1.1.0", "retention-schedule": "1.1.0" });
      await ready([[pkcePack, false], [trainingPack, true]]);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(pkcePack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [JSON.stringify(trainingPack)])).rows[0].r)
        .toEqual({ recorded: true, chapterId: "chapter-a" });
      await expect(db.client.query(trainingGuard)).rejects.toMatchObject({ code: "55000" });
      // The heatmaps pin refuses the older training validator.
      await expect(db.client.query(heatmapsRevision)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      // Privacy 1.2.0 (#6247) lands only on the training validator.
      const accepted = await existingRows();
      await db.client.query(analyticsRevision);
      expect(await existingRows()).toEqual(accepted);
      const analyticsPack = { ...trainingPack, "privacy-policy": "1.2.0" };
      await ready([[trainingPack, false], [analyticsPack, true], [published, false]]);
      // Material: a member who accepted 1.1.0 is asked to accept again.
      const before = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(before.versions).toEqual(trainingPack);
      expect(legalAcceptanceRequirement(before).reacceptanceRequired).toBe(true);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(trainingPack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [JSON.stringify(analyticsPack)])).rows[0].r)
        .toEqual({ recorded: true, chapterId: "chapter-a" });
      await expect(db.client.query(analyticsRevision)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");

      // Privacy 1.2.1 must follow exactly 1.2.0. Both previous acceptance
      // maps and timestamps survive; only the new pack can now be written.
      const analyticsAccepted = await existingRows();
      await db.client.query(heatmapsRevision);
      expect(await existingRows()).toEqual(analyticsAccepted);
      const heatmapsPack = { ...analyticsPack, "privacy-policy": "1.2.1" };
      await ready([[trainingPack, false], [analyticsPack, false], [heatmapsPack, true]]);
      const beforeHeatmaps = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(beforeHeatmaps.versions).toEqual(analyticsPack);
      expect(legalAcceptanceRequirement(beforeHeatmaps).reacceptanceRequired).toBe(true);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(analyticsPack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      expect((await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [JSON.stringify(heatmapsPack)])).rows[0].r)
        .toEqual({ recorded: true, chapterId: "chapter-a" });
      const afterHeatmaps = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(legalAcceptanceRequirement(afterHeatmaps).reacceptanceRequired).toBe(true);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await db.client.query("select has_function_privilege($1, 'private.legal_acceptance_versions(jsonb)', 'execute') allowed", [role])).rows[0].allowed).toBe(false);
      }
      await expect(db.client.query(heatmapsRevision)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      // The publisher-purpose amendment preserves the heatmap notice and
      // historical acceptance while moving the authority to privacy 1.3.0.
      const acceptedHeatmaps = await existingRows();
      const announcementSql = readFileSync(new URL("../supabase/migrations/20261029235622_platform_announcements_consumers_and_controls.sql", import.meta.url), "utf8");
      const announcementPrivacy = announcementSql.slice(announcementSql.indexOf("do $previous_pack$"), announcementSql.indexOf("-- Bind a delayed consumer request"));
      await db.client.query(announcementPrivacy);
      expect(await existingRows()).toEqual(acceptedHeatmaps);
      const announcementsPack = { ...heatmapsPack, "privacy-policy": "1.3.0" };
      await ready([[heatmapsPack, false], [announcementsPack, true]]);
      await expect(signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(heatmapsPack)]))
        .rejects.toMatchObject({ code: "22023", message: "legal versions not current" });
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(announcementsPack)]);
      const afterAnnouncements = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(legalAcceptanceRequirement(afterAnnouncements, instrumentsAt(announcementsPack)).reacceptanceRequired).toBe(false);
      await expect(db.client.query(announcementPrivacy)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      // REQ-UG-NAVIGATION-PINNED-SHORTCUTS-20261030: the nonmaterial
      // privacy 1.3.1 storage disclosure follows exactly 1.3.0, keeps every
      // recorded acceptance, and asks no 1.3.0 acceptance again.
      const acceptedAnnouncements = await existingRows();
      const navigationPins = readFileSync(new URL("../supabase/migrations/20261031000500_privacy_1_3_1_navigation_pins_storage.sql", import.meta.url), "utf8");
      await db.client.query(navigationPins);
      expect(await existingRows()).toEqual(acceptedAnnouncements);
      const navigationPinsPack = { ...announcementsPack, "privacy-policy": "1.3.1" };
      await ready([[announcementsPack, false], [navigationPinsPack, true]]);
      const beforePins = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(beforePins.versions).toEqual(announcementsPack);
      expect(legalAcceptanceRequirement(beforePins, instrumentsAt(navigationPinsPack)).reacceptanceRequired).toBe(false);
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(navigationPinsPack)]);
      await expect(db.client.query(navigationPins)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      // REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030: the
      // nonmaterial privacy 1.3.2 recipients sentence follows exactly 1.3.1,
      // keeps every recorded acceptance, and asks no 1.3.1 acceptance again.
      const acceptedPins = await existingRows();
      const officerExportSql = readFileSync(new URL("../supabase/migrations/20261031020000_officer_member_directory_and_export.sql", import.meta.url), "utf8");
      const officerExportPrivacy = officerExportSql.slice(officerExportSql.indexOf("do $previous_pack$"), officerExportSql.indexOf("notify pgrst"));
      await db.client.query(officerExportPrivacy);
      expect(await existingRows()).toEqual(acceptedPins);
      const officerExportPack = { ...navigationPinsPack, "privacy-policy": "1.3.2" };
      await ready([[navigationPinsPack, false], [officerExportPack, true]]);
      const beforeOfficerExport = (await signedIn("select public.get_my_legal_acceptance_state() r")).rows[0].r;
      expect(beforeOfficerExport.versions).toEqual(navigationPinsPack);
      expect(legalAcceptanceRequirement(beforeOfficerExport, instrumentsAt(officerExportPack)).reacceptanceRequired).toBe(false);
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(officerExportPack)]);
      await expect(db.client.query(officerExportPrivacy)).rejects.toMatchObject({ code: "55000" });
      await db.client.query("rollback");
      const acceptedOfficerExport = await existingRows();
      const migrationDirectory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
      const plan = legalAcceptanceMigrationPlan(readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")));
      expect(plan[0]).toBe(CHART_VALIDATOR_MIGRATION);
      const slices = plan.map((name) => {
        const chartSql = readFileSync(join(migrationDirectory, name), "utf8");
        const definitionAt = chartSql.lastIndexOf("create or replace function private.legal_acceptance_versions");
        const packAt = chartSql.lastIndexOf("do $", definitionAt);
        expect(definitionAt).toBeGreaterThan(0);
        expect(packAt).toBeGreaterThanOrEqual(0);
        return chartSql.slice(packAt, chartSql.indexOf("notify pgrst", definitionAt));
      });
      const chartPrivacy = slices[0];
      await db.client.query(chartPrivacy);
      expect(await existingRows()).toEqual(acceptedOfficerExport);
      for (const slice of slices.slice(1)) {
        await db.client.query(slice);
        expect(await existingRows()).toEqual(acceptedOfficerExport);
      }
      expect(published["privacy-policy"]).not.toEqual(officerExportPack["privacy-policy"]);
      await ready([[officerExportPack, false], [published, true]]);
      const beforeChart = (await signedIn('select public.get_my_legal_acceptance_state() r')).rows[0].r;
      expect(beforeChart.versions).toEqual(officerExportPack);
      // Whether the current catalogue asks again follows from its material
      // history: any material version newer than what officerExportPack held.
      const materialSinceOfficerExport = LEGAL_INSTRUMENTS.some((entry) => {
        const required = latestMaterialLegalVersion(entry);
        return required !== null && compareLegalVersions(officerExportPack[entry.key], required) < 0;
      });
      expect(legalAcceptanceRequirement(beforeChart).reacceptanceRequired).toBe(materialSinceOfficerExport);
      await signedIn("select public.record_legal_acceptance($1::jsonb, 'TX', true)", [JSON.stringify(published)]);
      await expect(db.client.query(chartPrivacy)).rejects.toMatchObject({ code: '55000' });
      await db.client.query('rollback');
    } finally {
      await db.client.query("select set_config('test.user', $1, false)", [user]);
    }
  });
});
