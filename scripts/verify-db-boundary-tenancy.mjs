#!/usr/bin/env node
// Two-organization RLS proof for the db-boundary security batch:
//
//   SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817
//   SEC-UG-BROADCASTS-CHAPTER-BOUNDARY-20260817
//
// WHY A LIVE PROOF AND NOT ONLY TEXT PINS. Both records are about what a
// SECOND customer organization can read. A static assertion that a policy
// mentions `organization_id` cannot distinguish "same organization only" from
// "any organization", and the two records were opened precisely because an
// earlier reviewer read an org-wide policy as tenant-scoped when it was
// global. The only honest answer is to stand two organizations up, give them
// chapters with the SAME NAME, and ask the database.
//
// SAFETY. Everything runs inside ONE transaction and this script never issues
// COMMIT: the only terminating statement is ROLLBACK, in a finally block, and
// `assertNoCommit` below refuses to send any statement that could end the
// transaction another way. That is what makes it safe against a SHARED local
// stack — no fixture, no organization, and no chapter survives the run. It
// still refuses production and the SAMPLE project refs outright, and refuses
// any non-loopback host, because a rolled-back transaction on a production
// primary is still load, locks, and sequence burn.
//
//   SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54422/postgres' \
//     npm run verify:db-boundary:local
//
// With no URL it SKIPs and exits 0 on a developer machine, matching
// verify-migration-history.mjs. REQUIRE_DB_VERIFY turns the skip into a
// failure (see lib/require-db-verify.mjs for the values that arm it), and so
// does running on a GitHub Actions runner at all: the required DB lane runs
// this proof through tests/db-boundary-tenancy-db.test.js with the lane's URL,
// so a CI run that reaches it without one is miswired, and a two-tenant
// isolation proof must not read green there
// (SYS-UG-DB-BOUNDARY-PROOF-ABSENT-FROM-CI-20260921).
import { migrateLegacyStewardFixtures } from "../tests/helpers/steward-unit-fixtures.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import pg from "pg";
import { localMigrations, normalise } from "./verify-migration-history.mjs";
import { requireDbVerify } from "./lib/require-db-verify.mjs";
import { forbiddenProjectRefIn } from "./lib/assert-exact-target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(HERE, "db-contract.json"), "utf8"));

const failures = [];
let checks = 0;

function check(label, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures.push(detail ? `${label} — ${detail}` : label);
}

function eq(label, expected, actual) {
  check(label, expected === actual, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- target guard
function assertSafeTarget(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new Error(`refusing a non-loopback host: ${host}. This proof creates fixtures; run it against a local stack only.`);
  }
  const haystack = `${parsed.hostname}${parsed.username}`.toLowerCase();
  // projectRef is null until a Union Ground database is provisioned.
  const banned = [contract.target.projectRef, forbiddenProjectRefIn(contract.target, haystack)].filter(Boolean);
  for (const ref of banned) {
    if (haystack.includes(ref.toLowerCase())) {
      throw new Error(`refusing project ref ${ref} — production and SAMPLE databases are never fixture targets.`);
    }
  }
}

// Every version on either side whose normalised statements differ, is
// missing from the stack, or has no local file. Normalised as
// verify-migration-history.mjs does, so comment and whitespace edits match.
export function migrationDigestDrift(local, recordedRows) {
  const recorded = new Map(recordedRows.map((row) => [row.version, normalise(row.sql)]));
  const drift = [];
  for (const [version, { file, hash }] of [...local].sort()) {
    if (!recorded.has(version)) drift.push(`${file} is not applied`);
    else if (recorded.get(version) !== hash) drift.push(`${file} differs from the recorded statements`);
  }
  for (const version of [...recorded.keys()].sort()) {
    if (!local.has(version)) drift.push(`${version} is recorded but has no local file`);
  }
  return drift;
}

// Nothing this script sends may end the transaction. A stray COMMIT, END
// (`end;`, `END ;`, or END after another statement), or PREPARE TRANSACTION
// would leave two fictional organizations behind on a shared developer
// database, which the repository tenancy contract forbids outright.
//
// Judged on statement text with comments, quoted literals, and dollar-quoted
// bodies masked, so a PL/pgSQL `end;` / `end if;` inside `$function$` / `$$`
// is not a transaction END, and neither is a `case ... end` expression, which
// never follows a `;`. scripts/lib/sql-text.mjs deliberately does not treat
// dollar-quoted bodies as opaque, so this scan stays local.
function maskExecutableSql(sql) {
  const commentEnd = (start) => {
    if (sql.startsWith("--", start)) {
      const newline = sql.indexOf("\n", start);
      return newline === -1 ? sql.length : newline;
    }
    if (!sql.startsWith("/*", start)) return -1;
    let depth = 1;
    let cursor = start + 2;
    while (cursor < sql.length && depth > 0) {
      if (sql.startsWith("/*", cursor)) {
        depth += 1;
        cursor += 2;
      } else if (sql.startsWith("*/", cursor)) {
        depth -= 1;
        cursor += 2;
      } else {
        cursor += 1;
      }
    }
    return cursor;
  };
  // Same literal rule as scripts/lib/sql-text.mjs: '' is an escaped quote,
  // and only a real E'...' / e'...' prefix treats a backslash as an escape.
  const literalEnd = (start) => {
    const escapeBackslashes = (sql[start - 1] === "e" || sql[start - 1] === "E")
      && (start < 2 || !/[A-Za-z0-9_$]/.test(sql[start - 2]));
    let end = start + 1;
    while (end < sql.length) {
      if (escapeBackslashes && sql[end] === "\\") {
        end = Math.min(end + 2, sql.length);
        continue;
      }
      if (sql[end] === "'") {
        if (sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        return end + 1;
      }
      end += 1;
    }
    return end;
  };
  // A dollar tag starts only when `$` is not continuing an identifier.
  // PostgreSQL ends the body at the next copy of that same tag; an unclosed
  // tag is left in place so a later COMMIT stays visible.
  const dollarTag = (start) => {
    if (sql[start] !== "$") return null;
    if (start > 0 && /[A-Za-z0-9_$]/.test(sql[start - 1])) return null;
    let end = start + 1;
    if (sql[end] === "$") return "$$";
    if (!/[A-Za-z_]/.test(sql[end] || "")) return null;
    end += 1;
    while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
    if (sql[end] !== "$") return null;
    return sql.slice(start, end + 1);
  };

  let out = "";
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(i);
    if (comment !== -1) {
      out += " ";
      i = comment;
      continue;
    }
    if (sql[i] === "'") {
      out += " ";
      i = literalEnd(i);
      continue;
    }
    const tag = dollarTag(i);
    if (tag) {
      const closeAt = sql.indexOf(tag, i + tag.length);
      if (closeAt !== -1) {
        out += " ";
        i = closeAt + tag.length;
        continue;
      }
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

export function assertNoCommit(sql) {
  const visible = maskExecutableSql(sql);
  if (/(?:^|;)\s*(?:commit|end)\b/i.test(visible) || /\bprepare\s+transaction\b/i.test(visible)) {
    throw new Error(`this proof may never commit: refused ${sql.slice(0, 40)}`);
  }
}

// A refused statement aborts the transaction, so each probe gets its own
// savepoint. Sharing one would silently undo every fixture written after it,
// which is how a proof turns green by erasing what it was proving. The
// savepoint is rolled back on every error, including a SQLSTATE that is not
// the refusal this probe named.
//
// expectedState is the SQLSTATE string, or { code, message } when that
// SQLSTATE is also what a missing EXECUTE grant or a table-privilege denial
// raises (42501). The message then has to be the exception text from the
// function or trigger that owns the boundary.
export function makeDenied({ run, check }) {
  return async function denied(label, expectedState, sql, params) {
    const expected = denialExpectation(expectedState);
    await run("savepoint probe");
    try {
      await run(sql, params);
      await run("release savepoint probe");
      check(label, false, "the statement succeeded");
      return null;
    } catch (error) {
      await run("rollback to savepoint probe");
      await run("release savepoint probe");
      const actualCode = error?.code;
      const codeOk = actualCode === expected.code;
      const messageOk = expected.message == null
        || String(error?.message ?? "").includes(expected.message);
      if (!codeOk) {
        check(label, false, `expected SQLSTATE ${expected.code}, got ${actualCode || "none"}`);
      } else if (!messageOk) {
        check(
          label,
          false,
          `expected SQLSTATE ${expected.code} mentioning ${JSON.stringify(expected.message)}, got ${JSON.stringify(error?.message)}`,
        );
      } else {
        check(label, true);
      }
      return error?.message ?? null;
    }
  };
}

function denialExpectation(expectedState) {
  if (typeof expectedState === "string" && expectedState.length > 0) {
    return { code: expectedState, message: undefined };
  }
  if (expectedState && typeof expectedState.code === "string" && expectedState.code.length > 0) {
    const message = expectedState.message == null ? undefined : String(expectedState.message);
    return { code: expectedState.code, message };
  }
  throw new Error("denied() requires an expected SQLSTATE");
}

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DB_BOUNDARY_DB_URL;
  if (!connectionString) {
    if (requireDbVerify()) {
      console.error("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1.");
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error("FAIL: SUPABASE_DB_URL not set on a GitHub Actions runner — the two-organization boundary proof must run live in CI, never skip green.");
      process.exit(1);
    }
    console.log("SKIP: SUPABASE_DB_URL not set — the two-organization boundary was not proven live.");
    process.exit(0);
  }
  assertSafeTarget(connectionString);

  const client = new pg.Client({ connectionString, application_name: "verify-db-boundary-tenancy" });
  await client.connect();

  const run = async (sql, params) => {
    assertNoCommit(sql);
    return client.query(sql, params);
  };

  // Read as one signed-in browser session. `set local` keeps both settings
  // inside the transaction, and `authenticated` is not the table owner, so RLS
  // is evaluated exactly as it is for a real request.
  // private.mfa_satisfied() only honours a session_id that names a live
  // auth.sessions row of the caller, so each read gets its own session.
  const asMember = async (userId, aal) => {
    await run("reset role");
    await run("select set_config('request.jwt.claims', '', true)");
    const sessionId = (await run(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       values (extensions.gen_random_uuid(), $1, now(), now(), $2) returning id as value`,
      [userId, aal],
    )).rows[0].value;
    await run("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal, session_id: sessionId }),
    ]);
    await run("set local role authenticated");
  };
  const asOwner = async () => {
    await run("reset role");
    await run("select set_config('request.jwt.claims', '', true)");
  };
  const scalar = async (sql, params) => (await run(sql, params)).rows[0]?.value ?? null;
  const denied = makeDenied({ run, check });

  try {
    await run("begin");
    await run("set local lock_timeout = '5s'");
    await run("set local statement_timeout = '60s'");

    // The proof never applies a migration itself. Replaying 20260826140000
    // here failed on a stack migrated to Main ("function already exists") and,
    // on an older stack, re-created chapter_records_read_contacts and the
    // broadcast read policy that 20260830060000 and 20260909080000 replaced,
    // so it asserted a retired policy set. It now runs only against a stack
    // whose recorded migrations match this checkout's supabase/migrations,
    // and asserts the shipped read policies by name.
    const drift = migrationDigestDrift(localMigrations(), (await run(
      `select version, array_to_string(statements, E'\\n') as sql
         from supabase_migrations.schema_migrations order by version`,
    )).rows);
    if (drift.length > 0) {
      throw new Error(`refusing a stack whose migration digest differs from supabase/migrations (${drift.length} version(s): ${drift.slice(0, 5).join("; ")}). Migrate the stack to this checkout first.`);
    }
    check("the stack's recorded migrations match supabase/migrations", true);

    const readPolicies = async (table) => (await run(
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = $1 and cmd in ('SELECT', 'ALL')
          and permissive = 'PERMISSIVE'
        order by policyname`,
      [table],
    )).rows.map((row) => row.policyname).join(",");
    // One policy combines member/staff and scoped officer reads. Restrictive
    // tenant and access-scope policies still apply to every branch.
    eq("chapter_records uses one combined member/staff and scoped officer read policy",
      "chapter_records_select", await readPolicies("chapter_records"));
    eq("member_broadcasts is read through member_broadcasts_read_authenticated only",
      "member_broadcasts_read_authenticated", await readPolicies("member_broadcasts"));

    // ------------------------------------------------------------- fixtures
    const ids = (await run(`
      select extensions.gen_random_uuid() as org_a,
             extensions.gen_random_uuid() as org_b
    `)).rows[0];
    const orgA = ids.org_a;
    const orgB = ids.org_b;

    await run(
      `insert into public.organizations (id, slug, name, status) values
         ($1, 'proof-alpha-tenant', 'Proof Alpha Tenant', 'active'),
         ($2, 'proof-beta-tenant', 'Proof Beta Tenant', 'active')`,
      [orgA, orgB],
    );
    await run(
      `insert into public.org_security_policy (organization_id, require_staff_mfa)
       values ($1, true), ($2, true)`,
      [orgA, orgB],
    );
    // The quarantined legacy singleton governs orphan sessions. Pinned to the
    // fail-closed value the resolver already defaults to, so the orphan
    // assertions below are about the policy and not about local drift.
    await run("update public.org_security_policy set require_staff_mfa = true where organization_id is null");

    // Colliding chapter NAMES and SLUGS across the two tenants. If any part of
    // the boundary keyed off a chapter name, this is where it would break.
    const base = (await run("select coalesce(max(order_index), 0) + 9000 as value from public.chapters")).rows[0].value;
    await run(
      `insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug) values
         ('proof-a-harbor', 'Harbor', 'Proof East', false, $3, $1, 'harbor'),
         ('proof-a-ridge',  'Ridge',  'Proof East', false, $4, $1, 'ridge'),
         ('proof-b-harbor', 'Harbor', 'Proof West', false, $5, $2, 'harbor')`,
      [orgA, orgB, base + 1, base + 2, base + 3],
    );
    check("two organizations may reuse a chapter name and slug", true);

    // Quarantined pre-MI1 chapters. New ownerless chapter writes are refused
    // by 20260822010000's trigger, so the legacy shape — which is what every
    // row in the seeded SAMPLE database still looks like — is reproduced with
    // transaction-local replication-role suppression.
    await run("set local session_replication_role = 'replica'");
    await run(
      `insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug) values
         ('proof-orphan-harbor', 'Proof Orphan Harbor', 'Legacy', false, $1, null, 'proof-orphan-harbor'),
         ('proof-orphan-ridge',  'Proof Orphan Ridge',  'Legacy', false, $2, null, 'proof-orphan-ridge')`,
      [base + 4, base + 5],
    );
    await run("set local session_replication_role = 'origin'");

    const makeUser = async (label) => {
      const row = (await run(
        `insert into auth.users (id, email, raw_user_meta_data)
         values (extensions.gen_random_uuid(), $1, jsonb_build_object('first_name', $2::text, 'full_name', $2::text, 'initials', 'PX'))
         returning id as value`,
        [`${label}@proof.invalid`, label],
      )).rows[0];
      return row.value;
    };

    const place = async (userId, chapterId, organizationId) => {
      await run("update public.member_profiles set chapter_id = $2 where id = $1", [userId, chapterId]);
      await run(
        `insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
         values ($1, $2, 'active', now())
         on conflict (user_id, chapter_id) do update set status = 'active', last_selected_at = now()`,
        [userId, chapterId],
      );
      if (organizationId) {
        await run(
          `insert into public.organization_memberships (organization_id, user_id, status)
           values ($1, $2, 'active') on conflict (organization_id, user_id) do nothing`,
          [organizationId, userId],
        );
      }
    };

    const chapterRole = async (userId, chapterId, role) => {
      await run(
        `insert into public.member_roles (user_id, role, chapter_id) values ($1, $3, $2)
         on conflict (user_id, role) do update set chapter_id = excluded.chapter_id`,
        [userId, chapterId, role],
      );
      await run(
        `insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $3, $2)
         on conflict do nothing`,
        [userId, chapterId, role],
      );
    };

    const enrol = async (userId) => {
      await run(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
         values (extensions.gen_random_uuid(), $1, 'proof', 'totp', 'verified', now(), now(), 'PROOFSECRET')`,
        [userId],
      );
    };

    const aMember = await makeUser("proof-a-member");
    const aRidgeMember = await makeUser("proof-a-ridge-member");
    const aSteward = await makeUser("proof-a-steward");
    const aLead = await makeUser("proof-a-lead");
    const aStewardNoMfa = await makeUser("proof-a-steward-nomfa");
    const bMember = await makeUser("proof-b-member");
    const bSteward = await makeUser("proof-b-steward");
    const orphanSteward = await makeUser("proof-orphan-steward");
    const orphanWideHat = await makeUser("proof-orphan-wide-hat");

    await place(aMember, "proof-a-harbor", orgA);
    await place(aRidgeMember, "proof-a-ridge", orgA);
    await place(aSteward, "proof-a-harbor", orgA);
    await place(aLead, "proof-a-harbor", orgA);
    await place(aStewardNoMfa, "proof-a-harbor", orgA);
    await place(bMember, "proof-b-harbor", orgB);
    await place(bSteward, "proof-b-harbor", orgB);
    await place(orphanSteward, "proof-orphan-harbor", null);
    await place(orphanWideHat, "proof-orphan-ridge", null);

    await chapterRole(aSteward, "proof-a-harbor", "steward");
    await chapterRole(aLead, "proof-a-harbor", "vp");
    await chapterRole(aStewardNoMfa, "proof-a-harbor", "steward");
    await chapterRole(bSteward, "proof-b-harbor", "steward");
    await chapterRole(orphanSteward, "proof-orphan-harbor", "steward");

    await enrol(aSteward);
    await enrol(aLead);
    await enrol(bSteward);
    await enrol(orphanWideHat);

    // The legacy tenant-wide hat this migration stops honouring for contact
    // records. `member_roles.chapter_id IS NULL` is blocked for new writes by
    // 20260822010000's trigger, so the pre-MI1 shape is reproduced with
    // replication-role suppression — transaction-local, rolled back, and the
    // only way to fixture history that the current schema refuses to mint.
    await run("set local session_replication_role = 'replica'");
    await run(
      "insert into public.member_roles (user_id, role, chapter_id) values ($1, 'steward', null)",
      [orphanWideHat],
    );
    await run("set local session_replication_role = 'origin'");

    // chapter_records.chapter_id and created_by are server-stamped from the
    // writing session by private.stamp_product_identity, and the orphan
    // chapters cannot be written through the staff INSERT policy at all. The
    // fixture is therefore written directly, with the stamping trigger
    // suppressed, because these two records are about READ boundaries: the
    // rows must exist exactly as authored, whoever authored them.
    const seedRecords = async (chapterId, author) => {
      await run(
        `insert into public.chapter_records (chapter_id, record_type, title, body, occurred_at, created_by, published_at) values
           ($1::text, 'minutes', 'Proof minutes', 'Governance body', now(), $2::uuid, now()),
           ($1::text, 'member_contact', 'Proof member contact', 'Grievance-adjacent PII', now(), $2::uuid, now()),
           ($1::text, 'management_contact', 'Proof management contact', 'Grievance-adjacent PII', now(), $2::uuid, now())`,
        [chapterId, author],
      );
    };
    await run("set local session_replication_role = 'replica'");
    await seedRecords("proof-a-harbor", aSteward);
    await seedRecords("proof-a-ridge", aSteward);
    await seedRecords("proof-b-harbor", bSteward);
    await seedRecords("proof-orphan-harbor", orphanSteward);
    await run("set local session_replication_role = 'origin'");

    // Upstream decision of November 10, 2026: retain the historical broad read controls.
    await migrateLegacyStewardFixtures(client);

    // ------------------------------------------- chapter-record publication
    const countRecords = async (types, chapterId) => Number(await scalar(
      `select count(*)::int as value from public.chapter_records
        where record_type = any($1::text[]) and ($2::text is null or chapter_id = $2)`,
      [types, chapterId ?? null],
    ));
    const CONTACTS = ["member_contact", "management_contact"];
    const GOVERNANCE = ["minutes", "decision", "milestone"];

    await asMember(aMember, "aal1");
    eq("ordinary member reads chapter governance records", 1, await countRecords(GOVERNANCE, null));
    eq("ordinary member reads ZERO contact records", 0, await countRecords(CONTACTS, null));

    await asMember(aSteward, "aal2");
    eq("MFA staff read their own chapter's contact records", 2, await countRecords(CONTACTS, "proof-a-harbor"));
    eq("a chapter-scoped staff hat reads ZERO contact records in a sibling chapter", 0,
      await countRecords(CONTACTS, "proof-a-ridge"));
    eq("MFA staff read ZERO foreign-organization contact records", 0, await countRecords(CONTACTS, "proof-b-harbor"));
    eq("MFA staff read ZERO foreign-organization records at all", 0,
      Number(await scalar("select count(*)::int as value from public.chapter_records where chapter_id = 'proof-b-harbor'")));

    await asMember(bSteward, "aal2");
    eq("the second organization's staff read their own contact records", 2, await countRecords(CONTACTS, "proof-b-harbor"));
    eq("the second organization's staff read ZERO of the first's", 0, await countRecords(CONTACTS, "proof-a-harbor"));

    await asMember(aStewardNoMfa, "aal1");
    eq("staff without a second factor read ZERO contact records", 0, await countRecords(CONTACTS, null));

    // The orphan branch this migration rewrote. Before it, both of these read
    // the contact rows: the first because the orphan path never consulted the
    // staff-MFA policy, the second because a tenant-wide legacy hat was
    // accepted as authority over every orphan chapter.
    await asMember(orphanSteward, "aal1");
    eq("orphan-chapter staff without a second factor read ZERO contact records", 0,
      await countRecords(CONTACTS, "proof-orphan-harbor"));
    eq("orphan-chapter staff still read their chapter's governance records", 1,
      await countRecords(GOVERNANCE, "proof-orphan-harbor"));

    await asMember(orphanWideHat, "aal2");
    eq("a legacy tenant-wide hat reads ZERO contact records in a chapter it is not a member of", 0,
      await countRecords(CONTACTS, "proof-orphan-harbor"));

    // Positive control: the same orphan staffer, once enrolled, does read them.
    await asOwner();
    await enrol(orphanSteward);
    await asMember(orphanSteward, "aal2");
    eq("orphan-chapter staff WITH a second factor read their contact records", 2,
      await countRecords(CONTACTS, "proof-orphan-harbor"));

    // Fail-closed publication rule: an unlisted record type is published to
    // nobody, which is what keeps a sixth type from shipping readable.
    await asOwner();
    eq("an unlisted record type resolves to denied", "denied",
      await scalar("select private.chapter_record_publication('grievance_note') as value"));
    eq("member_contact resolves to chapter_staff", "chapter_staff",
      await scalar("select private.chapter_record_publication('member_contact') as value"));

    // ------------------------------------------------- broadcast boundaries
    // REQ-UG-STEWARD-NOTICES-LIMITED-TO-UNIT-20261109 (#7664): a
    // steward sends notices to its own unit; the chapter lead and
    // organization leadership publish chapter- and organization-wide.
    await asMember(aSteward, "aal2");
    await denied(
      "a steward cannot publish a chapter-wide broadcast",
      { code: "42501", message: "chapter steward role required" },
      "select public.publish_member_broadcast('Proof chapter denied', 'Denied', 'en', 'chapter')",
    );
    await asMember(aLead, "aal2");
    const chapterBroadcast = (await scalar(
      "select public.publish_member_broadcast('Proof chapter broadcast', 'Chapter body', 'en', 'chapter') as value",
    )).broadcastId;
    check("a chapter lead publishes a chapter-audience broadcast", Boolean(chapterBroadcast));
    await asMember(aSteward, "aal2");

    // publish_member_broadcast raises 42501 with this text when the caller
    // has no organization-wide steward hat. The same SQLSTATE is also a
    // missing EXECUTE grant, so the message has to match.
    await denied(
      "a chapter steward cannot publish an organization audience without an org-wide hat",
      { code: "42501", message: "organization-wide steward role required" },
      "select public.publish_member_broadcast('Proof org denied', 'Denied', 'en', 'organization')",
    );

    await asOwner();
    await run(
      `insert into public.organization_role_grants (organization_id, user_id, role)
       values ($1, $2, 'steward')`,
      [orgA, aSteward],
    );
    // Upstream decision of November 10, 2026: this is a historical organization grant,
    // not a new runtime grant without its required per-chapter assignments.
    // Replay the actual backfill after adding it, without making memberships.
    await migrateLegacyStewardFixtures(client);

    // The org-wide hat is a DOCUMENTED widening for contact records: a tenant
    // officer reads their organization's chapters, and only their own.
    await asMember(aSteward, "aal2");
    eq("an organization-wide staff hat reads a sibling chapter's contact records in its OWN organization", 2,
      await countRecords(CONTACTS, "proof-a-ridge"));
    eq("an organization-wide staff hat still reads ZERO of the other organization's", 0,
      await countRecords(CONTACTS, "proof-b-harbor"));

    await denied(
      "an organization steward grant does not publish to the whole organization",
      { code: "42501", message: "organization-wide steward role required" },
      "select public.publish_member_broadcast('Proof org steward denied', 'Denied', 'en', 'organization')",
    );
    await asOwner();
    await run(
      `insert into public.organization_role_grants (organization_id, user_id, role)
       values ($1, $2, 'vp')`,
      [orgA, aLead],
    );
    await asMember(aLead, "aal2");
    const orgBroadcast = (await scalar(
      "select public.publish_member_broadcast('Proof org broadcast', 'Organization body', 'en', 'organization') as value",
    )).broadcastId;
    check("organization leadership publishes an organization-audience broadcast", Boolean(orgBroadcast));

    const canRead = async (id) => Number(await scalar(
      "select count(*)::int as value from public.member_broadcasts where id = $1", [id],
    ));

    await asMember(aMember, "aal1");
    eq("a same-chapter member reads the chapter broadcast", 1, await canRead(chapterBroadcast));
    eq("a same-chapter member reads the organization broadcast", 1, await canRead(orgBroadcast));

    await asMember(aRidgeMember, "aal1");
    eq("a different chapter in the SAME organization cannot read a chapter broadcast", 0, await canRead(chapterBroadcast));
    eq("a different chapter in the SAME organization CAN read an organization broadcast", 1, await canRead(orgBroadcast));

    await asMember(bMember, "aal1");
    eq("the second organization cannot read the first's chapter broadcast", 0, await canRead(chapterBroadcast));
    eq("organization-wide is NOT global: the second organization cannot read it", 0, await canRead(orgBroadcast));

    await asMember(bSteward, "aal2");
    eq("cross-organization read counts return nothing", "[]", JSON.stringify(await scalar(
      "select public.get_broadcast_read_counts_for($1::text[]) as value", [[chapterBroadcast, orgBroadcast]],
    )));
    eq("the second organization's desk pager shows none of the first's broadcasts", 0,
      Number(await scalar("select count(*)::int as value from public.list_steward_broadcasts('all', null, null, null, 20)")));
    eq("the second organization's 30-day broadcast KPI is zero", 0,
      Number(await scalar("select broadcasts_30d::int as value from public.get_steward_desk_kpis()")));
    // create_chapter_task_from_source raises 22023 source unavailable when
    // the broadcast's organization is not the caller's.
    await denied(
      "cross-organization task derivation from a broadcast is refused",
      { code: "22023", message: "source unavailable" },
      "select public.create_chapter_task_from_source('broadcast', $1)",
      [chapterBroadcast],
    );

    await asMember(aSteward, "aal2");
    const page = await run("select id, audience_scope, chapter_id, total_count from public.list_steward_broadcasts('all', null, null, null, 20)");
    eq("the publishing organization's desk pager shows exactly its own two broadcasts", 2, page.rowCount);
    check("the desk pager returns an explicit audience for every row",
      page.rows.every((row) => row.audience_scope === "chapter" || row.audience_scope === "organization"),
      JSON.stringify(page.rows.map((row) => row.audience_scope)));
    check("the desk pager's total_count is tenant-bounded",
      page.rows.every((row) => Number(row.total_count) === 2),
      JSON.stringify(page.rows.map((row) => row.total_count)));

    // Retraction is an UPDATE, so it now passes through the audience and
    // chapter immutability clauses on every row it touches. A guard that
    // cannot tell "retract this" from "republish this wider" would take the
    // publisher's only takeback with it, so it is proven working, not assumed.
    await asMember(aLead, "aal2");
    const retractable = (await scalar(
      "select public.publish_member_broadcast('Proof retract', 'Retract body', 'en', 'chapter') as value",
    )).broadcastId;
    const retracted = await scalar("select public.retract_member_broadcast($1) as value", [retractable]);
    check("retracting a broadcast still works with the audience pinned",
      retracted?.retracted === true, JSON.stringify(retracted));
    // retract_member_broadcast raises 22023 once retracted_at is already set.
    await denied(
      "a retracted broadcast cannot be retracted twice",
      { code: "22023", message: "broadcast not found, not yours, or already retracted" },
      "select public.retract_member_broadcast($1)",
      [retractable],
    );

    // Audience immutability. Attempted as the table owner, which no RLS policy
    // constrains, so this proves the trigger and not a policy.
    await asOwner();
    // private.forbid_ownerless_broadcast_write raises 42501 with the text
    // below. A table-privilege denial uses the same SQLSTATE.
    await denied(
      "a published broadcast's audience cannot be widened afterwards",
      { code: "42501", message: "broadcast audience is immutable" },
      "update public.member_broadcasts set audience_scope = 'organization' where id = $1",
      [chapterBroadcast],
    );
    await denied(
      "a published broadcast cannot be moved to another chapter",
      { code: "42501", message: "broadcast chapter is immutable" },
      "update public.member_broadcasts set chapter_id = 'proof-a-ridge' where id = $1",
      [chapterBroadcast],
    );
    await denied(
      "an ownerless broadcast insert is still refused",
      { code: "42501", message: "ownerless broadcast writes are prohibited" },
      `insert into public.member_broadcasts (id, sender, title, body, published_at, order_index)
       values ('proof-ownerless', 'Chapter steward', 'Nope', 'Nope', now(), $1)`,
      [-999999],
    );
  } finally {
    // The only terminating statement in this file.
    await client.query("rollback").catch(() => {});
    const left = await client
      // Only this proof's own tenants: the required DB lane shares its schema
      // with suites that commit their own fixtures.
      .query("select count(*)::int as value from public.organizations where slug in ('proof-alpha-tenant', 'proof-beta-tenant')")
      .catch(() => ({ rows: [{ value: -1 }] }));
    if (left.rows[0].value !== 0) {
      failures.push(`fixture residue: ${left.rows[0].value} proof organizations survived the rollback`);
    } else {
      checks += 1;
    }
    await client.end().catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} of ${checks} boundary checks failed:\n`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`PASS: ${checks} two-organization boundary checks, with every fixture rolled back.`);
}

// Only run when invoked directly, so the offline suite can import
// migrationDigestDrift without main() exiting the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
