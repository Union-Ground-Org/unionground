#!/usr/bin/env node
// Read-only qualification and RLS behavior probes for a future legitimately
// onboarded organization. The manifest is external, short-lived, checksum
// pinned, exact-SHA scoped, and never committed. This lane creates no users,
// tenants, chapters, sessions, credentials, or product records.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertExactTarget } from "./lib/assert-exact-target.mjs";
import {
  actorMeetsRoleBoundary,
  actorMeetsMfaBoundary,
  assertAuthorizedSupabaseEndpoint,
  sha256Hex,
  TRUSTED_AUTHORIZATION_KEYS,
  validateAuthorizedRpcManifest,
} from "./lib/authorized-rpc-manifest.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const contract = JSON.parse(readFileSync(new URL("./db-contract.json", import.meta.url), "utf8"));

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function outsideRepository(pathname) {
  const rel = relative(repositoryRoot, pathname);
  return rel.startsWith("..") || isAbsolute(rel);
}

function executingCheckout() {
  const sourceSha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim().toLowerCase();
  const dirty = execFileSync(
    "git",
    ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  if (dirty) fail("authorized RPC verification requires a clean executing checkout");
  return sourceSha;
}

async function callAs(client, actor, sql, values = []) {
  await client.query("savepoint authorized_probe");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: actor.userId,
      role: "authenticated",
      aal: "aal2",
    })]);
    await client.query("set local role authenticated");
    const result = await client.query(sql, values);
    await client.query("rollback to savepoint authorized_probe");
    return result.rows;
  } catch (error) {
    await client.query("rollback to savepoint authorized_probe");
    throw error;
  }
}

async function run() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) fail("SUPABASE_DB_URL is required for the authorized identity lane");
  const manifestInput = (process.env.RPC_BEHAVIOUR_AUTHORIZED_MANIFEST ?? "").trim();
  if (!manifestInput) fail("RPC_BEHAVIOUR_AUTHORIZED_MANIFEST must point to an external authorization manifest");
  const expectedDigest = (process.env.RPC_BEHAVIOUR_AUTHORIZATION_SHA256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) fail("RPC_BEHAVIOUR_AUTHORIZATION_SHA256 must be a SHA-256 digest");
  const expectedSha = (process.env.RPC_BEHAVIOUR_EXPECTED_SHA ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail("RPC_BEHAVIOUR_EXPECTED_SHA must be an exact commit SHA");
  const checkoutSha = executingCheckout();
  if (checkoutSha !== expectedSha) fail("RPC_BEHAVIOUR_EXPECTED_SHA does not match the executing checkout SHA");

  const manifestPath = realpathSync(resolve(manifestInput));
  if (!outsideRepository(manifestPath)) fail("the authorization manifest must live outside the repository");
  const manifestBytes = readFileSync(manifestPath);
  if (sha256Hex(manifestBytes) !== expectedDigest) fail("authorization manifest checksum mismatch");

  assertExactTarget(contract.target, connectionString);
  assertAuthorizedSupabaseEndpoint(connectionString, contract.target.projectRef);
  const manifest = validateAuthorizedRpcManifest(manifestBytes.toString("utf8"), {
    expectedSha,
    targetProjectRef: contract.target.projectRef,
    trustedPublicKeys: TRUSTED_AUTHORIZATION_KEYS,
  });

  const targetHost = new URL(connectionString).hostname;
  const loopback = targetHost === "127.0.0.1" || targetHost === "localhost" || targetHost.endsWith(".localhost");
  if (loopback) fail("the legitimate-identity lane refuses local or disposable databases");

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
    application_name: "verify-rpc-behaviour-authorized",
  });
  const checks = [];
  const check = (name, ok) => {
    checks.push({ name, ok });
    console.log(`${ok ? "  ok " : "FAIL "} ${name}`);
  };

  try {
    await client.connect();
    await client.query("begin transaction isolation level repeatable read read only");
    const actorEntries = Object.entries(manifest.actors);
    const ids = actorEntries.map(([, actor]) => actor.userId);
    const organizationIds = actorEntries.map(([, actor]) => actor.organizationId);
    const chapterIds = actorEntries.map(([, actor]) => actor.chapterId);
    const qualification = await client.query(
      `with actor_scope(user_id, organization_id, chapter_id) as (
         select * from unnest($1::uuid[], $2::uuid[], $3::text[])
       )
       select u.id::text as user_id,
              u.is_anonymous,
              u.email_confirmed_at is not null as email_confirmed,
              u.email is not null and btrim(u.email) <> ''
                and u.encrypted_password is not null
                and u.encrypted_password <> '' as password_login_capable,
              u.deleted_at is null
                and (u.banned_until is null or u.banned_until <= now()) as auth_active,
              om.organization_id::text as organization_id,
              om.status as membership_status,
              o.status as organization_status,
              p.chapter_id::text as chapter_id,
              cm.status as chapter_membership_status,
              c.organization_id::text as chapter_organization_id,
              coalesce(policy.require_staff_mfa, true) as staff_mfa_required,
              coalesce(factor.verified_totp_count, 0)::integer as verified_totp_count,
              coalesce(chapter_role.roles, '{}'::text[]) as chapter_roles,
              coalesce(organization_role.roles, '{}'::text[]) as organization_roles
         from actor_scope scope
         join auth.users u on u.id = scope.user_id
         join public.organization_memberships om
           on om.user_id = u.id and om.organization_id = scope.organization_id
         join public.organizations o on o.id = om.organization_id
         join public.member_profiles p on p.id = u.id and p.chapter_id = scope.chapter_id
         join public.member_chapter_memberships cm
           on cm.user_id = u.id and cm.chapter_id = scope.chapter_id
         join public.chapters c
           on c.id = scope.chapter_id and c.organization_id = scope.organization_id
         left join lateral (
           select p.require_staff_mfa
             from public.org_security_policy p
            where p.organization_id = scope.organization_id
         ) policy on true
         left join lateral (
           select count(*)::integer as verified_totp_count
             from auth.mfa_factors f
            where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp'
         ) factor on true
         left join lateral (
           select array_agg(distinct rc.role::text) as roles
             from public.member_role_chapters rc
            where rc.user_id = u.id and rc.chapter_id = scope.chapter_id
         ) chapter_role on true
         left join lateral (
           select array_agg(distinct g.role::text) as roles
             from public.organization_role_grants g
            where g.user_id = u.id and g.organization_id = om.organization_id
         ) organization_role on true`,
      [ids, organizationIds, chapterIds],
    );
    const byUser = new Map(qualification.rows.map((row) => [row.user_id, row]));
    check("all authorized identities exist exactly once", byUser.size === 3);

    for (const [actorName, actor] of actorEntries) {
      const row = byUser.get(actor.userId);
      check(`${actorName} is an active confirmed non-anonymous identity`, Boolean(
        row && !row.is_anonymous && row.email_confirmed
          && row.password_login_capable && row.auth_active,
      ));
      check(`${actorName} has the authorized active organization membership`, Boolean(
        row && row.organization_id === actor.organizationId
          && row.membership_status === "active" && row.organization_status === "active",
      ));
      check(`${actorName} has the authorized active selected chapter`, Boolean(
        row && row.chapter_id === actor.chapterId && row.chapter_organization_id === actor.organizationId
          && row.chapter_membership_status === "active",
      ));
      check(`${actorName} role boundary matches the authorization`, Boolean(row && actorMeetsRoleBoundary(
        actorName,
        { chapterRoles: row.chapter_roles, organizationRoles: row.organization_roles },
      )));
      check(`${actorName} MFA topology matches the governed matrix`, Boolean(
        row && actorMeetsMfaBoundary(actorName, row.staff_mfa_required, row.verified_totp_count),
      ));

      const selfRows = await callAs(
        client,
        actor,
        "select id::text from public.member_profiles where id = $1::uuid",
        [actor.userId],
      );
      check(`${actorName} can read their own profile through RLS`, selfRows.length === 1);
    }

    const memberForeignRows = await callAs(
      client,
      manifest.actors.member,
      "select id::text from public.member_profiles where id = $1::uuid",
      [manifest.actors.foreignStaff.userId],
    );
    check("member cannot read the foreign-organization staff profile", memberForeignRows.length === 0);
    const staffForeignRows = await callAs(
      client,
      manifest.actors.staff,
      "select id::text from public.member_profiles where id = $1::uuid",
      [manifest.actors.foreignStaff.userId],
    );
    check("staff cannot read the foreign-organization staff profile", staffForeignRows.length === 0);
    const foreignMemberRows = await callAs(
      client,
      manifest.actors.foreignStaff,
      "select id::text from public.member_profiles where id = $1::uuid",
      [manifest.actors.member.userId],
    );
    check("foreign staff cannot read the member profile", foreignMemberRows.length === 0);

    await client.query("rollback");
  } finally {
    await client.end().catch(() => {});
  }

  const failures = checks.filter((entry) => !entry.ok);
  if (failures.length) fail(`${failures.length} authorized identity qualification check(s) failed`);
  console.log(`PASS: ${checks.length} legitimate-identity qualification and RLS checks; zero product writes executed.`);
  console.log(
    "IDENTITY-QUALIFIED: signed identity, scope, MFA, and RLS prerequisites passed; "
    + "domain-specific topology and mutation probes remain separately gated.",
  );
}

run().catch((error) => fail(error?.message ?? String(error)));
