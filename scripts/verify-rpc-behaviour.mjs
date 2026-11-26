#!/usr/bin/env node
// Live behavioural probes for the definer-RPC surface: what the guards and the
// points economy actually DO, observed against the real database — the half
// that neither text pins nor the catalog contract can see.
// REQ-UG-RPC-INTEGRATION-TESTS-20260725.
//
// Probes (all inside ONE transaction that ALWAYS rolls back; per-probe
// savepoints so one crash cannot poison the rest — the discipline of
// scripts/verify-notification-schema.sql, mechanised):
//   1. aal1 + enrolled verified TOTP  -> guarded RPC refuses with 42501
//   2. aal2                           -> guard passes (error, if any, is not 42501)
//   3. aal1 with NO factor            -> guard passes (NON-LOCKOUT invariant)
//   4. no JWT claims at all           -> refused with 42501 (null caller)
//   5. weekly cap exhausted           -> a backed mint writes ZERO point events
//   6. weekly cap not exhausted       -> the same mint pays (positive control)
//   7. cross-ballot option            -> submit_ballot_vote refuses with 22023
//                                        'invalid option for this ballot'
//   8. valid option                   -> submit_ballot_vote succeeds end-to-end
//                                        under the unlinkable-storage shape
//                                        (20260808230000): receiptCode returned,
//                                        exactly ONE anonymous choice row, ZERO
//                                        user-linked vote rows, points minted
//   9. repeat vote, same (ballot,     -> refused with 22023 'your vote is
//      member)                           already recorded' — votes are FINAL
//  10. task hard purge               -> the next visible task number increases
//  11. Compass chapter-library search -> authenticated member/staff callers see
//                                        only published documents in their own
//                                        chapter and visibility tier
//  12. Intake onward path            -> same-chapter owner triage and each
//                                        one-shot case/task/thread conversion
//                                        succeed; member/foreign callers,
//                                        direct writes and target switching
//                                        are refused without mutation
//  13. Authorized source conversion  -> all five exact source kinds create
//                                        privacy-quiet, audited Standard Tasks;
//                                        a same-chapter foreign owner succeeds,
//                                        retries converge, and member/foreign-
//                                        staff refusals mutate nothing
//  14. Member invitations            -> admin+MFA and chapter boundaries,
//                                        anti-enumerating duplicates, resend /
//                                        revoke, expiry, exact-user finalize,
//                                        replay refusal, persisted throttles,
//                                        audit privacy, and rollback residue
//  15. Sign-in address recovery       -> admin+MFA and same-chapter boundaries,
//                                        private digest-only serialization,
//                                        exact Auth state, mandatory logout,
//                                        closed audit detail, persisted rates,
//                                        and rollback residue
//  16. Member device sessions         -> self+MFA coarse inventory, selected
//                                        vendor-session revoke, exact replay,
//                                        stale-token/CAS refusal, exact native
//                                        deletion, refresh cascade, durable
//                                        local/global registration barriers,
//                                        MFA-recovery global barriers, and
//                                        web/native push teardown
//  17. Workload intelligence          -> MFA + chapter boundaries, K=25
//                                        distribution/trend cohorts, bounded
//                                        counts-only balancing, serialized
//                                        reminder schedules and atomic generic
//                                        receipt/reminder delivery metadata
//
// Semantics identical to verify-db-contract.mjs:
//   - SUPABASE_DB_URL unset -> SKIP, exit 0 (::warning under GitHub Actions;
//     REQUIRE_DB_VERIFY arms the skip into a hard failure).
//   - set, all probes agree -> PASS, exit 0.
//   - set, anything disagrees or the connection fails -> exit 1. A connection
//     error is a HARD FAIL, never a skip.
//
// ROLLBACK is not cleanup here; it is the reason these probes are safe to run
// against production at all. A residue check runs AFTER the rollback on a
// fresh implicit transaction and hard-fails if any probe artifact survived.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertExactTarget, isLoopbackPostgresUrl, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";
import { requireDbVerify } from "./lib/require-db-verify.mjs";

const contract = JSON.parse(readFileSync(fileURLToPath(new URL("./db-contract.json", import.meta.url)), "utf8"));

const failures = [];
let checks = 0;
function check(name, ok, expected, observed) {
  checks += 1;
  if (!ok) failures.push({ name, expected, observed });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok ? "" : ` — expected ${expected}, observed ${observed}`}`);
}

// Assigned by runCli() once the target guard has passed; callAs() and main()
// read it.
let client;
let localTarget = false;
const q = (text, values) => client.query(text, values).then((r) => r.rows);

async function addProbeTotp(userId, label) {
  await client.query(
    `insert into auth.mfa_factors
       (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (extensions.gen_random_uuid(), $1, $2, 'totp', 'verified', now(), now())`,
    [userId, `probe-${label}-totp`],
  );
}

// Call an RPC as a synthetic PostgREST session and report the SQLSTATE it
// raises ('' when it succeeds). Wrapped in its own savepoint so an error does
// not abort the outer transaction, and so `set local role` + the claims GUC
// unwind with the savepoint.
async function callAs(claims, sql, params) {
  await client.query("savepoint probe");
  try {
    if (claims !== null) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    }
    await client.query("set local role authenticated");
    const rows = (await client.query(sql, params)).rows;
    await client.query("rollback to savepoint probe");
    return { code: "", rows };
  } catch (error) {
    await client.query("rollback to savepoint probe");
    return { code: error.code ?? "?", message: error.message ?? "" };
  }
}

// callAs keeps nothing: it unwinds its savepoint even on success, which is
// right for pure refusal probes but wrong for probe 8 — the anonymous-storage
// shape can only be observed if the vote's writes survive into the outer
// transaction (they still vanish at the final rollback, like probe 10's task
// rows, and the residue sweep proves it). On success the savepoint is
// RELEASED and the role reset; on error it unwinds exactly like callAs.
async function callAsKeeping(claims, sql, params) {
  await client.query("savepoint probe");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("set local role authenticated");
    const rows = (await client.query(sql, params)).rows;
    await client.query("release savepoint probe");
    await client.query("reset role");
    return { code: "", rows };
  } catch (error) {
    await client.query("rollback to savepoint probe");
    return { code: error.code ?? "?", message: error.message ?? "" };
  }
}

// Authenticated RPC whose side effects must be observed on tables that are
// revoked from authenticated, anon AND service_role alike, which leaves the
// session owner as the only observer this script can reach (has_table_privilege
// is false for all three roles on every one of the three tables).
// The RPC runs under `set local role authenticated`; RESET ROLE returns to the
// session owner for the observation query; the savepoint then unwinds so later
// probes still see the pre-RPC state. BUG-UG-RPC-PROBE-ADMIN-RESET-UNPRIVILEGED-READ-20260917.
async function callAsThenObserve(claims, sql, params, observeSql, observeParams) {
  await client.query("savepoint probe");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("set local role authenticated");
    const rows = (await client.query(sql, params)).rows;
    await client.query("reset role");
    const observed = (await client.query(observeSql, observeParams)).rows;
    await client.query("rollback to savepoint probe");
    return { code: "", rows, observed };
  } catch (error) {
    await client.query("rollback to savepoint probe");
    return { code: error.code ?? "?", message: error.message ?? "" };
  }
}

// Acceptance helpers are deliberately service-role-only and also inspect the
// role claim themselves. Exercise both halves of that boundary while keeping
// writes in the rollback-only outer transaction.
async function callServiceKeeping(sql, params) {
  await client.query("savepoint probe");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
    const rows = (await client.query(sql, params)).rows;
    await client.query("release savepoint probe");
    await client.query("reset role");
    return { code: "", rows };
  } catch (error) {
    await client.query("rollback to savepoint probe");
    return { code: error.code ?? "?", message: error.message ?? "" };
  }
}

async function callOwner(sql, params) {
  await client.query("savepoint probe");
  try {
    const rows = (await client.query(sql, params)).rows;
    await client.query("rollback to savepoint probe");
    return { code: "", rows };
  } catch (error) {
    await client.query("rollback to savepoint probe");
    return { code: error.code ?? "?", message: error.message ?? "" };
  }
}

async function main() {
  await client.connect();
  await client.query("begin");

  // A pending migration may be exercised only against the local exact-target
  // alias. It runs inside this same outer transaction, so the schema and every
  // fixture below disappear together. Deployed/CI verification never sets it.
  const pendingMigration = (process.env.VERIFY_RPC_PENDING_MIGRATION ?? "").trim();
  if (pendingMigration) {
    if (!/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(pendingMigration)) {
      throw new Error("VERIFY_RPC_PENDING_MIGRATION must be one migration basename");
    }
    const migrationUrl = new URL(`../supabase/migrations/${pendingMigration}`, import.meta.url);
    await client.query(readFileSync(fileURLToPath(migrationUrl), "utf8"));
  }

  // Self-contained staff/chapter fixtures. Fresh local databases may contain
  // only ordinary members, while live data is not a stable test dependency.
  // These auth rows exercise the real new-member trigger, live entirely in
  // this outer transaction, and are included in the post-rollback residue
  // sweep. Fixed ids/emails also turn any prior leaked run into a hard setup
  // failure instead of silently selecting the residue.
  const syntheticUsers = {
    staff: "00000000-0000-4000-8000-000000000101",
    owner: "00000000-0000-4000-8000-000000000102",
    foreignStaff: "00000000-0000-4000-8000-000000000103",
    foreignMember: "00000000-0000-4000-8000-000000000104",
    invited: "00000000-0000-4000-8000-000000000105",
  };
  const syntheticSessions = {
    staffCurrent: "00000000-0000-4100-8000-000000000201",
    ownerCurrent: "00000000-0000-4100-8000-000000000202",
    ownerRemote: "00000000-0000-4100-8000-000000000203",
    ownerExpired: "00000000-0000-4100-8000-000000000204",
    foreignCurrent: "00000000-0000-4100-8000-000000000205",
    foreignRemote: "00000000-0000-4100-8000-000000000206",
    ownerAfterLocal: "00000000-0000-4100-8000-000000000207",
    foreignAfterRecovery: "00000000-0000-4100-8000-000000000208",
  };
  await client.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       is_sso_user, is_anonymous
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
        'rpc-probe-staff@example.test', '', now(), '', '', '', '',
        '{"provider":"email","providers":["email"]}',
        '{"first_name":"Probe","full_name":"Probe Staff","initials":"PS","chapter_id":"wor"}',
        now(), now(), false, false),
       ('00000000-0000-0000-0000-000000000000', $2, 'authenticated', 'authenticated',
        'rpc-probe-owner@example.test', '', now(), '', '', '', '',
        '{"provider":"email","providers":["email"]}',
        '{"first_name":"Probe","full_name":"Probe Owner","initials":"PO","chapter_id":"wor"}',
        now(), now(), false, false),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated',
        'rpc-probe-foreign-staff@example.test', '', now(), '', '', '', '',
        '{"provider":"email","providers":["email"]}',
        '{"first_name":"Probe","full_name":"Probe Foreign Staff","initials":"PF","chapter_id":"bos"}',
        now(), now(), false, false),
       ('00000000-0000-0000-0000-000000000000', $4, 'authenticated', 'authenticated',
        'rpc-probe-foreign-member@example.test', '', now(), '', '', '', '',
        '{"provider":"email","providers":["email"]}',
        '{"first_name":"Probe","full_name":"Probe Foreign Member","initials":"PM","chapter_id":"bos"}',
        now(), now(), false, false)`,
    [syntheticUsers.staff, syntheticUsers.owner, syntheticUsers.foreignStaff, syntheticUsers.foreignMember],
  );
  await client.query(
    `insert into public.member_roles (user_id, role, chapter_id) values
       ($1, 'steward', 'wor'),
       ($1, 'coordinator', 'wor'),
       ($1, 'admin', 'wor'),
       ($2, 'coordinator', 'bos'),
       ($2, 'admin', 'bos')`,
    [syntheticUsers.staff, syntheticUsers.foreignStaff],
  );
  // member_has_role's ownerless-chapter path requires the chapter-mapped grant,
  // not only member_roles. Without this, begin_mfa_reset raises 42501
  // 'admin role required' and the reconciliation probe cannot run.
  await client.query(
    `insert into public.member_role_chapters (user_id, role, chapter_id) values
       ($1, 'steward', 'wor'),
       ($1, 'coordinator', 'wor'),
       ($1, 'admin', 'wor'),
       ($2, 'coordinator', 'bos'),
       ($2, 'admin', 'bos')`,
    [syntheticUsers.staff, syntheticUsers.foreignStaff],
  );
  await client.query(
    `insert into auth.sessions
       (id, user_id, created_at, updated_at, aal, not_after, refreshed_at, user_agent, ip)
     values
       ($1, $7, now() - interval '1 day', now(), 'aal2', now() + interval '6 days', now() at time zone 'UTC', 'Mozilla/5.0 Windows Chrome/140.0', '192.0.2.10'),
       ($2, $8, now() - interval '1 day', now(), 'aal1', now() + interval '6 days', now() at time zone 'UTC', 'Mozilla/5.0 Macintosh Safari/18.0', '192.0.2.11'),
       ($3, $8, now() - interval '2 days', now() - interval '1 hour', 'aal1', now() + interval '5 days', (now() - interval '1 hour') at time zone 'UTC', 'Mozilla/5.0 Android Chrome/140.0', '192.0.2.12'),
       ($4, $8, now() - interval '9 days', now() - interval '9 hours', 'aal1', now() - interval '2 days', (now() - interval '9 hours') at time zone 'UTC', 'Mozilla/5.0 Linux Firefox/140.0', '192.0.2.13'),
       ($5, $9, now() - interval '1 day', now(), 'aal1', now() + interval '6 days', now() at time zone 'UTC', 'Mozilla/5.0 iPhone Safari/18.0', '192.0.2.14'),
       ($6, $9, now() - interval '2 days', now() - interval '1 hour', 'aal1', now() + interval '5 days', (now() - interval '1 hour') at time zone 'UTC', 'Mozilla/5.0 Linux Firefox/140.0', '192.0.2.15')`,
    [
      syntheticSessions.staffCurrent,
      syntheticSessions.ownerCurrent,
      syntheticSessions.ownerRemote,
      syntheticSessions.ownerExpired,
      syntheticSessions.foreignCurrent,
      syntheticSessions.foreignRemote,
      syntheticUsers.staff,
      syntheticUsers.owner,
      syntheticUsers.foreignMember,
    ],
  );
  await client.query(
    `insert into auth.refresh_tokens
       (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
     values
       ('00000000-0000-0000-0000-000000000000', 'rpc-probe-session-owner-current', $1, false, now(), now(), $3),
       ('00000000-0000-0000-0000-000000000000', 'rpc-probe-session-owner-remote', $1, false, now(), now(), $4),
       ('00000000-0000-0000-0000-000000000000', 'rpc-probe-session-foreign-current', $2, false, now(), now(), $5)`,
    [
      syntheticUsers.owner,
      syntheticUsers.foreignMember,
      syntheticSessions.ownerCurrent,
      syntheticSessions.ownerRemote,
      syntheticSessions.foreignCurrent,
    ],
  );

  // Setup (as postgres): probe identities. u1 gets the synthetic TOTP factor;
  // u2/u3 are cap-clean for the mint probes; u4 votes. All inserts vanish at
  // rollback — the factor row exists only inside this transaction.
  const [u1] = await q("select id from auth.users order by created_at limit 1");
  const capFree = await q(
    `select u.id from auth.users u
      where not exists (select 1 from public.member_point_events e
                         where e.user_id = u.id and e.action_kind = 'case'
                           and e.occurred_at >= date_trunc('week', now()))
      order by u.created_at limit 2`);
  // u4 carries probe 3's precondition IN THE PICK (review HIGH): the
  // non-lockout arm is only meaningful for a caller with no verified TOTP,
  // and u1 is excluded because probe 1's synthetic factor is still live
  // inside this transaction. Since 20260808230000 the pick is also
  // vote-cap-clean for the current week, because probe 8 asserts the vote
  // award actually mints — an exhausted weekly vote cap would zero it.
  const [u4] = await q(
    `select u.id from auth.users u
      where u.id <> $1
        and not exists (select 1 from auth.mfa_factors f
                         where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp')
        and not exists (select 1 from public.member_point_events e
                         where e.user_id = u.id and e.action_kind = 'vote'
                           and e.occurred_at >= date_trunc('week', now()))
      order by u.created_at limit 1`, [u1?.id]);
  if (!u1 || capFree.length < 2 || !u4) throw new Error("setup: could not pick probe users");
  const [u2, u3] = capFree;

  const aal1 = (sub) => ({ sub, role: "authenticated", aal: "aal1" });
  const aal2 = (sub) => ({ sub, role: "authenticated", aal: "aal2" });
  const aal1Session = (sub, sessionId) => ({ ...aal1(sub), session_id: sessionId });
  const focus = (process.env.VERIFY_RPC_FOCUS ?? "").trim();
  if (focus && !["device-sessions", "workload"].includes(focus)) throw new Error("unknown VERIFY_RPC_FOCUS value");
  if (focus === "workload") {
    await runWorkloadIntelligenceProbes();
    await client.query("rollback");
    const [focusedWorkloadResidue] = await q(
      `select
         (select count(*) from auth.users where email like 'rpc-probe-workload-%@example.test')
       + (select count(*) from public.member_cases where reference like 'WKL-PROBE-%')
       + (select count(*) from public.member_notifications where title like 'WKL-PROBE-%')
         as leftovers`,
    );
    check("zero focused workload probe residue after rollback",
      Number(focusedWorkloadResidue.leftovers) === 0,
      "0", String(focusedWorkloadResidue.leftovers));
    return;
  }
  if (focus === "device-sessions") {
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'probe-session-totp', 'totp', 'verified', now(), now())`,
      [syntheticUsers.staff],
    );
    await runMemberSessionProbes();
    await client.query("rollback");
    const [focusedSessionResidue] = await q(
      `select
         (select count(*) from auth.sessions where id = any($1::uuid[]))
       + (select count(*) from auth.refresh_tokens where token like 'rpc-probe-session-%')
       + (select count(*) from public.member_push_subscriptions where endpoint like '%/rpc-probe-%')
       + (select count(*) from auth.mfa_factors where user_id = $2 and friendly_name = 'probe-session-totp')
       + (select count(*) from public.organizations where slug like 'rpc-probe-reset-%')
       + (select count(*) from public.chapters where id like 'rpc-probe-reset-%')
         as leftovers,
         pg_catalog.to_regclass('private.member_session_revocations') is null
           and pg_catalog.to_regclass('private.member_session_closing_barriers') is null
           as pending_schema_rolled_back`,
      [Object.values(syntheticSessions), syntheticUsers.staff],
    );
    check("zero focused device-session probe residue after rollback",
      Number(focusedSessionResidue.leftovers) === 0
        && (!pendingMigration || focusedSessionResidue.pending_schema_rolled_back === true),
      pendingMigration ? "0 and pending schema absent" : "0",
      JSON.stringify(focusedSessionResidue));
    return;
  }

  const RSVP = "select public.rsvp_to_event('probe-no-such-event', 'going')";

  // 1. aal1 + verified TOTP -> 42501. The factor is synthetic and transactional.
  await client.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'probe-totp', 'totp', 'verified', now(), now())`, [u1.id]);
  const p1 = await callAs(aal1(u1.id), RSVP);
  check("aal1 with enrolled TOTP is refused (42501)", p1.code === "42501", "42501", p1.code || "success");

  // 2. aal2 passes the guard (the factor row from probe 1 is still in-txn,
  //    which is the point: aal2 satisfies the predicate even with a factor).
  //    The guard is the FIRST statement, so passing it on a nonexistent event
  //    lands deterministically on the 22023 not-found raise.
  const p2 = await callAs(aal2(u1.id), RSVP);
  check("aal2 passes the assurance guard", p2.code === "22023", "22023 (past the guard)", p2.code || "success");

  // 3. NON-LOCKOUT: aal1 with no verified TOTP passes (u4's pick guarantees
  //    the no-factor precondition).
  const p3 = await callAs(aal1(u4.id), RSVP);
  check("aal1 with no factor passes (non-lockout)", p3.code === "22023", "22023 (past the guard)", p3.code || "success");

  // 4. No claims at all -> caller is null -> 42501.
  const p4 = await callAs(null, RSVP);
  check("null caller is refused (42501)", p4.code === "42501", "42501", p4.code || "success");

  // 5. Weekly cap exhausted -> zero mint. 'case' pays 25 with weekly_cap 3;
  //    backing = a caller-owned member_cases row with the key's reference.
  await client.query(
    `insert into public.member_cases (user_id, reference, title, case_type)
     values ($1, 'GR-2026-PROBECAP1', 'probe', 'Grievance')`, [u2.id]);
  await client.query(
    `insert into public.member_point_events (user_id, action_key, action_kind, points)
     select $1, 'case-PROBE-SEED-' || n, 'case', 25 from generate_series(1, 3) n`, [u2.id]);
  await client.query(
    `insert into public.member_action_log (user_id, action_key, action_kind)
     values ($1, 'case-GR-2026-PROBECAP1', 'case')`, [u2.id]);
  const [cap] = await q(
    "select count(*)::int as minted from public.member_point_events where user_id = $1 and action_key = 'case-GR-2026-PROBECAP1'", [u2.id]);
  check("weekly cap exhausted -> backed mint writes 0 point events", cap.minted === 0, "0", String(cap.minted));

  // 6. Positive control: same shape, cap NOT exhausted (2 of 3 used) -> pays 25.
  await client.query(
    `insert into public.member_cases (user_id, reference, title, case_type)
     values ($1, 'GR-2026-PROBECAP2', 'probe', 'Grievance')`, [u3.id]);
  await client.query(
    `insert into public.member_point_events (user_id, action_key, action_kind, points)
     select $1, 'case-PROBE-SEED-B' || n, 'case', 25 from generate_series(1, 2) n`, [u3.id]);
  await client.query(
    `insert into public.member_action_log (user_id, action_key, action_kind)
     values ($1, 'case-GR-2026-PROBECAP2', 'case')`, [u3.id]);
  const [pay] = await q(
    "select coalesce(sum(points), 0)::int as points from public.member_point_events where user_id = $1 and action_key = 'case-GR-2026-PROBECAP2'", [u3.id]);
  check("under the cap the same mint pays 25", pay.points === 25, "25", String(pay.points));

  // 7. Cross-ballot option -> 22023 'invalid option for this ballot'. BOTH
  //    ballots are synthetic and created in-txn, so the probe depends on no
  //    seed data and no calendar (review: voting in the seeded ballot-2026
  //    would start failing the day it closes). The option belongs to ballot
  //    B, so the single-column FK would be satisfied — only the RPC's pairing
  //    check (and, one layer down, the composite FK from 20260725210000) can
  //    refuse.
  //    The probe ballots are scoped to u4's own chapter and authored by u4:
  //    since SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920 an
  //    organization-wide ballot needs an owning organization, and the ballot
  //    must be one u4 is eligible for.
  await client.query(
    `insert into public.member_ballots (id, title, closes_at, active, campaign_state, order_index, chapter_id, created_by)
     select v.id, v.title, v.closes_at, v.active, v.campaign_state, v.order_index, p.chapter_id, p.id
     from (values ('probe-rpc-ballot-a', 'probe', now() + interval '1 day', true, 'open', 990101),
                  ('probe-rpc-ballot-b', 'probe', now() + interval '1 day', true, 'open', 990102))
       v(id, title, closes_at, active, campaign_state, order_index)
     cross join public.member_profiles p
     where p.id = $1`, [u4.id]);
  await client.query(
    `insert into public.member_ballot_options (id, ballot_id, label, order_index)
     values ('probe-rpc-option-a', 'probe-rpc-ballot-a', 'probe', 1),
            ('probe-rpc-option-b', 'probe-rpc-ballot-b', 'probe', 1)`);
  const p7 = await callAs(aal2(u4.id), "select public.submit_ballot_vote('probe-rpc-ballot-a', 'probe-rpc-option-b')");
  check("cross-ballot option refused with 22023", p7.code === "22023", "22023", p7.code || "success");
  check("cross-ballot refusal names the defect", (p7.message || "").includes("invalid option for this ballot"),
    "message contains 'invalid option for this ballot'", p7.message || "(success)");

  // 8. Valid option succeeds end-to-end under the unlinkable-storage shape
  //    (20260808230000): the receipt comes back non-empty from inside the
  //    transaction that counted the vote, the choice lands as exactly ONE
  //    anonymous member_ballot_choices row, NO user-linked row appears in the
  //    emptied member_ballot_votes table, and the vote award mints. The
  //    writes stay in the outer transaction (callAsKeeping) so the shape is
  //    observable — and so probe 9 can trip over the receipt.
  const p8 = await callAsKeeping(aal2(u4.id), "select public.submit_ballot_vote('probe-rpc-ballot-a', 'probe-rpc-option-a') as result");
  check("valid vote succeeds", p8.code === "", "success", p8.code || "success");
  const vote = p8.rows?.[0]?.result ?? {};
  check("valid vote returns a non-empty receiptCode", typeof vote.receiptCode === "string" && vote.receiptCode.length > 0,
    "non-empty receiptCode", JSON.stringify(vote.receiptCode ?? null));
  const [shape] = await q(`select
      (select count(*)::int from public.member_ballot_choices where ballot_id in ('probe-rpc-ballot-a', 'probe-rpc-ballot-b')) as choices,
      (select count(*)::int from public.member_ballot_votes where ballot_id in ('probe-rpc-ballot-a', 'probe-rpc-ballot-b')) as votes,
      (select count(*)::int from public.member_ballot_receipts where ballot_id = 'probe-rpc-ballot-a' and user_id = $1) as receipts,
      (select coalesce(sum(points), 0)::int from public.member_point_events
        where user_id = $1 and action_key = 'vote-probe-rpc-ballot-a') as points`, [u4.id]);
  check("vote lands as exactly one anonymous choice row", shape.choices === 1, "1", String(shape.choices));
  check("no user-linked vote row is written", shape.votes === 0, "0", String(shape.votes));
  check("exactly one receipt records participation", shape.receipts === 1, "1", String(shape.receipts));
  check("the vote award mints into the ledger", shape.points > 0, "> 0", String(shape.points));

  // 9. Votes are FINAL: a second submission for the same (ballot, member) —
  //    even for the same option — is refused. Plain callAs: the refusal
  //    writes nothing, and probe 8's receipt (still live in the outer
  //    transaction) is what trips issue_ballot_receipt's null-return path.
  const p9 = await callAs(aal2(u4.id), "select public.submit_ballot_vote('probe-rpc-ballot-a', 'probe-rpc-option-a')");
  check("second vote for the same ballot is refused (22023)", p9.code === "22023", "22023", p9.code || "success");
  check("repeat-vote refusal says the vote is already recorded", (p9.message || "").includes("your vote is already recorded"),
    "message contains 'your vote is already recorded'", p9.message || "(success)");

  // 10. Durable visible keys: deleting the highest-numbered task must not let
  //    the allocator reuse that number. Unlike callAs(), these writes remain
  //    in the outer transaction until its final rollback so the second create
  //    can observe the counter left by the first after the task row is gone.
  //    Tasks are created through create_chapter_task, the only client insert
  //    path since 20261103183000.
  const [taskActor] = await q(
    `select distinct r.user_id, p.chapter_id
       from public.member_roles r
       join public.member_profiles p on p.id = r.user_id
      where r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
        and p.chapter_id is not null
        and exists (
          select 1 from public.chapter_workstreams w
           where w.chapter_id = p.chapter_id and w.name = 'General'
        )
      order by r.user_id
      limit 1`);
  if (!taskActor) throw new Error("setup: could not pick a staff task actor with a General workstream");

  // Staff-role policies can require a verified enrolled factor in addition to
  // an aal2 JWT. Production seed identities intentionally have no real factor,
  // so install a transaction-only proof for this actor rather than weakening
  // the policy or depending on operator account state.
  await addProbeTotp(taskActor.user_id, "task");

  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(aal2(taskActor.user_id))]);
  await client.query("set local role authenticated");
  const [firstTask] = await q(
    `select id, task_number
       from public.create_chapter_task(pg_catalog.jsonb_build_object('title', 'KANBAN-PROBE-DURABLE-KEY-1'))`);
  await client.query("reset role");
  await client.query("delete from public.chapter_tasks where id = $1", [firstTask.id]);

  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(aal2(taskActor.user_id))]);
  await client.query("set local role authenticated");
  const [secondTask] = await q(
    `select id, task_number
       from public.create_chapter_task(pg_catalog.jsonb_build_object('title', 'KANBAN-PROBE-DURABLE-KEY-2'))`);
  await client.query("reset role");
  check("hard-purged task number is never reused", Number(secondTask.task_number) > Number(firstTask.task_number),
    `greater than ${firstTask.task_number}`, String(secondTask.task_number));
  await client.query(
    "delete from auth.mfa_factors where user_id = $1 and friendly_name = 'probe-task-totp'",
    [taskActor.user_id],
  );

  // 11. UB-RGT-02: prove the COMBINED retrieval + RLS behavior under the role
  // the product actually uses. Text pins can show that search_member_kb says
  // `security invoker`; only a transactional call as authenticated proves the
  // chapter_documents policy, its restrictive MFA policy, published-only
  // filter, and staff visibility branch compose without a leak or false deny.
  const [libraryStaff] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id is not null
        and exists (
          select 1 from public.member_roles r
           where r.user_id = p.id
             and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
        )
      order by p.id
      limit 1`);
  if (!libraryStaff) throw new Error("setup: could not pick a staff user for Compass library probe");
  const [libraryMember] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id = $1
        and not exists (select 1 from public.member_roles r where r.user_id = p.id)
      order by p.id
      limit 1`, [libraryStaff.chapter_id]);
  const [foreignMember] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id is not null
        and p.chapter_id <> $1
        and not exists (select 1 from public.member_roles r where r.user_id = p.id)
      order by p.id
      limit 1`, [libraryStaff.chapter_id]);
  if (!libraryMember || !foreignMember) {
    throw new Error("setup: Compass library probe needs non-staff members in two chapters");
  }
  await addProbeTotp(libraryStaff.id, "library");

  const libraryNeedle = "compassprobeubrgttwo";
  // The identity trigger owns chapter_id and overwrites caller-supplied values,
  // including for postgres. Seed each chapter under the matching synthetic
  // caller so the probe exercises the same identity-stamping path as the app.
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(aal2(libraryStaff.id))]);
  await client.query(
    `insert into public.chapter_documents
       (title, document_type, summary, body, visibility, status, created_by, published_at)
     values
       ('COMPASS-PROBE-CHAPTER', 'policy', '', $2, 'chapter', 'published', $1, now()),
       ('COMPASS-PROBE-STAFF', 'policy', '', $2, 'staff', 'published', $1, now()),
       ('COMPASS-PROBE-NONMATCH', 'policy', '', 'unrelated scheduling handbook text', 'chapter', 'published', $1, now()),
       ('COMPASS-PROBE-DRAFT', 'policy', '', $2, 'chapter', 'draft', $1, null),
       ('COMPASS-PROBE-ARCHIVED', 'policy', '', $2, 'chapter', 'archived', $1, null)`,
    [libraryStaff.id, libraryNeedle]);
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(aal2(foreignMember.id))]);
  await client.query(
    `insert into public.chapter_documents
       (title, document_type, summary, body, visibility, status, created_by, published_at)
     values ('COMPASS-PROBE-FOREIGN', 'policy', '', $2, 'chapter', 'published', $1, now())`,
    [foreignMember.id, libraryNeedle]);

  const searchLibraryAs = (userId) => callAs(
    aal2(userId),
    "select source_id, title from public.search_member_kb($1, 6)",
    [libraryNeedle],
  );
  const memberLibrary = await searchLibraryAs(libraryMember.id);
  const staffLibrary = await searchLibraryAs(libraryStaff.id);
  const foreignLibrary = await searchLibraryAs(foreignMember.id);
  check("member Compass library search succeeds", memberLibrary.code === "", "success", memberLibrary.code || "success");
  check("staff Compass library search succeeds", staffLibrary.code === "", "success", staffLibrary.code || "success");
  check("foreign-chapter Compass library search succeeds", foreignLibrary.code === "", "success", foreignLibrary.code || "success");
  const titlesOf = (probe) => (probe.rows || []).map((row) => row.title).sort();
  check("member sees only same-chapter published chapter-visible document",
    JSON.stringify(titlesOf(memberLibrary)) === JSON.stringify(["COMPASS-PROBE-CHAPTER"]),
    "COMPASS-PROBE-CHAPTER", JSON.stringify(titlesOf(memberLibrary)));
  check("member search excludes same-chapter published nonmatching document",
    !titlesOf(memberLibrary).includes("COMPASS-PROBE-NONMATCH"),
    "nonmatching document absent", JSON.stringify(titlesOf(memberLibrary)));
  check("staff sees same-chapter published chapter and staff documents only",
    JSON.stringify(titlesOf(staffLibrary)) === JSON.stringify(["COMPASS-PROBE-CHAPTER", "COMPASS-PROBE-STAFF"]),
    "COMPASS-PROBE-CHAPTER,COMPASS-PROBE-STAFF", JSON.stringify(titlesOf(staffLibrary)));
  check("foreign member sees only their own chapter's published document",
    JSON.stringify(titlesOf(foreignLibrary)) === JSON.stringify(["COMPASS-PROBE-FOREIGN"]),
    "COMPASS-PROBE-FOREIGN", JSON.stringify(titlesOf(foreignLibrary)));

  // 12. Intake cannot live and die at `new`. Exercise the actual authenticated
  // path for triage plus every conversion target, while pinning privacy and
  // idempotency invariants that a catalog/text check cannot prove.
  const [intakeStaff] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id is not null
        and exists (
          select 1 from public.member_roles r
          where r.user_id = p.id and r.role in ('steward', 'coordinator')
        )
        and exists (
          select 1 from public.member_profiles member_profile
          where member_profile.chapter_id = p.chapter_id
            and not exists (select 1 from public.member_roles mr where mr.user_id = member_profile.id)
        )
      order by p.id
      limit 1`);
  if (!intakeStaff) throw new Error("setup: intake probe needs staff and an ordinary member in one chapter");
  const [intakeMember] = await q(
    `select p.id from public.member_profiles p
      where p.chapter_id = $1
        and not exists (select 1 from public.member_roles r where r.user_id = p.id)
      order by p.id limit 1`, [intakeStaff.chapter_id]);
  const [foreignStaff] = await q(
    `select p.id, p.chapter_id from public.member_profiles p
      where p.chapter_id is not null and p.chapter_id <> $1
        and exists (
          select 1 from public.member_roles r
          where r.user_id = p.id and r.role in ('steward', 'coordinator')
        )
      order by p.id limit 1`, [intakeStaff.chapter_id]);
  if (!intakeMember || !foreignStaff) {
    throw new Error("setup: intake probe needs authorized staff in a foreign chapter");
  }
  await addProbeTotp(intakeStaff.id, "intake-local");
  await addProbeTotp(foreignStaff.id, "intake-foreign");

  const createProbeReport = async (suffix) => {
    const created = await callAsKeeping(
      aal2(intakeMember.id),
      `insert into public.member_intake_reports (category, title, details)
       values ('workplace_issue', $1, 'INTAKE-PROBE protected details')
       returning id`,
      [`INTAKE-PROBE-${suffix}`],
    );
    if (created.code || !created.rows?.[0]?.id) {
      throw new Error(`setup: could not create intake probe ${suffix}: ${created.code || "no row"}`);
    }
    return created.rows[0].id;
  };

  const intakeCaseReport = await createProbeReport("CASE");
  const intakeTaskReport = await createProbeReport("TASK");
  const intakeThreadReport = await createProbeReport("THREAD");
  const intakeMemberDeniedReport = await createProbeReport("MEMBER-DENIED");
  const intakeForeignDeniedReport = await createProbeReport("FOREIGN-DENIED");

  const directIntakeUpdate = await callAs(
    aal2(intakeStaff.id),
    "update public.member_intake_reports set status = 'closed' where id = $1 returning id",
    [intakeCaseReport],
  );
  check("direct intake lifecycle update is column-denied",
    directIntakeUpdate.code === "42501", "42501", directIntakeUpdate.code || "success");

  const foreignAssignment = await callAs(
    aal2(intakeStaff.id),
    "select public.triage_member_intake_report($1, 'triaged', $2) as result",
    [intakeCaseReport, foreignStaff.id],
  );
  check("cross-chapter intake owner is refused",
    foreignAssignment.code === "22023", "22023", foreignAssignment.code || "success");

  const memberTriageDenied = await callAsKeeping(
    aal2(intakeMember.id),
    "select public.triage_member_intake_report($1, 'triaged', null)",
    [intakeMemberDeniedReport],
  );
  check("ordinary member cannot triage intake",
    memberTriageDenied.code === "42501", "42501", memberTriageDenied.code || "success");
  const memberConvertDenied = await callAsKeeping(
    aal2(intakeMember.id),
    "select public.convert_member_intake_report($1, 'case', null)",
    [intakeMemberDeniedReport],
  );
  check("ordinary member cannot convert intake",
    memberConvertDenied.code === "42501", "42501", memberConvertDenied.code || "success");

  const foreignTriageDenied = await callAsKeeping(
    aal2(foreignStaff.id),
    "select public.triage_member_intake_report($1, 'triaged', null)",
    [intakeForeignDeniedReport],
  );
  check("foreign-chapter intake staff cannot triage",
    foreignTriageDenied.code === "22023", "22023", foreignTriageDenied.code || "success");
  const foreignConvertDenied = await callAsKeeping(
    aal2(foreignStaff.id),
    "select public.convert_member_intake_report($1, 'case', null)",
    [intakeForeignDeniedReport],
  );
  check("foreign-chapter intake staff cannot convert",
    foreignConvertDenied.code === "22023", "22023", foreignConvertDenied.code || "success");

  const [deniedIntakeState] = await q(
    `select count(*)::int as unchanged
       from public.member_intake_reports r
      where r.id = any($1::uuid[])
        and r.status = 'new'
        and r.assigned_to is null
        and r.case_id is null
        and r.task_id is null
        and r.thread_id is null`,
    [[intakeMemberDeniedReport, intakeForeignDeniedReport]],
  );
  check("denied intake callers leave reports unchanged",
    deniedIntakeState?.unchanged === 2, "2 unchanged reports", String(deniedIntakeState?.unchanged));

  const triaged = await callAsKeeping(
    aal2(intakeStaff.id),
    "select public.triage_member_intake_report($1, 'triaged', $2) as result",
    [intakeCaseReport, intakeStaff.id],
  );
  check("same-chapter intake owner triage succeeds", triaged.code === "", "success", triaged.code || "success");
  check("triage persists status and owner",
    triaged.rows?.[0]?.result?.status === "triaged" && triaged.rows?.[0]?.result?.assigned_to === intakeStaff.id,
    "triaged + selected owner", JSON.stringify(triaged.rows?.[0]?.result || null));

  const caseConversion = await callAsKeeping(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'case', null) as result",
    [intakeCaseReport],
  );
  const intakeCaseId = caseConversion.rows?.[0]?.result?.targetId;
  check("intake converts to a case", caseConversion.code === "" && Boolean(intakeCaseId),
    "case target id", caseConversion.code || String(intakeCaseId));
  const [convertedCase] = await q(
    `select c.user_id, c.steward_user_id, c.coordinator_user_id, r.status, r.case_id
       from public.member_intake_reports r join public.member_cases c on c.id = r.case_id
      where r.id = $1`, [intakeCaseReport]);
  check("converted case belongs to the reporter",
    convertedCase?.user_id === intakeMember.id
      && convertedCase?.status === "in_progress"
      && (convertedCase?.steward_user_id === intakeStaff.id || convertedCase?.coordinator_user_id === intakeStaff.id),
    "reporter-owned, intake-owner-assigned in-progress case", JSON.stringify(convertedCase || null));

  const repeatedCase = await callAs(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'case', null) as result",
    [intakeCaseReport],
  );
  check("same-target intake retry is idempotent",
    repeatedCase.code === "" && repeatedCase.rows?.[0]?.result?.targetId === intakeCaseId,
    String(intakeCaseId), repeatedCase.code || String(repeatedCase.rows?.[0]?.result?.targetId));
  const closedCase = await callAsKeeping(
    aal2(intakeStaff.id),
    "select public.triage_member_intake_report($1, 'closed', $2)",
    [intakeCaseReport, intakeStaff.id],
  );
  check("converted intake can be closed", closedCase.code === "", "success", closedCase.code || "success");
  const repeatedClosedCase = await callAs(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'case', null) as result",
    [intakeCaseReport],
  );
  check("closed same-target intake retry is idempotent",
    repeatedClosedCase.code === "" && repeatedClosedCase.rows?.[0]?.result?.targetId === intakeCaseId,
    String(intakeCaseId), repeatedClosedCase.code || String(repeatedClosedCase.rows?.[0]?.result?.targetId));
  const switchedTarget = await callAs(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'task', null)",
    [intakeCaseReport],
  );
  check("converted intake cannot switch targets", switchedTarget.code === "22023",
    "22023", switchedTarget.code || "success");

  const [expectedIntakeWorkstream] = await q(
    `select w.name from public.chapter_workstreams w
      where w.chapter_id = $1
      order by (w.name = 'General') desc, w.name, w.id
      limit 1`, [intakeStaff.chapter_id]);
  if (!expectedIntakeWorkstream) throw new Error("setup: intake probe needs an existing chapter workstream");
  const taskConversion = await callAsKeeping(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'task', null) as result",
    [intakeTaskReport],
  );
  const intakeTaskId = taskConversion.rows?.[0]?.result?.targetId;
  check("intake converts to a Standard Task", taskConversion.code === "" && Boolean(intakeTaskId),
    "task target id", taskConversion.code || String(intakeTaskId));
  const [convertedTask] = await q(
    `select t.title, t.description, t.status, t.priority, t.task_type, t.workstream, t.assignee_id,
            a.record_url, activity.action
       from public.chapter_tasks t
       join public.chapter_task_attachments a on a.task_id = t.id
       join public.chapter_task_activity activity
         on activity.task_id = t.id and activity.action = 'attachment_added'
      where t.id = $1`, [intakeTaskId]);
  check("intake task keeps sensitive report text off the card",
    convertedTask?.title === "Follow up on intake report"
      && convertedTask?.description === ""
      && convertedTask?.status === "to_do"
      && convertedTask?.priority === "medium"
      && convertedTask?.task_type === "general"
      && convertedTask?.workstream === expectedIntakeWorkstream.name
      && convertedTask?.assignee_id === null
      && convertedTask?.record_url === `/m/organize?intake=${intakeTaskReport}`,
    "quiet defaults + authorized link", JSON.stringify(convertedTask || null));

  let [intakeSpace] = await q(
    `select s.id from public.chapter_spaces s
      where s.chapter_id = $1 and s.archived_at is null and s.visibility in ('chapter', 'staff')
      order by s.id limit 1`, [intakeStaff.chapter_id]);
  let createdIntakeSpaceId = null;
  if (!intakeSpace) {
    const createdSpace = await callAsKeeping(
      aal2(intakeStaff.id),
      `insert into public.chapter_spaces (name, description, visibility)
       values ('INTAKE-PROBE-SPACE', '', 'staff') returning id`,
    );
    if (createdSpace.code || !createdSpace.rows?.[0]?.id) {
      throw new Error(`setup: could not create intake probe space: ${createdSpace.code || "no row"}`);
    }
    createdIntakeSpaceId = createdSpace.rows[0].id;
    intakeSpace = { id: createdIntakeSpaceId };
  }
  const threadConversion = await callAsKeeping(
    aal2(intakeStaff.id),
    "select public.convert_member_intake_report($1, 'thread', $2) as result",
    [intakeThreadReport, intakeSpace.id],
  );
  const intakeThreadId = threadConversion.rows?.[0]?.result?.targetId;
  check("intake converts into the selected accessible space",
    threadConversion.code === "" && Boolean(intakeThreadId),
    "thread target id", threadConversion.code || String(intakeThreadId));
  const [convertedThread] = await q(
    `select t.space_id, t.kind, r.thread_id, r.status
       from public.member_intake_reports r join public.chapter_threads t on t.id = r.thread_id
      where r.id = $1`, [intakeThreadReport]);
  check("converted intake thread is linked and in progress",
    convertedThread?.space_id === intakeSpace.id
      && convertedThread?.kind === "intake"
      && convertedThread?.thread_id === intakeThreadId
      && convertedThread?.status === "in_progress",
    "selected intake thread", JSON.stringify(convertedThread || null));

  // 13. UB-CW-04: the source stays behind its own RLS boundary and the task
  // gets only neutral metadata plus typed provenance. Build every source in
  // this transaction so the proof depends on neither production content nor
  // dates. The positive message is deliberately owned by a different member:
  // staff role alone is insufficient, but same-chapter steward visibility is
  // an independently proven source-access path. The two refusal probes share
  // a fresh source and bracket a task-count snapshot to prove no orphan write.
  const [sourceStaff] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id is not null
        and exists (
          select 1 from public.member_roles r
           where r.user_id = p.id
             and r.role = 'steward'
             and (r.chapter_id is null or r.chapter_id = p.chapter_id)
        )
        and exists (
          select 1 from public.chapter_workstreams w
           where w.chapter_id = p.chapter_id
        )
        and exists (
          select 1 from public.member_profiles owner
           where owner.chapter_id = p.chapter_id
             and owner.id <> p.id
             and not exists (select 1 from public.member_roles mr where mr.user_id = owner.id)
        )
      order by p.id
      limit 1`);
  if (!sourceStaff) throw new Error("setup: source-task probe needs a scoped steward and workstream");
  const [sourceOwner] = await q(
    `select p.id from public.member_profiles p
      where p.chapter_id = $1
        and p.id <> $2
        and not exists (select 1 from public.member_roles r where r.user_id = p.id)
      order by p.id limit 1`, [sourceStaff.chapter_id, sourceStaff.id]);
  const [sourceForeignStaff] = await q(
    `select p.id, p.chapter_id
       from public.member_profiles p
      where p.chapter_id is not null
        and p.chapter_id <> $1
        and exists (
          select 1 from public.member_roles r
           where r.user_id = p.id
             and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
        )
        and not exists (
          select 1 from public.member_roles r
           where r.user_id = p.id
             and r.role = 'steward'
             and (r.chapter_id is null or r.chapter_id = $1)
        )
      order by p.id limit 1`, [sourceStaff.chapter_id]);
  if (!sourceOwner || !sourceForeignStaff) {
    throw new Error("setup: source-task probe needs an ordinary owner and out-of-scope foreign staff");
  }
  await addProbeTotp(sourceStaff.id, "source-local");
  await addProbeTotp(sourceForeignStaff.id, "source-foreign");

  const [sourceConversation] = await q(
    `insert into public.member_conversations (user_id, title, initials)
     values ($1, 'SOURCE-TASK-PROBE', 'SP') returning id`, [sourceOwner.id]);
  const sourceMessages = await q(
    `insert into public.member_messages
       (conversation_id, user_id, sender_kind, sender_name, body)
     values
       ($1, $2, 'member', 'Probe member', 'SOURCE-TASK-PROBE private message body'),
       ($1, $2, 'member', 'Probe member', 'SOURCE-TASK-PROBE denied private body')
     returning id`, [sourceConversation.id, sourceOwner.id]);
  const [sourceBroadcastOrder] = await q(
    "select coalesce(max(order_index), 0) + 1 as next from public.member_broadcasts");
  const [sourceBroadcast] = await q(
    `insert into public.member_broadcasts
       (id, sender, title, body, published_at, order_index, created_by)
     values
       ('source-task-probe-broadcast', 'Probe', 'SOURCE-TASK-PROBE broadcast',
        'SOURCE-TASK-PROBE protected broadcast body', now(), $1, $2)
     returning id`, [sourceBroadcastOrder.next, sourceStaff.id]);
  const [sourceNotification] = await q(
    `insert into public.member_notifications (user_id, title, body, kind)
     values ($1, 'SOURCE-TASK-PROBE notification',
       'SOURCE-TASK-PROBE protected notification body', 'general')
     returning id`, [sourceStaff.id]);
  const [sourceSurveyOrder] = await q(
    "select coalesce(max(order_index), 0) + 1 as next from public.member_surveys");
  const [sourceSurvey] = await q(
    `insert into public.member_surveys (id, title, closes_at, active, campaign_state, order_index, chapter_id)
     values ('source-task-probe-survey', 'SOURCE-TASK-PROBE protected survey title',
       now() + interval '1 day', true, 'open', $1, $2)
     returning id`, [sourceSurveyOrder.next, sourceStaff.chapter_id]);
  const [sourceCase] = await q(
    `insert into public.member_cases
       (user_id, reference, title, case_type, status, steward_user_id)
     values ($1, 'GR-2026-SOURCE-TASK-PROBE',
       'SOURCE-TASK-PROBE protected grievance title', 'Grievance', 'active', $2)
     returning id`, [sourceOwner.id, sourceStaff.id]);

  const positiveSources = [
    ["message", sourceMessages[0].id],
    ["broadcast", sourceBroadcast.id],
    ["notification", sourceNotification.id],
    ["survey", sourceSurvey.id],
    ["case", sourceCase.id],
  ];
  const sourceTaskIds = [];
  for (const [kind, id] of positiveSources) {
    const converted = await callAsKeeping(
      aal2(sourceStaff.id),
      "select public.create_chapter_task_from_source($1, $2) as result",
      [kind, String(id)],
    );
    const result = converted.rows?.[0]?.result;
    check(`${kind} source creates a task`,
      converted.code === "" && result?.created === true && Boolean(result?.task?.id),
      "created task", converted.code || JSON.stringify(result || null));
    if (result?.task?.id) sourceTaskIds.push(result.task.id);
  }
  check("foreign member owner is distinct from authorized staff caller",
    sourceOwner.id !== sourceStaff.id, "different users", `${sourceOwner.id} / ${sourceStaff.id}`);
  // staff_can_see_user derives auth.uid(), so prove it under the caller's role.
  const sourceAccessAsCaller = await callAs(
    aal2(sourceStaff.id),
    "select public.staff_can_see_user($1, 'steward') as can_see",
    [sourceOwner.id],
  );
  check("foreign-owner conversion independently proves steward source scope",
    sourceAccessAsCaller.code === "" && sourceAccessAsCaller.rows?.[0]?.can_see === true,
    "true", sourceAccessAsCaller.code || String(sourceAccessAsCaller.rows?.[0]?.can_see));

  const [expectedSourceWorkstream] = await q(
    `select w.name from public.chapter_workstreams w
      where w.chapter_id = $1
      order by (lower(btrim(w.name)) = 'general') desc,
               lower(btrim(w.name)), w.name, w.id
      limit 1`, [sourceStaff.chapter_id]);
  const sourceTaskRows = await q(
    `select t.id, t.chapter_id, t.title, t.description, t.status, t.priority,
            t.task_type, t.workstream, t.assignee_id, t.start_date, t.due_date,
            t.progress, t.blocked, t.milestone,
            a.id as attachment_id, a.label, a.record_url, a.source_kind, a.source_id
       from public.chapter_tasks t
       join public.chapter_task_attachments a on a.task_id = t.id
      where t.id = any($1::uuid[])
      order by a.source_kind`, [sourceTaskIds]);
  check("all five source tasks persist typed provenance",
    sourceTaskRows.length === 5
      && new Set(sourceTaskRows.map((row) => `${row.source_kind}:${row.source_id}`)).size === 5,
    "5 distinct typed links", JSON.stringify(sourceTaskRows.map((row) => [row.source_kind, row.source_id])));
  check("source tasks use Standard Task quiet defaults and inherited chapter scope",
    sourceTaskRows.length === 5 && sourceTaskRows.every((row) =>
      row.chapter_id === sourceStaff.chapter_id
        && row.description === ""
        && row.status === "to_do"
        && row.priority === "medium"
        && row.task_type === "general"
        && row.workstream === expectedSourceWorkstream.name
        && row.assignee_id === null
        && row.start_date === null
        && row.due_date === null
        && Number(row.progress) === 0
        && row.blocked === false
        && row.milestone === false),
    "quiet defaults in caller chapter", JSON.stringify(sourceTaskRows));
  const protectedNeedle = "source-task-probe protected";
  check("source content is absent from task cards and link labels",
    sourceTaskRows.every((row) =>
      !`${row.title} ${row.description} ${row.label}`.toLowerCase().includes(protectedNeedle)),
    "no protected source copy", JSON.stringify(sourceTaskRows.map((row) => [row.title, row.description, row.label])));
  const sourceRowsByKind = Object.fromEntries(sourceTaskRows.map((row) => [row.source_kind, row]));
  check("source links route to authorized record surfaces",
    sourceRowsByKind.message?.record_url === `/m/steward?thread=${sourceConversation.id}`
      && sourceRowsByKind.broadcast?.record_url === `/m/messages?broadcast=${sourceBroadcast.id}`
      && sourceRowsByKind.notification?.record_url === `/m/messages?notification=${sourceNotification.id}`
      && sourceRowsByKind.survey?.record_url === `/m/voting?survey=${sourceSurvey.id}`
      && sourceRowsByKind.case?.record_url === `/m/steward?case=${sourceCase.id}`,
    "five exact authorized routes",
    JSON.stringify(Object.fromEntries(Object.entries(sourceRowsByKind).map(([kind, row]) => [kind, row.record_url]))));
  const sourceAudits = await q(
    `select task_id, array_agg(action order by id) as actions
       from public.chapter_task_activity
      where task_id = any($1::uuid[])
      group by task_id`, [sourceTaskIds]);
  check("source task creation and authorized-link changes are audited atomically",
    sourceAudits.length === 5 && sourceAudits.every((row) =>
      row.actions.includes("created") && row.actions.includes("attachment_added")),
    "created + attachment_added for every task", JSON.stringify(sourceAudits));

  const repeatedSource = await callAsKeeping(
    aal2(sourceStaff.id),
    "select public.create_chapter_task_from_source('message', $1) as result",
    [sourceMessages[0].id],
  );
  check("same typed source retry returns the existing outcome",
    repeatedSource.code === ""
      && repeatedSource.rows?.[0]?.result?.created === false
      && repeatedSource.rows?.[0]?.result?.task?.id === sourceRowsByKind.message?.id,
    String(sourceRowsByKind.message?.id),
    repeatedSource.code || JSON.stringify(repeatedSource.rows?.[0]?.result || null));
  await client.query(
    "update public.member_broadcasts set retracted_at = now() where id = $1",
    [sourceBroadcast.id],
  );
  const retractedRetry = await callAs(
    aal2(sourceStaff.id),
    "select public.create_chapter_task_from_source('broadcast', $1) as result",
    [sourceBroadcast.id],
  );
  check("retracted source retry still returns its prior task",
    retractedRetry.code === ""
      && retractedRetry.rows?.[0]?.result?.created === false
      && retractedRetry.rows?.[0]?.result?.task?.id === sourceRowsByKind.broadcast?.id,
    String(sourceRowsByKind.broadcast?.id),
    retractedRetry.code || JSON.stringify(retractedRetry.rows?.[0]?.result || null));
  const [sourceCountsBeforeDenials] = await q(
    `select
       (select count(*)::int from public.chapter_tasks where chapter_id = $1) as tasks,
       (select count(*)::int from public.chapter_task_attachments where chapter_id = $1) as attachments,
       (select count(*)::int from public.chapter_task_activity where chapter_id = $1) as activity`,
    [sourceStaff.chapter_id]);
  const memberSourceDenied = await callAsKeeping(
    aal2(sourceOwner.id),
    "select public.create_chapter_task_from_source('message', $1)",
    [sourceMessages[1].id],
  );
  check("ordinary source owner cannot spawn chapter work",
    memberSourceDenied.code === "42501", "42501", memberSourceDenied.code || "success");
  const foreignStaffSourceDenied = await callAsKeeping(
    aal2(sourceForeignStaff.id),
    "select public.create_chapter_task_from_source('message', $1)",
    [sourceMessages[1].id],
  );
  check("out-of-scope foreign staff cannot convert a member message",
    foreignStaffSourceDenied.code === "22023", "22023", foreignStaffSourceDenied.code || "success");
  const [sourceCountsAfterDenials] = await q(
    `select
       (select count(*)::int from public.chapter_tasks where chapter_id = $1) as tasks,
       (select count(*)::int from public.chapter_task_attachments where chapter_id = $1) as attachments,
       (select count(*)::int from public.chapter_task_activity where chapter_id = $1) as activity`,
    [sourceStaff.chapter_id]);
  const [deniedSourceLinks] = await q(
    `select count(*)::int as linked
       from public.chapter_task_attachments
      where source_kind = 'message' and source_id = $1`,
    [sourceMessages[1].id]);
  check("denied source callers leave tasks, links, and audit unchanged",
    JSON.stringify(sourceCountsAfterDenials) === JSON.stringify(sourceCountsBeforeDenials)
      && deniedSourceLinks.linked === 0,
    `${JSON.stringify(sourceCountsBeforeDenials)} and 0 links`,
    `${JSON.stringify(sourceCountsAfterDenials)} and ${deniedSourceLinks.linked} links`);

  // 14. UB-IDN-01 / UB-CON-07: an admin can provision without touching Auth
  // directly, while every identity/lifecycle boundary stays database-owned.
  const invitationEmails = [
    "rpc-probe-invite-lifecycle@example.test",
    "rpc-probe-invite-replay@example.test",
    "rpc-probe-invite-expiry@example.test",
    "rpc-probe-invite-finalize@example.test",
  ];
  const invitationHashes = ["11", "22", "33", "44"].map((pair) => pair.repeat(32));
  const createProbeInvitation = (email, hash, initialRole = null) => callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.create_member_invitation($1, $2, 'wor', $3, 'en', $4) as result",
    [email, "RPC Probe Invitee", initialRole, hash],
  );

  const directInvitationRead = await callAs(
    aal2(syntheticUsers.staff),
    "select id from public.member_invitations limit 1",
  );
  check("invitation tables remain RPC-only for authenticated admins",
    directInvitationRead.code === "42501", "42501", directInvitationRead.code || "success");
  const ordinaryInviteDenied = await callAsKeeping(
    aal2(syntheticUsers.owner),
    "select public.create_member_invitation($1, 'Denied Member', 'wor', null, 'en', $2)",
    ["rpc-probe-invite-member-denied@example.test", "55".repeat(32)],
  );
  check("ordinary member cannot create an invitation",
    ordinaryInviteDenied.code === "42501", "42501", ordinaryInviteDenied.code || "success");
  const chapterMismatchDenied = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.create_member_invitation($1, 'Wrong Chapter', 'bos', null, 'en', $2)",
    ["rpc-probe-invite-wrong-chapter@example.test", "66".repeat(32)],
  );
  check("admin cannot create an invitation for another chapter",
    chapterMismatchDenied.code === "42501", "42501", chapterMismatchDenied.code || "success");
  const foreignAdminDenied = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.create_member_invitation($1, 'Foreign Admin', 'wor', null, 'en', $2)",
    ["rpc-probe-invite-foreign-admin@example.test", "77".repeat(32)],
  );
  check("foreign admin cannot create an invitation into the target chapter",
    foreignAdminDenied.code === "42501", "42501", foreignAdminDenied.code || "success");

  const lifecycleCreate = await createProbeInvitation(invitationEmails[0], invitationHashes[0]);
  const lifecycleId = lifecycleCreate.rows?.[0]?.result?.invitationId;
  check("same-chapter admin creates one 15-minute digest-only invitation",
    lifecycleCreate.code === "" && Boolean(lifecycleId), "invitation id", lifecycleCreate.code || String(lifecycleId));
  const [createdInvitation] = await q(
    `select status, token_hash, initial_role,
            extract(epoch from (expires_at - clock_timestamp()))::int as remaining_seconds
       from public.member_invitations where id = $1`,
    [lifecycleId],
  );
  check("created invitation stores only the supplied digest and least-privilege role",
    createdInvitation?.status === "pending"
      && createdInvitation?.token_hash === invitationHashes[0]
      && createdInvitation?.initial_role === null
      && createdInvitation?.remaining_seconds >= 895
      && createdInvitation?.remaining_seconds <= 900,
    "pending digest-only member invitation with about 900 seconds remaining", JSON.stringify(createdInvitation || null));

  const duplicateInvite = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.create_member_invitation($1, 'Different Display Name', 'wor', null, 'en', $2) as result",
    [invitationEmails[0], "88".repeat(32)],
  );
  const existingIdentityInvite = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.create_member_invitation('rpc-probe-owner@example.test', 'Existing Identity', 'wor', null, 'en', $1) as result",
    ["99".repeat(32)],
  );
  const [antiEnumerationCounts] = await q(
    `select
       count(*) filter (where normalized_email = $1)::int as live_duplicate_rows,
       count(*) filter (where normalized_email = 'rpc-probe-owner@example.test')::int as existing_identity_rows
     from public.member_invitations`,
    [invitationEmails[0]],
  );
  check("live duplicate and existing identity return the same accepted no-send outcome",
    duplicateInvite.code === "" && duplicateInvite.rows?.[0]?.result?.accepted === true
      && duplicateInvite.rows?.[0]?.result?.send === false
      && existingIdentityInvite.code === "" && existingIdentityInvite.rows?.[0]?.result?.accepted === true
      && existingIdentityInvite.rows?.[0]?.result?.send === false
      && antiEnumerationCounts.live_duplicate_rows === 1
      && antiEnumerationCounts.existing_identity_rows === 0,
    "uniform accepted/no-send and no extra rows",
    `${JSON.stringify(duplicateInvite.rows?.[0]?.result || null)} / ${JSON.stringify(existingIdentityInvite.rows?.[0]?.result || null)} / ${JSON.stringify(antiEnumerationCounts)}`);

  const listedInvitations = await callAs(
    aal2(syntheticUsers.staff),
    "select public.get_member_invitations(50) as result",
  );
  const foreignInvitationList = await callAs(
    aal2(syntheticUsers.foreignStaff),
    "select public.get_member_invitations(50) as result",
  );
  const memberInvitationList = await callAs(
    aal2(syntheticUsers.owner),
    "select public.get_member_invitations(50)",
  );
  check("admin list sees the exact same-chapter invitation only",
    listedInvitations.code === ""
      && listedInvitations.rows?.[0]?.result?.chapter?.id === "wor"
      && listedInvitations.rows?.[0]?.result?.items?.some((row) => row.id === lifecycleId)
      && !foreignInvitationList.rows?.[0]?.result?.items?.some((row) => row.id === lifecycleId),
    "target admin sees id; foreign admin does not",
    `${listedInvitations.code || "success"} / ${foreignInvitationList.code || "success"}`);
  check("ordinary member cannot list invitations",
    memberInvitationList.code === "42501", "42501", memberInvitationList.code || "success");

  const deliveryRecorded = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.record_member_invitation_delivery($1, 1, 'sent') as result",
    [lifecycleId],
  );
  check("same-chapter admin records delivery through the audited RPC",
    deliveryRecorded.code === "" && deliveryRecorded.rows?.[0]?.result?.recorded === true,
    "recorded", deliveryRecorded.code || JSON.stringify(deliveryRecorded.rows?.[0]?.result || null));
  const foreignResend = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.resend_member_invitation($1, $2) as result",
    [lifecycleId, "aa".repeat(32)],
  );
  const foreignRevoke = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.revoke_member_invitation($1) as result",
    [lifecycleId],
  );
  const [afterForeignInvitationMutations] = await q(
    "select status, delivery_version, token_hash from public.member_invitations where id = $1",
    [lifecycleId],
  );
  check("foreign admin resend/revoke are anti-enumerating no-ops without mutation",
    foreignResend.code === "" && foreignResend.rows?.[0]?.result?.send === false
      && foreignRevoke.code === "" && foreignRevoke.rows?.[0]?.result?.revoked === false
      && afterForeignInvitationMutations?.status === "pending"
      && afterForeignInvitationMutations?.delivery_version === 1
      && afterForeignInvitationMutations?.token_hash === invitationHashes[0],
    "uniform no-op and unchanged row",
    `${JSON.stringify(foreignResend.rows?.[0]?.result || null)} / ${JSON.stringify(foreignRevoke.rows?.[0]?.result || null)} / ${JSON.stringify(afterForeignInvitationMutations || null)}`);

  const resentInvitation = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.resend_member_invitation($1, $2) as result",
    [lifecycleId, "bb".repeat(32)],
  );
  const replacementId = resentInvitation.rows?.[0]?.result?.invitationId;
  const revokedInvitation = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.revoke_member_invitation($1) as result",
    [replacementId],
  );
  const [lifecycleRows] = await q(
    `select count(*) filter (where id = $1 and status = 'superseded' and token_hash is null)::int as old_safe,
            count(*) filter (where id = $2 and status = 'revoked' and token_hash is null)::int as new_safe
       from public.member_invitations`,
    [lifecycleId, replacementId],
  );
  check("same-chapter resend supersedes the old digest and revoke clears the new digest",
    resentInvitation.code === "" && Boolean(replacementId)
      && revokedInvitation.code === "" && revokedInvitation.rows?.[0]?.result?.revoked === true
      && lifecycleRows.old_safe === 1 && lifecycleRows.new_safe === 1,
    "superseded old row and revoked replacement, both digest-free",
    `${resentInvitation.code || String(replacementId)} / ${JSON.stringify(lifecycleRows)}`);

  const replayCreate = await createProbeInvitation(invitationEmails[1], invitationHashes[1]);
  const firstClaim = await callServiceKeeping(
    "select public.claim_member_invitation($1) as result",
    [invitationHashes[1]],
  );
  const replayClaim = await callServiceKeeping(
    "select public.claim_member_invitation($1) as result",
    [invitationHashes[1]],
  );
  check("serialized claim makes an in-flight invitation unavailable to replay",
    replayCreate.code === ""
      && firstClaim.code === "" && firstClaim.rows?.[0]?.result?.available === true
      && replayClaim.code === "" && replayClaim.rows?.[0]?.result?.available === false,
    "first available, replay unavailable",
    `${JSON.stringify(firstClaim.rows?.[0]?.result || null)} / ${JSON.stringify(replayClaim.rows?.[0]?.result || null)}`);

  const expiryCreate = await createProbeInvitation(invitationEmails[2], invitationHashes[2]);
  const expiryId = expiryCreate.rows?.[0]?.result?.invitationId;
  await client.query("update public.member_invitations set expires_at = now() - interval '1 second' where id = $1", [expiryId]);
  const expiredClaim = await callServiceKeeping(
    "select public.claim_member_invitation($1) as result",
    [invitationHashes[2]],
  );
  const [expiredInvitation] = await q(
    "select status, token_hash from public.member_invitations where id = $1",
    [expiryId],
  );
  check("expired invitation claim fails closed and destroys its digest",
    expiredClaim.code === "" && expiredClaim.rows?.[0]?.result?.available === false
      && expiredInvitation?.status === "expired" && expiredInvitation?.token_hash === null,
    "unavailable expired row with no digest",
    `${JSON.stringify(expiredClaim.rows?.[0]?.result || null)} / ${JSON.stringify(expiredInvitation || null)}`);

  const finalizeCreate = await createProbeInvitation(invitationEmails[3], invitationHashes[3], "advisor");
  const finalizeId = finalizeCreate.rows?.[0]?.result?.invitationId;
  const finalizeClaim = await callServiceKeeping(
    "select public.claim_member_invitation($1) as result",
    [invitationHashes[3]],
  );
  await client.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       is_sso_user, is_anonymous
     ) values (
       '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
       $2, '', '', '', '', '',
       '{"provider":"email","providers":["email"]}', $3::jsonb,
       now(), now(), false, false
     )`,
    [syntheticUsers.invited, invitationEmails[3], JSON.stringify({
      first_name: "RPC", full_name: "RPC Probe Invitee", initials: "RP",
      chapter_id: "wor", union_base_invitation_id: finalizeId,
    })],
  );
  const finalizedInvitation = await callServiceKeeping(
    "select public.finalize_member_invitation($1, $2) as result",
    [finalizeId, syntheticUsers.invited],
  );
  const finalReplay = await callServiceKeeping(
    "select public.claim_member_invitation($1) as result",
    [invitationHashes[3]],
  );
  const [finalizedState] = await q(
    `select i.status, i.token_hash, i.auth_user_id, p.chapter_id,
            exists(select 1 from public.member_roles r where r.user_id = $2 and r.role = 'advisor' and r.chapter_id = 'wor') as advisor
       from public.member_invitations i
       join public.member_profiles p on p.id = $2
      where i.id = $1`,
    [finalizeId, syntheticUsers.invited],
  );
  check("finalize binds the exact Auth identity, chapter profile, and allowlisted role once",
    finalizeClaim.code === "" && finalizeClaim.rows?.[0]?.result?.available === true
      && finalizedInvitation.code === "" && finalizedInvitation.rows?.[0]?.result?.accepted === true
      && finalizedState?.status === "accepted" && finalizedState?.token_hash === null
      && finalizedState?.auth_user_id === syntheticUsers.invited
      && finalizedState?.chapter_id === "wor" && finalizedState?.advisor === true
      && finalReplay.rows?.[0]?.result?.available === false,
    "accepted exact user/profile/advisor and replay unavailable",
    `${finalizedInvitation.code || JSON.stringify(finalizedInvitation.rows?.[0]?.result || null)} / ${JSON.stringify(finalizedState || null)} / ${JSON.stringify(finalReplay.rows?.[0]?.result || null)}`);

  let rateLimitedCreate = null;
  for (let attempt = 0; attempt < 10 && !rateLimitedCreate; attempt += 1) {
    const outcome = await callAsKeeping(
      aal2(syntheticUsers.staff),
      "select public.create_member_invitation('rpc-probe-owner@example.test', 'Existing Identity', 'wor', null, 'en', $1)",
      [(10 + attempt).toString(16).padStart(2, "0").repeat(32)],
    );
    if (outcome.code) rateLimitedCreate = outcome;
  }
  check("persisted admin invitation rate limit also counts anti-enumerating no-ops",
    rateLimitedCreate?.code === "P0001", "P0001", rateLimitedCreate?.code || "no refusal");

  const acceptLimitOutcomes = [];
  for (let attempt = 0; attempt < 21; attempt += 1) {
    acceptLimitOutcomes.push(await callServiceKeeping(
      "select public.consume_member_invitation_accept_limit($1) as result",
      ["ef".repeat(32)],
    ));
  }
  check("persisted anonymous accept throttle allows twenty attempts then refuses",
    acceptLimitOutcomes.slice(0, 20).every((row) => row.code === "" && row.rows?.[0]?.result?.allowed === true)
      && acceptLimitOutcomes[20]?.rows?.[0]?.result?.allowed === false,
    "20 allowed then false", JSON.stringify(acceptLimitOutcomes.map((row) => row.code || row.rows?.[0]?.result?.allowed)));

  const [invitationAuditPrivacy] = await q(
    `select count(*)::int as entries,
            not exists (
              select 1
                from public.member_invitation_audit a,
                     lateral pg_catalog.jsonb_object_keys(a.detail) key_name
               where a.invitation_id in (select id from public.member_invitations where normalized_email = any($1::text[]))
                 and pg_catalog.lower(key_name) in ('email','normalizedemail','token','tokenhash','secret','actionlink','providerbody')
            ) as safe
       from public.member_invitation_audit
      where invitation_id in (select id from public.member_invitations where normalized_email = any($1::text[]))`,
    [invitationEmails],
  );
  check("invitation lifecycle audit is populated without email or secret keys",
    invitationAuditPrivacy.entries > 0 && invitationAuditPrivacy.safe === true,
    "non-empty safe audit", JSON.stringify(invitationAuditPrivacy));

  // 15. UB-IDN-02: operator-assisted address recovery stays a two-boundary
  // operation. Auth owns the address and global logout; these RPCs authorize,
  // serialize, bind the exact resulting Auth digest, and audit closed facts.
  const recoveryEmail = "rpc-probe-owner-recovered@example.test";
  const failureRecoveryEmail = "rpc-probe-invite-recovered@example.test";
  const retryRecoveryEmail = "rpc-probe-invite-retry@example.test";
  const [recoveryDigests] = await q(
    `select
       pg_catalog.encode(extensions.digest($1::text, 'sha256'), 'hex') as completed_hash,
       pg_catalog.encode(extensions.digest($2::text, 'sha256'), 'hex') as failure_hash,
       pg_catalog.encode(extensions.digest($3::text, 'sha256'), 'hex') as retry_hash,
       pg_catalog.encode(extensions.digest('rpc-probe-staff@example.test', 'sha256'), 'hex') as occupied_hash`,
    [recoveryEmail, failureRecoveryEmail, retryRecoveryEmail],
  );
  await client.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), $1, 'probe-recovery-totp', 'totp', 'verified', now(), now())`,
    [syntheticUsers.staff],
  );

  const privateRecoveryRead = await callAs(
    aal2(syntheticUsers.staff),
    "select id from private.member_signin_recoveries limit 1",
  );
  check("sign-in recovery ledger remains private from authenticated admins",
    privateRecoveryRead.code === "42501", "42501", privateRecoveryRead.code || "success");
  const aal1RecoverySearch = await callAs(
    aal1(syntheticUsers.staff),
    "select public.admin_search_recovery_members('Probe') as result",
  );
  check("aal1 admin with enrolled TOTP cannot search recovery targets",
    aal1RecoverySearch.code === "42501", "42501", aal1RecoverySearch.code || "success");
  const ordinaryRecoverySearch = await callAs(
    aal2(syntheticUsers.owner),
    "select public.admin_search_recovery_members('Probe') as result",
  );
  const ordinaryRecoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.owner),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.staff, recoveryDigests.completed_hash],
  );
  check("ordinary member cannot search or begin sign-in recovery",
    ordinaryRecoverySearch.code === "42501" && ordinaryRecoveryBegin.code === "42501",
    "42501 / 42501", `${ordinaryRecoverySearch.code || "success"} / ${ordinaryRecoveryBegin.code || "success"}`);
  const foreignRecoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.owner, recoveryDigests.completed_hash],
  );
  check("foreign admin cannot begin recovery for another chapter",
    foreignRecoveryBegin.code === "42501", "42501", foreignRecoveryBegin.code || "success");
  const selfRecoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.staff, recoveryDigests.completed_hash],
  );
  check("admin cannot recover their own sign-in address",
    selfRecoveryBegin.code === "42501", "42501", selfRecoveryBegin.code || "success");

  const recoverySearch = await callAs(
    aal2(syntheticUsers.staff),
    "select public.admin_search_recovery_members('Probe Owner') as result",
  );
  const foreignRecoverySearch = await callAs(
    aal2(syntheticUsers.foreignStaff),
    "select public.admin_search_recovery_members('Probe Owner') as result",
  );
  const recoverySearchRows = recoverySearch.rows?.[0]?.result ?? [];
  check("same-chapter name-only recovery search omits every email",
    recoverySearch.code === "" && recoverySearchRows.length === 1
      && recoverySearchRows[0]?.userId === syntheticUsers.owner
      && !/email|@/i.test(JSON.stringify(recoverySearchRows))
      && foreignRecoverySearch.code === "" && foreignRecoverySearch.rows?.[0]?.result?.length === 0,
    "one same-chapter target, no address fields, empty foreign result",
    `${JSON.stringify(recoverySearchRows)} / ${JSON.stringify(foreignRecoverySearch.rows?.[0]?.result ?? null)}`);
  const [deniedRecoveryMutation] = await q(
    `select
       (select count(*)::int from private.member_signin_recoveries
         where actor = $1 or target_user = any($2::uuid[])) as operations,
       (select count(*)::int from public.member_admin_audit
         where actor = $1 and target_user = any($2::uuid[])
           and action in ('recover_signin_address', 'recover_signin_address_failed')) as audits`,
    [syntheticUsers.staff, [syntheticUsers.owner, syntheticUsers.invited]],
  );
  check("denied recovery callers leave no operation or audit mutation",
    deniedRecoveryMutation.operations === 0 && deniedRecoveryMutation.audits === 0,
    "0 operations and 0 audits", JSON.stringify(deniedRecoveryMutation));

  const recoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.owner, recoveryDigests.completed_hash],
  );
  const recoveryOperationId = recoveryBegin.rows?.[0]?.result?.operationId;
  const recoveryRetry = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.owner, recoveryDigests.completed_hash],
  );
  const [serializedRecovery] = await q(
    `select count(*)::int as rows, min(attempts)::int as attempts
       from private.member_signin_recoveries
      where target_user = $1 and status = 'changing'`,
    [syntheticUsers.owner],
  );
  check("exact same-target recovery retry returns one serialized operation",
    recoveryBegin.code === "" && Boolean(recoveryOperationId)
      && recoveryRetry.code === "" && recoveryRetry.rows?.[0]?.result?.retry === true
      && recoveryRetry.rows?.[0]?.result?.operationId === recoveryOperationId
      && serializedRecovery.rows === 1 && serializedRecovery.attempts === 2,
    "one operation id with two attempts",
    `${JSON.stringify(recoveryBegin.rows?.[0]?.result ?? null)} / ${JSON.stringify(recoveryRetry.rows?.[0]?.result ?? null)} / ${JSON.stringify(serializedRecovery)}`);

  const finalizeWithoutLogout = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.finalize_member_signin_recovery($1, false) as result",
    [recoveryOperationId],
  );
  const finalizeBeforeAuth = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.finalize_member_signin_recovery($1, true) as result",
    [recoveryOperationId],
  );
  check("recovery cannot finalize before exact Auth digest and session-revocation proof",
    finalizeWithoutLogout.code === "42501" && finalizeBeforeAuth.code === "22023",
    "42501 without logout and 22023 before Auth change",
    `${finalizeWithoutLogout.code || "success"} / ${finalizeBeforeAuth.code || "success"}`);
  const foreignRecoveryFinalize = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.finalize_member_signin_recovery($1, true) as result",
    [recoveryOperationId],
  );
  check("foreign admin cannot finalize another admin's recovery operation",
    foreignRecoveryFinalize.code === "42501", "42501", foreignRecoveryFinalize.code || "success");

  await client.query("update auth.users set email = $1, updated_at = now() where id = $2", [recoveryEmail, syntheticUsers.owner]);
  const recoveryFinalize = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.finalize_member_signin_recovery($1, true) as result",
    [recoveryOperationId],
  );
  const recoveryFinalizeReplay = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.finalize_member_signin_recovery($1, true) as result",
    [recoveryOperationId],
  );
  const [completedRecovery] = await q(
    `select r.status, r.new_email_hash, r.completed_at is not null as completed,
            count(a.id)::int as audit_rows
       from private.member_signin_recoveries r
       left join public.member_admin_audit a
         on a.actor = r.actor and a.target_user = r.target_user and a.action = 'recover_signin_address'
      where r.id = $1
      group by r.id`,
    [recoveryOperationId],
  );
  check("exact Auth address plus session revocation finalizes once",
    recoveryFinalize.code === "" && recoveryFinalize.rows?.[0]?.result?.completed === true
      && recoveryFinalizeReplay.code === "42501"
      && completedRecovery?.status === "completed" && completedRecovery?.completed === true
      && completedRecovery?.new_email_hash === recoveryDigests.completed_hash
      && completedRecovery?.audit_rows === 1,
    "one completed operation and one audit row",
    `${recoveryFinalize.code || JSON.stringify(recoveryFinalize.rows?.[0]?.result ?? null)} / ${recoveryFinalizeReplay.code || "success"} / ${JSON.stringify(completedRecovery ?? null)}`);

  const occupiedRecovery = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'address_retired') as result",
    [syntheticUsers.owner, recoveryDigests.occupied_hash],
  );
  const [ownerRecoveryCount] = await q(
    "select count(*)::int as rows from private.member_signin_recoveries where target_user = $1",
    [syntheticUsers.owner],
  );
  check("occupied address is refused without revealing the conflicting identity",
    occupiedRecovery.code === "22023" && occupiedRecovery.message === "recovery unavailable"
      && ownerRecoveryCount.rows === 1,
    "generic 22023 and no new operation",
    `${occupiedRecovery.code || "success"} ${occupiedRecovery.message || ""} / ${ownerRecoveryCount.rows}`);

  const failureRecoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'address_retired') as result",
    [syntheticUsers.invited, recoveryDigests.failure_hash],
  );
  const failureOperationId = failureRecoveryBegin.rows?.[0]?.result?.operationId;
  const invalidRecoveryFailure = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.fail_member_signin_recovery($1, 'provider_body') as result",
    [failureOperationId],
  );
  const foreignRecoveryFailure = await callAsKeeping(
    aal2(syntheticUsers.foreignStaff),
    "select public.fail_member_signin_recovery($1, 'auth_unavailable') as result",
    [failureOperationId],
  );
  const recoveryFailure = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.fail_member_signin_recovery($1, 'address_unavailable') as result",
    [failureOperationId],
  );
  const [failedRecovery] = await q(
    `select r.status, r.failure_code,
            count(a.id)::int as audit_rows,
            not pg_catalog.bool_or(
              pg_catalog.lower(a.detail::text) like '%email%'
              or pg_catalog.lower(a.detail::text) like '%provider%'
              or a.detail::text like '%@%'
            ) as audit_safe
       from private.member_signin_recoveries r
       join public.member_admin_audit a
         on a.actor = r.actor and a.target_user = r.target_user and a.action = 'recover_signin_address_failed'
      where r.id = $1
      group by r.id`,
    [failureOperationId],
  );
  check("recovery failure accepts only closed codes and audits without email data",
    failureRecoveryBegin.code === "" && invalidRecoveryFailure.code === "22023"
      && foreignRecoveryFailure.code === "42501"
      && recoveryFailure.code === "" && recoveryFailure.rows?.[0]?.result?.completed === false
      && failedRecovery?.status === "failed" && failedRecovery?.failure_code === "address_unavailable"
      && failedRecovery?.audit_rows === 1 && failedRecovery?.audit_safe === true,
    "closed failure, one address-free audit row",
    `${invalidRecoveryFailure.code || "success"} / ${foreignRecoveryFailure.code || "success"} / ${JSON.stringify(failedRecovery ?? null)}`);

  const rateRecoveryBegin = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.invited, recoveryDigests.retry_hash],
  );
  const rateRecoveryRetry = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.invited, recoveryDigests.retry_hash],
  );
  const rateRecoveryDenied = await callAsKeeping(
    aal2(syntheticUsers.staff),
    "select public.begin_member_signin_recovery($1, $2, 'lost_inbox') as result",
    [syntheticUsers.invited, recoveryDigests.retry_hash],
  );
  const [recoveryLimits] = await q(
    `select
       max(request_count) filter (where operation = 'admin-hour')::int as admin_count,
       max(request_count) filter (where operation = 'target-day')::int as target_count
     from private.member_signin_recovery_limits
     where scope_key in ($1, $2)`,
    [`admin:${syntheticUsers.staff}`, `target:${syntheticUsers.invited}`],
  );
  check("persisted recovery limits refuse the sixth admin attempt",
    rateRecoveryBegin.code === "" && rateRecoveryRetry.code === ""
      && rateRecoveryDenied.code === "P0001"
      && recoveryLimits?.admin_count === 5 && recoveryLimits?.target_count === 3,
    "five admin attempts and three target attempts, then P0001",
    `${rateRecoveryDenied.code || "success"} / ${JSON.stringify(recoveryLimits ?? null)}`);

  const [recoveryAuditPrivacy] = await q(
    `select count(*)::int as entries,
            not exists (
              select 1
               from public.member_admin_audit a,
                     lateral pg_catalog.jsonb_object_keys(a.detail) key_name
               where a.actor = $1 and a.target_user = any($2::uuid[])
                 and a.action in ('recover_signin_address', 'recover_signin_address_failed')
                 and pg_catalog.lower(key_name) in ('email', 'newemail', 'new_email_hash', 'provider', 'providerbody')
            )
            and not exists (
              select 1 from public.member_admin_audit a
               where a.actor = $1 and a.target_user = any($2::uuid[])
                 and a.action in ('recover_signin_address', 'recover_signin_address_failed')
                 and (a.detail::text like '%@%' or a.detail::text like '%' || $3 || '%')
            ) as safe
       from public.member_admin_audit
      where actor = $1 and target_user = any($2::uuid[])
        and action in ('recover_signin_address', 'recover_signin_address_failed')`,
    [syntheticUsers.staff, [syntheticUsers.owner, syntheticUsers.invited], recoveryEmail],
  );
  check("completed and failed recovery audit contains closed facts but no address or digest",
    recoveryAuditPrivacy.entries === 2 && recoveryAuditPrivacy.safe === true,
    "two safe audit rows", JSON.stringify(recoveryAuditPrivacy));

  async function runMemberSessionProbes() {
  // 16. UB-IDN-05 / UB-SET-05: the vendor Auth row is the session boundary,
  // while push registrations carry only its opaque digest. Every write stays
  // in the outer transaction and every denial uses a per-probe savepoint.
  const [sessionHandles] = await q(
    `select
       private.member_session_handle($1) as owner_current,
       private.member_session_handle($2) as owner_remote,
       private.member_session_handle($3) as owner_expired,
       private.member_session_handle($4) as foreign_current,
       private.member_session_handle($5) as foreign_remote`,
    [
      syntheticSessions.ownerCurrent,
      syntheticSessions.ownerRemote,
      syntheticSessions.ownerExpired,
      syntheticSessions.foreignCurrent,
      syntheticSessions.foreignRemote,
    ],
  );
  const ownerSessionClaims = aal1Session(syntheticUsers.owner, syntheticSessions.ownerCurrent);
  const staffSessionClaims = { ...aal2(syntheticUsers.staff), session_id: syntheticSessions.staffCurrent };
  const foreignSessionClaims = aal1Session(syntheticUsers.foreignMember, syntheticSessions.foreignCurrent);
  const foreignRemoteSessionClaims = aal1Session(syntheticUsers.foreignMember, syntheticSessions.foreignRemote);

  const privateSessionAudit = await callAs(
    ownerSessionClaims,
    "select user_id from private.member_session_revocations limit 1",
  );
  check("session revocation ledger remains private from authenticated members",
    privateSessionAudit.code === "42501", "42501", privateSessionAudit.code || "success");
  const privateClosingBarrier = await callAs(
    ownerSessionClaims,
    "select user_id from private.member_session_closing_barriers limit 1",
  );
  check("session-closing barrier remains private from authenticated members",
    privateClosingBarrier.code === "42501", "42501", privateClosingBarrier.code || "success");

  const enrolledAal1Sessions = await callAs(
    aal1Session(syntheticUsers.staff, syntheticSessions.staffCurrent),
    "select public.list_my_sessions() as result",
  );
  check("aal1 member with enrolled TOTP cannot list device sessions",
    enrolledAal1Sessions.code === "42501", "42501", enrolledAal1Sessions.code || "success");

  const ownerSessionList = await callAs(ownerSessionClaims, "select public.list_my_sessions() as result");
  const ownerSessionRows = ownerSessionList.rows?.[0]?.result ?? [];
  const foreignSessionList = await callAs(foreignSessionClaims, "select public.list_my_sessions() as result");
  const foreignSessionRows = foreignSessionList.rows?.[0]?.result ?? [];
  const ownerSessionText = JSON.stringify(ownerSessionRows);
  check("no-factor member sees only current and active remote sessions through opaque handles",
    ownerSessionList.code === "" && ownerSessionRows.length === 2
      && ownerSessionRows.filter((row) => row.current).length === 1
      && ownerSessionRows.every((row) => /^[0-9a-f]{64}$/.test(row.handle))
      && !ownerSessionText.includes(sessionHandles.owner_expired),
    "two active self sessions, one current, expired excluded", ownerSessionText);
  check("session inventory never returns raw ids, IPs, or full user agents",
    !/sessionId|userAgent|refreshToken|192\.0\.2\.|00000000-0000-4100/i.test(ownerSessionText),
    "coarse metadata only", ownerSessionText);
  check("foreign member session inventory is independently self-scoped",
    foreignSessionList.code === "" && foreignSessionRows.length === 2
      && foreignSessionRows.every((row) => !ownerSessionRows.some((ownerRow) => ownerRow.handle === row.handle)),
    "two foreign-self rows and no owner handles", JSON.stringify(foreignSessionRows));

  const bindCurrentPush = await callAsKeeping(
    ownerSessionClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-owner-current', 'probe-current-p256dh', 'probe-current-auth')",
  );
  await client.query(
    `insert into public.member_push_subscriptions
       (user_id, endpoint, p256dh, auth_key, session_handle)
     values
       ($1, 'https://fcm.googleapis.com/rpc-probe-owner-remote', 'probe-remote-p256dh', 'probe-remote-auth', $2),
       ($1, 'https://fcm.googleapis.com/rpc-probe-owner-legacy', 'probe-legacy-p256dh', 'probe-legacy-auth', null)`,
    [syntheticUsers.owner, sessionHandles.owner_remote],
  );
  const [boundPush] = await q(
    `select count(*)::int as rows,
            bool_and(session_handle = $2) as bound
       from public.member_push_subscriptions
      where user_id = $1 and endpoint = 'https://fcm.googleapis.com/rpc-probe-owner-current'`,
    [syntheticUsers.owner, sessionHandles.owner_current],
  );
  check("push upsert derives the current opaque session binding",
    bindCurrentPush.code === "" && boundPush.rows === 1 && boundPush.bound === true,
    "one current-bound push row", `${bindCurrentPush.code || "success"} / ${JSON.stringify(boundPush)}`);

  const [beforeDeniedSessionState] = await q(
    `select
       (select count(*)::int from auth.sessions where user_id = $1) as sessions,
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as pushes`,
    [syntheticUsers.owner],
  );
  const currentSessionRevoke = await callAsKeeping(
    ownerSessionClaims,
    "select public.revoke_my_session($1) as result",
    [sessionHandles.owner_current],
  );
  const foreignSessionRevoke = await callAsKeeping(
    ownerSessionClaims,
    "select public.revoke_my_session($1) as result",
    [sessionHandles.foreign_remote],
  );
  const malformedSessionRevoke = await callAsKeeping(
    ownerSessionClaims,
    "select public.revoke_my_session('not-a-session-handle') as result",
  );
  const [afterDeniedSessionState] = await q(
    `select
       (select count(*)::int from auth.sessions where user_id = $1) as sessions,
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as pushes`,
    [syntheticUsers.owner],
  );
  check("current, foreign, and malformed session revokes are refused without mutation",
    currentSessionRevoke.code === "22023"
      && foreignSessionRevoke.code === "22023"
      && malformedSessionRevoke.code === "22023"
      && beforeDeniedSessionState.sessions === afterDeniedSessionState.sessions
      && beforeDeniedSessionState.pushes === afterDeniedSessionState.pushes,
    "22023 each and unchanged counts",
    `${currentSessionRevoke.code}/${foreignSessionRevoke.code}/${malformedSessionRevoke.code} / ${JSON.stringify(beforeDeniedSessionState)} -> ${JSON.stringify(afterDeniedSessionState)}`);

  const selectedSessionRevoke = await callAsKeeping(
    ownerSessionClaims,
    "select public.revoke_my_session($1) as result",
    [sessionHandles.owner_remote],
  );
  const [selectedSessionState] = await q(
    `select
       exists(select 1 from auth.sessions where id = $1) as session_exists,
       exists(select 1 from auth.refresh_tokens where session_id = $1) as refresh_exists,
       count(*) filter (where session_handle = $2 or session_handle is null)::int as unsafe_pushes,
       count(*) filter (where session_handle = $3)::int as current_pushes
     from public.member_push_subscriptions
     where user_id = $4`,
    [syntheticSessions.ownerRemote, sessionHandles.owner_remote, sessionHandles.owner_current, syntheticUsers.owner],
  );
  check("selected remote revoke removes Auth, refresh, target push, and legacy push atomically",
    selectedSessionRevoke.code === ""
      && selectedSessionRevoke.rows?.[0]?.result?.revoked === true
      && selectedSessionState.session_exists === false
      && selectedSessionState.refresh_exists === false
      && selectedSessionState.unsafe_pushes === 0
      && selectedSessionState.current_pushes === 1,
    "remote Auth/refresh/unsafe push gone, current push kept",
    `${JSON.stringify(selectedSessionRevoke.rows?.[0]?.result ?? null)} / ${JSON.stringify(selectedSessionState)}`);

  const exactSessionReplay = await callAsKeeping(
    ownerSessionClaims,
    "select public.revoke_my_session($1) as result",
    [sessionHandles.owner_remote],
  );
  check("exact selected-session replay returns the existing revoked outcome",
    exactSessionReplay.code === ""
      && exactSessionReplay.rows?.[0]?.result?.revoked === true
      && exactSessionReplay.rows?.[0]?.result?.alreadyRevoked === true,
    "revoked true and alreadyRevoked true", JSON.stringify(exactSessionReplay.rows?.[0]?.result ?? null));

  const staleRemoteToken = await callAs(
    aal1Session(syntheticUsers.owner, syntheticSessions.ownerRemote),
    "select public.list_my_sessions() as result",
  );
  check("revoked session JWT cannot reuse the device-session definer RPC",
    staleRemoteToken.code === "42501", "42501", staleRemoteToken.code || "success");

  // Reuse the revoked remote session's opaque handle to model an orphaned
  // remote installation: local cleanup must preserve it, while global cleanup
  // must still remove every installation owned by the caller.
  const nativeInstallations = {
    ownerExact: "00000000-0000-4200-8000-000000000301",
    ownerCurrent: "00000000-0000-4200-8000-000000000302",
    ownerRemote: "00000000-0000-4200-8000-000000000303",
    foreign: "00000000-0000-4200-8000-000000000304",
    ownerGlobalCurrent: "00000000-0000-4200-8000-000000000305",
    ownerAfterLocal: "00000000-0000-4200-8000-000000000306",
    foreignRegistered: "00000000-0000-4200-8000-000000000307",
    unknown: "00000000-0000-4200-8000-000000000399",
  };
  await client.query(
    `insert into public.member_native_push_installations
       (installation_id, user_id, provider, environment, device_token, session_handle)
     values
       ($1, $5, 'fcm', 'production', 'rpc-probe-native-owner-exact-token', $6),
       ($2, $5, 'fcm', 'production', 'rpc-probe-native-owner-current-token', $6),
       ($3, $5, 'fcm', 'production', 'rpc-probe-native-owner-remote-token', $7),
       ($4, $8, 'fcm', 'production', 'rpc-probe-native-foreign-token', $9)`,
    [
      nativeInstallations.ownerExact,
      nativeInstallations.ownerCurrent,
      nativeInstallations.ownerRemote,
      nativeInstallations.foreign,
      syntheticUsers.owner,
      sessionHandles.owner_current,
      sessionHandles.owner_remote,
      syntheticUsers.foreignMember,
      sessionHandles.foreign_remote,
    ],
  );

  const [beforeSignoutIdentityRefusal] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $2) as foreign_native_pushes`,
    [syntheticUsers.owner, syntheticUsers.foreignMember],
  );
  const mismatchedSignoutIdentity = await callAs(
    ownerSessionClaims,
    "select public.prepare_my_signout('local', $1) as result",
    [syntheticUsers.foreignMember],
  );
  const omittedSignoutIdentity = await callAs(
    ownerSessionClaims,
    "select public.prepare_my_signout('local') as result",
  );
  const mismatchedNativeDeleteIdentity = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.ownerExact, syntheticUsers.foreignMember, sessionHandles.owner_current],
  );
  const mismatchedNativeDeleteSession = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.ownerExact, syntheticUsers.owner, sessionHandles.owner_remote],
  );
  const omittedNativeDeleteIdentity = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1) as result",
    [nativeInstallations.ownerExact],
  );
  const foreignNativeDelete = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.foreign, syntheticUsers.owner, sessionHandles.owner_current],
  );
  const unknownNativeDelete = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.unknown, syntheticUsers.owner, sessionHandles.owner_current],
  );
  const replacementSessionNativeDelete = await callAs(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.ownerRemote, syntheticUsers.owner, sessionHandles.owner_current],
  );
  const [afterSignoutIdentityRefusal] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $2) as foreign_native_pushes,
       exists(select 1 from public.member_native_push_installations where installation_id = $3) as owner_exact_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $4) as foreign_exists`,
    [
      syntheticUsers.owner,
      syntheticUsers.foreignMember,
      nativeInstallations.ownerExact,
      nativeInstallations.foreign,
    ],
  );
  check("signout cleanup refuses missing or stale captured account identity before mutation",
    mismatchedSignoutIdentity.code === "42501"
      && omittedSignoutIdentity.code === "42501"
      && mismatchedNativeDeleteIdentity.code === "42501"
      && mismatchedNativeDeleteSession.code === "42501"
      && omittedNativeDeleteIdentity.code === "42501"
      && beforeSignoutIdentityRefusal.web_pushes === afterSignoutIdentityRefusal.web_pushes
      && beforeSignoutIdentityRefusal.native_pushes === afterSignoutIdentityRefusal.native_pushes
      && beforeSignoutIdentityRefusal.foreign_native_pushes === afterSignoutIdentityRefusal.foreign_native_pushes
      && afterSignoutIdentityRefusal.owner_exact_exists === true
      && afterSignoutIdentityRefusal.foreign_exists === true,
    "42501 for omitted/mismatched account or session identities and unchanged owner/foreign push rows",
    `${mismatchedSignoutIdentity.code}/${omittedSignoutIdentity.code}/${mismatchedNativeDeleteIdentity.code}/${mismatchedNativeDeleteSession.code}/${omittedNativeDeleteIdentity.code} / ${JSON.stringify(beforeSignoutIdentityRefusal)} -> ${JSON.stringify(afterSignoutIdentityRefusal)}`);
  check("native push deletion returns uniform false for foreign and unknown installations",
    foreignNativeDelete.code === ""
      && foreignNativeDelete.rows?.[0]?.result?.deleted === false
      && unknownNativeDelete.code === ""
      && unknownNativeDelete.rows?.[0]?.result?.deleted === false
      && replacementSessionNativeDelete.code === ""
      && replacementSessionNativeDelete.rows?.[0]?.result?.deleted === false
      && JSON.stringify(foreignNativeDelete.rows?.[0]?.result)
        === JSON.stringify(unknownNativeDelete.rows?.[0]?.result)
      && afterSignoutIdentityRefusal.owner_exact_exists === true
      && afterSignoutIdentityRefusal.foreign_exists === true,
    "the same deleted=false result and no replacement-session/foreign mutation",
    `${JSON.stringify(foreignNativeDelete.rows?.[0]?.result ?? null)} / ${JSON.stringify(unknownNativeDelete.rows?.[0]?.result ?? null)} / ${JSON.stringify(replacementSessionNativeDelete.rows?.[0]?.result ?? null)} / ${JSON.stringify(afterSignoutIdentityRefusal)}`);

  const exactNativeDelete = await callAsKeeping(
    ownerSessionClaims,
    "select public.delete_my_native_push_installation($1, $2, $3) as result",
    [nativeInstallations.ownerExact, syntheticUsers.owner, sessionHandles.owner_current],
  );
  const [exactNativeDeleteState] = await q(
    `select
       exists(select 1 from public.member_native_push_installations where installation_id = $1) as exact_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $2) as owner_current_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $3) as owner_remote_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $4) as foreign_exists`,
    [
      nativeInstallations.ownerExact,
      nativeInstallations.ownerCurrent,
      nativeInstallations.ownerRemote,
      nativeInstallations.foreign,
    ],
  );
  check("native push deletion removes only the exact caller installation",
    exactNativeDelete.code === ""
      && exactNativeDelete.rows?.[0]?.result?.deleted === true
      && exactNativeDeleteState.exact_exists === false
      && exactNativeDeleteState.owner_current_exists === true
      && exactNativeDeleteState.owner_remote_exists === true
      && exactNativeDeleteState.foreign_exists === true,
    "deleted=true for the exact row while sibling and foreign rows remain",
    `${JSON.stringify(exactNativeDelete.rows?.[0]?.result ?? null)} / ${JSON.stringify(exactNativeDeleteState)}`);

  const localSignoutPreparation = await callAsKeeping(
    ownerSessionClaims,
    "select public.prepare_my_signout('local', $1) as result",
    [syntheticUsers.owner],
  );
  const [localSignoutState] = await q(
    `select
       exists(select 1 from auth.sessions where id = $1) as current_session_exists,
       (select count(*)::int from public.member_push_subscriptions where user_id = $2) as pushes,
       exists(select 1 from public.member_native_push_installations where installation_id = $3) as owner_current_native_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $4) as owner_remote_native_exists,
       exists(select 1 from public.member_native_push_installations where installation_id = $5) as foreign_native_exists`,
    [
      syntheticSessions.ownerCurrent,
      syntheticUsers.owner,
      nativeInstallations.ownerCurrent,
      nativeInstallations.ownerRemote,
      nativeInstallations.foreign,
    ],
  );
  check("local signout preparation removes current push without revoking Auth itself",
    localSignoutPreparation.code === ""
      && localSignoutPreparation.rows?.[0]?.result?.serverCleanupComplete === true
      && localSignoutState.current_session_exists === true
      && localSignoutState.pushes === 0,
    "server cleanup true, Auth current remains, zero push", `${JSON.stringify(localSignoutPreparation.rows?.[0]?.result ?? null)} / ${JSON.stringify(localSignoutState)}`);
  check("local signout preserves remote and foreign native installations",
    localSignoutPreparation.rows?.[0]?.result?.nativePushInstallationsRemoved === 1
      && localSignoutState.owner_current_native_exists === false
      && localSignoutState.owner_remote_native_exists === true
      && localSignoutState.foreign_native_exists === true,
    "current native row removed; remote self and foreign rows preserved",
    `${JSON.stringify(localSignoutPreparation.rows?.[0]?.result ?? null)} / ${JSON.stringify(localSignoutState)}`);

  const localClosedWebRegistration = await callAs(
    ownerSessionClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-owner-current-2', 'probe-current2-p256dh', 'probe-current2-auth')",
  );
  const localClosedNativeRegistration = await callAs(
    ownerSessionClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.ownerCurrent, "rpc-probe-native-owner-current-after-local-token", syntheticUsers.owner, sessionHandles.owner_current],
  );
  const [localBarrierState] = await q(
    `select
       (select count(*)::int from private.member_session_closing_barriers
         where user_id = $1 and session_handle = $2 and scope = 'local') as local_barriers,
       (select count(*)::int from public.member_push_subscriptions
         where user_id = $1 and session_handle = $2) as current_web_pushes,
       (select count(*)::int from public.member_native_push_installations
         where user_id = $1 and session_handle = $2) as current_native_pushes`,
    [syntheticUsers.owner, sessionHandles.owner_current],
  );
  check("local signout barrier refuses current-session web and native re-registration",
    localClosedWebRegistration.code === "42501"
      && localClosedNativeRegistration.code === "42501"
      && localBarrierState.local_barriers === 1
      && localBarrierState.current_web_pushes === 0
      && localBarrierState.current_native_pushes === 0,
    "42501 for both writers, one local barrier, and no current push rows",
    `${localClosedWebRegistration.code || "success"}/${localClosedNativeRegistration.code || "success"} / ${JSON.stringify(localBarrierState)}`);

  await client.query(
    `insert into auth.sessions
       (id, user_id, created_at, updated_at, aal, not_after, refreshed_at, user_agent, ip)
     values
       ($1, $2, now(), now(), 'aal1', now() + interval '6 days', now() at time zone 'UTC',
        'Mozilla/5.0 iPhone Safari/18.0', '192.0.2.16')`,
    [syntheticSessions.ownerAfterLocal, syntheticUsers.owner],
  );
  const [afterLocalSession] = await q(
    "select private.member_session_handle($1) as handle",
    [syntheticSessions.ownerAfterLocal],
  );
  const ownerAfterLocalClaims = aal1Session(
    syntheticUsers.owner,
    syntheticSessions.ownerAfterLocal,
  );
  const afterLocalWebRegistration = await callAsKeeping(
    ownerAfterLocalClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-owner-after-local', 'probe-after-local-p256dh', 'probe-after-local-auth')",
  );
  const afterLocalNativeRegistration = await callAsKeeping(
    ownerAfterLocalClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.ownerAfterLocal, "rpc-probe-native-owner-after-local-token", syntheticUsers.owner, afterLocalSession.handle],
  );
  const [afterLocalRemoteState] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions
         where user_id = $1 and session_handle = $2) as web_pushes,
       (select count(*)::int from public.member_native_push_installations
         where user_id = $1 and session_handle = $2) as native_pushes`,
    [syntheticUsers.owner, afterLocalSession.handle],
  );
  check("local signout barrier preserves registration on another live self session",
    afterLocalWebRegistration.code === ""
      && afterLocalNativeRegistration.code === ""
      && afterLocalNativeRegistration.rows?.[0]?.result?.registered === true
      && afterLocalRemoteState.web_pushes === 1
      && afterLocalRemoteState.native_pushes === 1,
    "web and native registration succeed only on the other self session",
    `${afterLocalWebRegistration.code || "success"}/${JSON.stringify(afterLocalNativeRegistration.rows?.[0]?.result ?? null)} / ${JSON.stringify(afterLocalRemoteState)}`);

  await client.query(
    `insert into public.member_push_subscriptions
       (user_id, endpoint, p256dh, auth_key, session_handle)
     values ($1, 'https://fcm.googleapis.com/rpc-probe-owner-expired', 'probe-expired-p256dh', 'probe-expired-auth', $2)`,
    [syntheticUsers.owner, sessionHandles.owner_expired],
  );
  await client.query(
    `insert into public.member_native_push_installations
       (installation_id, user_id, provider, environment, device_token, session_handle)
     values ($1, $2, 'fcm', 'production', 'rpc-probe-native-owner-global-current-token', $3)`,
    [nativeInstallations.ownerGlobalCurrent, syntheticUsers.owner, sessionHandles.owner_current],
  );
  const globalSignoutPreparation = await callAsKeeping(
    ownerSessionClaims,
    "select public.prepare_my_signout('global', $1) as result",
    [syntheticUsers.owner],
  );
  const [globalSignoutState] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as pushes,
       (select count(*)::int from auth.sessions where user_id = $1) as sessions,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from private.member_session_closing_barriers
         where user_id = $1 and scope = 'global') as global_barriers,
       exists(select 1 from public.member_native_push_installations where installation_id = $2) as foreign_native_exists`,
    [syntheticUsers.owner, nativeInstallations.foreign],
  );
  check("global signout preparation removes every push row before Auth logout",
    globalSignoutPreparation.code === ""
      && globalSignoutPreparation.rows?.[0]?.result?.serverCleanupComplete === true
      && globalSignoutState.pushes === 0
      && globalSignoutState.sessions === 3
      && globalSignoutState.global_barriers === 3,
    "all push gone while three Auth sessions await provider logout behind global barriers",
    `${JSON.stringify(globalSignoutPreparation.rows?.[0]?.result ?? null)} / ${JSON.stringify(globalSignoutState)}`);
  check("global signout removes all caller native installations and preserves foreign installations",
    globalSignoutPreparation.rows?.[0]?.result?.nativePushInstallationsRemoved === 3
      && globalSignoutState.native_pushes === 0
      && globalSignoutState.foreign_native_exists === true,
    "all three caller native rows removed and the foreign row preserved",
    `${JSON.stringify(globalSignoutPreparation.rows?.[0]?.result ?? null)} / ${JSON.stringify(globalSignoutState)}`);

  const globalCurrentWebRegistration = await callAs(
    ownerSessionClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-owner-global-current-web', 'probe-global-current-p256dh', 'probe-global-current-auth')",
  );
  const globalCurrentNativeRegistration = await callAs(
    ownerSessionClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.ownerGlobalCurrent, "rpc-probe-native-owner-global-current-reregister-token", syntheticUsers.owner, sessionHandles.owner_current],
  );
  const globalRemoteWebRegistration = await callAs(
    ownerAfterLocalClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-owner-global-remote-web', 'probe-global-remote-p256dh', 'probe-global-remote-auth')",
  );
  const globalRemoteNativeRegistration = await callAs(
    ownerAfterLocalClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.ownerAfterLocal, "rpc-probe-native-owner-global-remote-reregister-token", syntheticUsers.owner, afterLocalSession.handle],
  );
  const [afterGlobalRefusals] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes`,
    [syntheticUsers.owner],
  );
  check("global signout barrier refuses current and remote self re-registration",
    globalCurrentWebRegistration.code === "42501"
      && globalCurrentNativeRegistration.code === "42501"
      && globalRemoteWebRegistration.code === "42501"
      && globalRemoteNativeRegistration.code === "42501"
      && afterGlobalRefusals.web_pushes === 0
      && afterGlobalRefusals.native_pushes === 0,
    "42501 for both writers on both self sessions and zero recreated rows",
    `${globalCurrentWebRegistration.code || "success"}/${globalCurrentNativeRegistration.code || "success"}/${globalRemoteWebRegistration.code || "success"}/${globalRemoteNativeRegistration.code || "success"} / ${JSON.stringify(afterGlobalRefusals)}`);

  const foreignRegistrationAfterGlobal = await callAsKeeping(
    foreignSessionClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.foreignRegistered, "rpc-probe-native-foreign-after-global-token", syntheticUsers.foreignMember, sessionHandles.foreign_current],
  );
  const foreignWebRegistrationAfterGlobal = await callAsKeeping(
    foreignSessionClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-foreign-after-global', 'probe-foreign-p256dh', 'probe-foreign-auth')",
  );
  check("global signout barrier leaves a foreign live session able to register",
    foreignRegistrationAfterGlobal.code === ""
      && foreignRegistrationAfterGlobal.rows?.[0]?.result?.registered === true
      && foreignWebRegistrationAfterGlobal.code === "",
    "foreign web and native registration succeed without observing the owner's barrier",
    `${foreignWebRegistrationAfterGlobal.code || "web success"} / ${foreignRegistrationAfterGlobal.code || JSON.stringify(foreignRegistrationAfterGlobal.rows?.[0]?.result ?? null)}`);

  const recoveryClaimToken = "b".repeat(64);
  await client.query(
    `insert into public.mfa_recovery_code_sets (user_id, organization_id)
     values ($1, null)
     on conflict (user_id) do update set generation = public.mfa_recovery_code_sets.generation + 1`,
    [syntheticUsers.foreignMember],
  );
  const [recoveryGeneration] = await q(
    "select generation from public.mfa_recovery_code_sets where user_id = $1",
    [syntheticUsers.foreignMember],
  );
  await client.query(
    `insert into public.mfa_recovery_codes
       (user_id, organization_id, generation, code_prefix, code_hash,
        claimed_at, claim_expires_at, claim_token_hash, claim_session_handle)
     values ($1, null, $2, 'ABCDEF12', 'probe-unused-code-hash', now(),
             now() + interval '2 minutes',
             pg_catalog.encode(extensions.digest($3, 'sha256'), 'hex'), $4)`,
    [
      syntheticUsers.foreignMember,
      recoveryGeneration.generation,
      recoveryClaimToken,
      sessionHandles.foreign_current,
    ],
  );
  const [beforeMfaRecoveryCleanup] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from private.member_session_closing_barriers where user_id = $1) as barriers`,
    [syntheticUsers.foreignMember],
  );
  const memberMfaRecoveryCleanup = await callAs(
    foreignSessionClaims,
    "select public.prepare_mfa_recovery_signout($1, $2, $3) as result",
    [syntheticUsers.foreignMember, sessionHandles.foreign_current, recoveryClaimToken],
  );
  const invalidMfaRecoveryCleanup = await callServiceKeeping(
    "select public.prepare_mfa_recovery_signout($1, $2, $3) as result",
    [syntheticUsers.foreignMember, sessionHandles.foreign_current, "c".repeat(64)],
  );
  const otherSessionMfaRecoveryCleanup = await callServiceKeeping(
    "select public.prepare_mfa_recovery_signout($1, $2, $3) as result",
    [syntheticUsers.foreignMember, sessionHandles.foreign_remote, recoveryClaimToken],
  );
  const [afterMfaRecoveryRefusals] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from private.member_session_closing_barriers where user_id = $1) as barriers`,
    [syntheticUsers.foreignMember],
  );
  check("MFA recovery push cleanup requires the service role and exact live claim without mutation",
    memberMfaRecoveryCleanup.code === "42501"
      && invalidMfaRecoveryCleanup.code === "42501"
      && otherSessionMfaRecoveryCleanup.code === "42501"
      && JSON.stringify(beforeMfaRecoveryCleanup) === JSON.stringify(afterMfaRecoveryRefusals),
    "42501 for member, invalid token, and wrong live session with unchanged push/barrier state",
    `${memberMfaRecoveryCleanup.code}/${invalidMfaRecoveryCleanup.code}/${otherSessionMfaRecoveryCleanup.code} / ${JSON.stringify(beforeMfaRecoveryCleanup)} -> ${JSON.stringify(afterMfaRecoveryRefusals)}`);

  await client.query("savepoint revoked_recovery_session");
  await client.query("delete from auth.sessions where id = $1", [syntheticSessions.foreignCurrent]);
  const revokedSessionMfaRecoveryCleanup = await callServiceKeeping(
    "select public.prepare_mfa_recovery_signout($1, $2, $3) as result",
    [syntheticUsers.foreignMember, sessionHandles.foreign_current, recoveryClaimToken],
  );
  await client.query("rollback to savepoint revoked_recovery_session");
  check("MFA recovery refuses the exact bound bearer after its Auth session is revoked",
    revokedSessionMfaRecoveryCleanup.code === "42501",
    "42501 before any service mutation",
    revokedSessionMfaRecoveryCleanup.code || "success");

  const mfaRecoveryCleanup = await callServiceKeeping(
    "select public.prepare_mfa_recovery_signout($1, $2, $3) as result",
    [syntheticUsers.foreignMember, sessionHandles.foreign_current, recoveryClaimToken],
  );
  const [mfaRecoveryCleanupState] = await q(
    `select
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes,
       (select count(*)::int from public.member_native_push_installations where user_id = $1) as native_pushes,
       (select count(*)::int from auth.sessions where user_id = $1) as sessions,
       (select count(*)::int from private.member_session_closing_barriers
         where user_id = $1 and scope = 'global') as global_barriers`,
    [syntheticUsers.foreignMember],
  );
  check("MFA recovery preparation closes every live session and removes all push rows before Auth logout",
    mfaRecoveryCleanup.code === ""
      && mfaRecoveryCleanup.rows?.[0]?.result?.serverCleanupComplete === true
      && mfaRecoveryCleanup.rows?.[0]?.result?.nativePushInstallationsRemoved === 2
      && mfaRecoveryCleanupState.web_pushes === 0
      && mfaRecoveryCleanupState.native_pushes === 0
      && mfaRecoveryCleanupState.sessions === 2
      && mfaRecoveryCleanupState.global_barriers === 2,
    "service cleanup true, all push gone, two Auth sessions retained behind two global barriers",
    `${JSON.stringify(mfaRecoveryCleanup.rows?.[0]?.result ?? null)} / ${JSON.stringify(mfaRecoveryCleanupState)}`);

  const recoveryLockedMfa = await callAs(
    foreignSessionClaims,
    "select private.mfa_satisfied() as value",
  );
  const recoveryLockedInventory = await callAs(
    foreignRemoteSessionClaims,
    "select public.list_my_sessions() as result",
  );
  check("MFA recovery preparation denies every old session before the last factor can disappear",
    recoveryLockedMfa.code === ""
      && recoveryLockedMfa.rows?.[0]?.value === false
      && recoveryLockedInventory.code === "42501",
    "mfa_satisfied=false and protected RPC 42501",
    `${recoveryLockedMfa.code || JSON.stringify(recoveryLockedMfa.rows?.[0] ?? null)} / ${recoveryLockedInventory.code || "success"}`);

  // Administrator MFA-reset is tenant-scoped once
  // 20260917130000_mfa_reset_tenant_scope.sql lands: the target check is
  // c.organization_id = private.current_member_organization(). Shared
  // catalog chapters (wor/bos) cannot be rebound —
  // private.forbid_ownerless_chapter_write refuses legacy reassignment —
  // so this probe inserts its own organization and chapters, then points
  // the existing synthetic admin and member at them. The wrapping
  // savepoint rolls the tenant rows back so later recovery probes still
  // see the stranded lock on the original ownerless chapters.
  const resetTenant = {
    orgA: "00000000-0000-4000-8000-000000000301",
    orgB: "00000000-0000-4000-8000-000000000302",
    adminChapter: "rpc-probe-reset-admin",
    memberChapter: "rpc-probe-reset-member",
    foreignAdminChapter: "rpc-probe-reset-foreign",
  };
  const recoveryObserveSql = `select
       (select count(*)::int from private.member_mfa_recovery_locks
         where user_id = $1) as recovery_locks,
       (select count(*)::int from public.mfa_recovery_codes
         where user_id = $1 and used_at is null and claim_token_hash is not null) as active_claims,
       (select count(*)::int from private.member_mfa_reset_boundaries
         where user_id = $1) as reset_boundaries`;

  async function bindAdminResetTenant({ staffOrgId, memberOrgId, staffChapterId, memberChapterId }) {
    await client.query(
      `insert into public.organizations (id, slug, name, status, created_by) values
         ($1, 'rpc-probe-reset-a', 'RPC Probe Reset A', 'active', $3),
         ($2, 'rpc-probe-reset-b', 'RPC Probe Reset B', 'active', $3)`,
      [resetTenant.orgA, resetTenant.orgB, syntheticUsers.staff],
    );
    await client.query(
      `insert into public.chapters
         (id, name, slug, region, is_default, order_index, organization_id)
       values
         ($1, $1, $1, 'probe', false, 990201, $3),
         ($2, $2, $2, 'probe', false, 990202, $4)`,
      [staffChapterId, memberChapterId, staffOrgId, memberOrgId],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id, status) values
         ($1, $3, 'active'),
         ($2, $4, 'active')`,
      [staffOrgId, memberOrgId, syntheticUsers.staff, syntheticUsers.foreignMember],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status) values
         ($1, $3, 'active'),
         ($2, $4, 'active')`,
      [syntheticUsers.staff, syntheticUsers.foreignMember, staffChapterId, memberChapterId],
    );
    await client.query(
      `update public.member_profiles
          set chapter_id = case when id = $1 then $3 else $4 end
        where id in ($1, $2)`,
      [syntheticUsers.staff, syntheticUsers.foreignMember, staffChapterId, memberChapterId],
    );
    await client.query(
      `insert into public.member_role_chapters (user_id, role, chapter_id) values
         ($1, 'admin', $2)`,
      [syntheticUsers.staff, staffChapterId],
    );
    // Organization-wide recovery authority is the intended same-org path;
    // a chapter-scoped grant on staffChapterId does not reach memberChapterId.
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role) values
         ($1, $2, 'admin')`,
      [staffOrgId, syntheticUsers.staff],
    );
  }

  // No other probe in this script has a catalog-version expectation. Gate
  // the foreign-tenant arm on the tenant predicate in the installed
  // begin_mfa_reset body so Main (no #2114) still reports green.
  const [beginMfaResetDef] = await q(
    "select pg_catalog.pg_get_functiondef('public.begin_mfa_reset(uuid)'::regprocedure) as def",
  );
  const tenantScopedReset = /c\.organization_id\s*=\s*private\.current_member_organization\(\)/.test(
    beginMfaResetDef?.def ?? "",
  );

  await client.query("savepoint admin_reset_same_org");
  await bindAdminResetTenant({
    staffOrgId: resetTenant.orgA,
    memberOrgId: resetTenant.orgA,
    staffChapterId: resetTenant.adminChapter,
    memberChapterId: resetTenant.memberChapter,
  });
  const adminRecoveryReconciliation = await callAsThenObserve(
    staffSessionClaims,
    "select public.begin_mfa_reset($1) as result",
    [syntheticUsers.foreignMember],
    recoveryObserveSql,
    [syntheticUsers.foreignMember],
  );
  await client.query("rollback to savepoint admin_reset_same_org");
  const adminRecoveryState = {
    ...(adminRecoveryReconciliation.rows?.[0] ?? {}),
    ...(adminRecoveryReconciliation.observed?.[0] ?? {}),
  };
  check("authorized administrator reset reconciles a stranded self-recovery lock behind a newer session boundary",
    adminRecoveryReconciliation.code === ""
      && adminRecoveryState?.result?.staleSessionsBlocked === true
      && adminRecoveryState?.result?.recoveryLockReleased === true
      && adminRecoveryState?.recovery_locks === 0
      && adminRecoveryState?.active_claims === 0
      && adminRecoveryState?.reset_boundaries === 1,
    "boundary present, abandoned claim invalidated, and recovery lock released",
    adminRecoveryReconciliation.code
      ? `${adminRecoveryReconciliation.code} ${adminRecoveryReconciliation.message || ""}`.trim()
      : JSON.stringify(adminRecoveryState ?? null));

  await client.query("savepoint admin_reset_cross_org");
  await bindAdminResetTenant({
    staffOrgId: resetTenant.orgB,
    memberOrgId: resetTenant.orgA,
    staffChapterId: resetTenant.foreignAdminChapter,
    memberChapterId: resetTenant.memberChapter,
  });
  const foreignOrgRecovery = await callAsThenObserve(
    staffSessionClaims,
    "select public.begin_mfa_reset($1) as result",
    [syntheticUsers.foreignMember],
    recoveryObserveSql,
    [syntheticUsers.foreignMember],
  );
  const foreignOrgRecoveryCounts = foreignOrgRecovery.observed?.[0]
    ?? (await q(recoveryObserveSql, [syntheticUsers.foreignMember]))[0];
  await client.query("rollback to savepoint admin_reset_cross_org");
  const foreignOrgRefused = foreignOrgRecovery.code === "42501"
    && /unknown member/i.test(foreignOrgRecovery.message || "")
    && foreignOrgRecoveryCounts?.recovery_locks === 1
    && foreignOrgRecoveryCounts?.active_claims === 1
    && foreignOrgRecoveryCounts?.reset_boundaries === 0;
  // expected-to-fail-until-#2114: Main begin_mfa_reset has no tenant
  // predicate, so a different-organization admin still reaches the target.
  // Require the RPC to be reachable as an admin (success, or the #2114
  // refusal) so a fixture bug that raises 'admin role required' still fails.
  const foreignOrgReachable = foreignOrgRecovery.code === ""
    || (foreignOrgRecovery.code === "42501"
      && /unknown member/i.test(foreignOrgRecovery.message || ""));
  // A green line is all an operator reads, so the NAME has to describe the
  // catalog this run actually met. On a pre-#2114 catalog the foreign-
  // organization reset is not refused — it succeeds, writing a boundary for a
  // member of another organization — and a green "is refused" line would
  // assert the opposite of what the same run observed.
  const foreignOrgCheckName = tenantScopedReset
    ? "foreign-organization administrator reset is refused without mutating recovery state"
    : "foreign-organization administrator reset still reaches its target (pre-#2114 catalog, expected-to-fail-until-#2114)";
  check(foreignOrgCheckName,
    tenantScopedReset ? foreignOrgRefused : foreignOrgReachable,
    tenantScopedReset
      ? "42501 unknown member, lock/claim/boundary counts unchanged"
      : "expected-to-fail-until-#2114 (begin_mfa_reset has no tenant predicate)",
    foreignOrgRecovery.code
      ? `${foreignOrgRecovery.code} ${foreignOrgRecovery.message || ""}`.trim()
        + ` / ${JSON.stringify(foreignOrgRecoveryCounts ?? null)}`
      : JSON.stringify({
        ...(foreignOrgRecovery.rows?.[0] ?? {}),
        ...(foreignOrgRecoveryCounts ?? {}),
        tenantScopedReset,
      }));

  const recoveryCurrentRegistration = await callAs(
    foreignSessionClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-recovery-current', 'probe-recovery-current-p256dh', 'probe-recovery-current-auth')",
  );
  const recoveryRemoteRegistration = await callAs(
    foreignRemoteSessionClaims,
    "select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result",
    [nativeInstallations.foreignRegistered, "rpc-probe-native-recovery-remote-token", syntheticUsers.foreignMember, sessionHandles.foreign_remote],
  );
  check("MFA recovery barriers refuse current and remote push recreation while Auth logout is pending",
    recoveryCurrentRegistration.code === "42501"
      && recoveryRemoteRegistration.code === "42501",
    "42501 for both live sessions",
    `${recoveryCurrentRegistration.code || "success"}/${recoveryRemoteRegistration.code || "success"}`);

  // Model the successful external GoTrue global logout, then prove that only
  // exact-claim finalization releases the all-session MFA lock. A subsequent
  // clean sign-in may lazily retire the now-orphaned push barriers.
  await client.query("delete from auth.sessions where user_id = $1", [syntheticUsers.foreignMember]);
  const mfaRecoveryFinalize = await callServiceKeeping(
    "select public.finalize_mfa_recovery_code($1, $2) as result",
    [syntheticUsers.foreignMember, recoveryClaimToken],
  );
  const [mfaRecoveryFinalizedState] = await q(
    `select
       (select count(*)::int from private.member_mfa_recovery_locks where user_id = $1) as recovery_locks,
       (select count(*)::int from public.mfa_recovery_codes
         where user_id = $1 and used_at is not null) as consumed_codes`,
    [syntheticUsers.foreignMember],
  );
  check("exact MFA recovery finalization consumes the code and releases its recovery lock",
    mfaRecoveryFinalize.code === ""
      && mfaRecoveryFinalize.rows?.[0]?.result === true
      && mfaRecoveryFinalizedState.recovery_locks === 0
      && mfaRecoveryFinalizedState.consumed_codes === 1,
    "finalized=true, one consumed code, and no recovery lock",
    `${mfaRecoveryFinalize.code || JSON.stringify(mfaRecoveryFinalize.rows?.[0] ?? null)} / ${JSON.stringify(mfaRecoveryFinalizedState)}`);

  await client.query(
    `insert into auth.sessions
       (id, user_id, created_at, updated_at, aal, not_after, refreshed_at, user_agent, ip)
     values
       ($1, $2, now(), now(), 'aal1', now() + interval '6 days', now() at time zone 'UTC',
        'Mozilla/5.0 Android Chrome/140.0', '192.0.2.17')`,
    [syntheticSessions.foreignAfterRecovery, syntheticUsers.foreignMember],
  );
  const freshRecoveryClaims = aal1Session(
    syntheticUsers.foreignMember,
    syntheticSessions.foreignAfterRecovery,
  );
  const freshRecoveryRegistration = await callAsKeeping(
    freshRecoveryClaims,
    "select public.upsert_push_subscription('https://fcm.googleapis.com/rpc-probe-recovery-fresh', 'probe-recovery-fresh-p256dh', 'probe-recovery-fresh-auth')",
  );
  const [freshRecoveryState] = await q(
    `select
       (select count(*)::int from private.member_session_closing_barriers where user_id = $1) as barriers,
       (select count(*)::int from public.member_push_subscriptions where user_id = $1) as web_pushes`,
    [syntheticUsers.foreignMember],
  );
  check("a clean post-recovery session can retire orphaned push barriers and register again",
    freshRecoveryRegistration.code === ""
      && freshRecoveryState.barriers === 0
      && freshRecoveryState.web_pushes === 1,
    "registration succeeds with zero stale barriers and one current push row",
    `${freshRecoveryRegistration.code || "success"} / ${JSON.stringify(freshRecoveryState)}`);
  }

  async function runWorkloadIntelligenceProbes() {
    const workloadId = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const localUsers = Array.from({ length: 25 }, (_, index) => workloadId(index + 1));
    const foreignMember = workloadId(26);
    const foreignStaff = workloadId(27);
    const mismatchedStaff = workloadId(28);
    const allUsers = [...localUsers, foreignMember, foreignStaff, mismatchedStaff];
    const localChapter = "wkl-probe-a";
    const foreignChapter = "wkl-probe-b";

    await client.query(
      `insert into public.chapters (id, name, region, is_default, order_index) values
         ($1, 'Workload Probe A', 'probe', false, 990001),
         ($2, 'Workload Probe B', 'probe', false, 990002)`,
      [localChapter, foreignChapter],
    );
    await client.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         is_sso_user, is_anonymous)
       select
         '00000000-0000-0000-0000-000000000000', fixture.user_id,
         'authenticated', 'authenticated', fixture.email, '', pg_catalog.now(),
         '', '', '', '',
         '{"provider":"email","providers":["email"]}'::jsonb,
         pg_catalog.jsonb_build_object(
           'first_name', 'Workload', 'full_name', fixture.full_name,
           'initials', fixture.initials, 'chapter_id', fixture.chapter_id),
         pg_catalog.now(), pg_catalog.now(), false, false
       from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
         as fixture(user_id, email, full_name, initials, chapter_id)`,
      [
        allUsers,
        allUsers.map((_, index) => `rpc-probe-workload-${index + 1}@example.test`),
        allUsers.map((_, index) => `Workload Probe ${index + 1}`),
        allUsers.map((_, index) => `W${index + 1}`),
        allUsers.map((_, index) => index < 25 ? localChapter : foreignChapter),
      ],
    );
    await client.query(
      `insert into public.member_roles (user_id, role, chapter_id) values
         ($1, 'steward', $4), ($2, 'steward', $4), ($3, 'steward', $5),
         ($6, 'steward', $4)`,
      [localUsers[0], localUsers[1], foreignStaff, localChapter, foreignChapter, mismatchedStaff],
    );
    await addProbeTotp(localUsers[0], "workload-local");
    await addProbeTotp(foreignStaff, "workload-foreign");
    await addProbeTotp(mismatchedStaff, "workload-mismatched");

    await client.query(
      `with cohort as (
         select user_id, ord::integer as value
         from pg_catalog.unnest($1::uuid[]) with ordinality as members(user_id, ord)
       ), boundary as (
         select (pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'America/New_York')
           - interval '3 months') at time zone 'America/New_York' as quarter_start
       ), samples as (
         select c.user_id, 300 as value, b.quarter_start + interval '1 day' as created_at,
           'old' as generation from cohort c cross join boundary b
         union all
         select c.user_id, c.value, b.quarter_start + interval '2 days', 'latest'
         from cohort c cross join boundary b
       )
       insert into public.member_workload_logs (
         user_id, priority, pending, unread_docs, todos, referrals, ce_activities,
         assistance_requests, aged_cases, receipt_code, created_at, logged_on)
       select user_id, value, value, value, value, value, value, value, value,
         pg_catalog.substr(pg_catalog.md5('wkl-quarter-' || generation || '-' || user_id::text), 1, 8),
         created_at, (created_at at time zone 'America/New_York')::date
       from samples`,
      [localUsers],
    );
    await client.query(
      `with boundary as (
         select (pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'America/New_York')
           - interval '3 months') at time zone 'America/New_York' as quarter_start
       )
       insert into public.member_workload_logs (
         user_id, priority, pending, unread_docs, todos, referrals, ce_activities,
         assistance_requests, aged_cases, receipt_code, created_at, logged_on)
       select $1::uuid, 300, 300, 300, 300, 300, 300, 300, 300,
         pg_catalog.substr(pg_catalog.md5('wkl-quarter-foreign-' || ($1::uuid)::text), 1, 8),
         quarter_start + interval '2 days',
         ((quarter_start + interval '2 days') at time zone 'America/New_York')::date
       from boundary`,
      [foreignMember],
    );
    await client.query(
      `with cohort as (
         select user_id, ord::integer as member_value
         from pg_catalog.unnest($1::uuid[]) with ordinality as members(user_id, ord)
       ), samples as (
         select c.user_id, week_no,
           c.member_value + ((week_no - 1) * 5) as value,
           pg_catalog.date_trunc('week', pg_catalog.now())
             - pg_catalog.make_interval(weeks => 4 - week_no) + interval '1 day' as created_at
         from cohort c cross join pg_catalog.generate_series(1, 3) week_no
       )
       insert into public.member_workload_logs (
         user_id, priority, pending, unread_docs, todos, referrals, ce_activities,
         assistance_requests, aged_cases, receipt_code, created_at, logged_on)
       select user_id, value, value, value, value, value, value, value, value,
         pg_catalog.substr(pg_catalog.md5('wkl-trend-' || week_no || '-' || user_id::text), 1, 8),
         created_at, (created_at at time zone 'America/New_York')::date
       from samples`,
      [localUsers],
    );
    await client.query(
      `with samples as (
         select week_no,
           pg_catalog.date_trunc('week', pg_catalog.now())
             - pg_catalog.make_interval(weeks => 4 - week_no) + interval '1 day' as created_at
         from pg_catalog.generate_series(1, 3) week_no
       )
       insert into public.member_workload_logs (
         user_id, priority, pending, unread_docs, todos, referrals, ce_activities,
         assistance_requests, aged_cases, receipt_code, created_at, logged_on)
       select $1, 300, 300, 300, 300, 300, 300, 300, 300,
         pg_catalog.substr(pg_catalog.md5('wkl-trend-foreign-' || week_no), 1, 8),
         created_at, (created_at at time zone 'America/New_York')::date
       from samples`,
      [foreignMember],
    );

    const statsAal1 = await callAs(
      aal1(localUsers[0]),
      "select public.get_workload_stats() as result",
    );
    check("workload distribution refuses aal1 when a verified factor is enrolled",
      statsAal1.code === "42501", "42501", statsAal1.code || "success");

    const statsAal2 = await callAs(
      aal2(localUsers[0]),
      "select public.get_workload_stats() as result",
    );
    const stats = statsAal2.rows?.[0]?.result;
    const priorityStats = stats?.categories?.find((category) => category.key === "priority");
    check("workload distribution is chapter-scoped, latest/member, K=25, and band-only",
      statsAal2.code === "" && stats?.enoughData === true
        && stats?.submittersBand === "25-49"
        && !Object.hasOwn(stats ?? {}, "submitters")
        && !Object.hasOwn(stats ?? {}, "sampleSize")
        && Number(priorityStats?.avg) === 13
        && Number(priorityStats?.median) === 13
        && Number(priorityStats?.p90) === 23,
      "25-49 and local avg/median/p90 13/13/23 without exact N",
      `${statsAal2.code || "success"} / ${JSON.stringify(stats ?? null)}`);

    const foreignStats = await callAs(
      aal2(foreignMember),
      "select public.get_workload_stats() as result",
    );
    check("workload distribution with fewer than 25 chapter submitters is explicitly unavailable",
      foreignStats.code === ""
        && foreignStats.rows?.[0]?.result?.enoughData === false
        && foreignStats.rows?.[0]?.result?.reason === "anonymity_floor"
        && !Object.hasOwn(foreignStats.rows?.[0]?.result ?? {}, "submitters"),
      "anonymity_floor without exact N",
      `${foreignStats.code || "success"} / ${JSON.stringify(foreignStats.rows?.[0]?.result ?? null)}`);

    const staffAal1 = await callAs(
      aal1(localUsers[0]),
      "select public.get_steward_workload_intelligence(8) as result",
    );
    const memberStaffAttempt = await callAs(
      aal2(localUsers[2]),
      "select public.get_steward_workload_intelligence(8) as result",
    );
    check("workload intelligence enforces both staff role and enrolled-factor MFA",
      staffAal1.code === "42501" && memberStaffAttempt.code === "42501",
      "42501 / 42501", `${staffAal1.code || "success"} / ${memberStaffAttempt.code || "success"}`);
    const mismatchedScopedRole = await callAs(
      aal2(mismatchedStaff),
      "select public.get_steward_workload_intelligence(8) as result",
    );
    check("workload intelligence refuses a staff role scoped to another chapter without returning data",
      mismatchedScopedRole.code === "42501" && !mismatchedScopedRole.rows,
      "42501 and no rows", `${mismatchedScopedRole.code || "success"} / ${JSON.stringify(mismatchedScopedRole.rows ?? null)}`);

    await client.query(
      `insert into public.member_cases
         (user_id, reference, title, deadline, case_type, articles, status, steward_user_id, steward_name)
       select owner_id, 'WKL-PROBE-' || ord,
         'Private workload probe case ' || ord,
         case when ord <= 2 then current_date - ord::integer
              when ord <= 4 then current_date + ord::integer else null end,
         'Probe', '', 'active', $2, 'Workload Probe 1'
       from pg_catalog.unnest($1::uuid[]) with ordinality owners(owner_id, ord)`,
      [localUsers.slice(2, 8), localUsers[0]],
    );
    const intelligenceCall = await callAs(
      aal2(localUsers[0]),
      "select public.get_steward_workload_intelligence(8) as result",
    );
    const intelligence = intelligenceCall.rows?.[0]?.result;
    const priorityTrend = intelligence?.categories?.find((category) => category.key === "priority");
    const balancingText = JSON.stringify(intelligence?.rebalancing ?? {});
    check("workload trends use two-plus eligible K=25 weeks and a four-week category forecast",
      intelligenceCall.code === "" && intelligence?.available === true
        && intelligence?.eligibleWeeks === 3
        && intelligence?.categories?.length === 8
        && Number(priorityTrend?.points) === 3
        && Number(priorityTrend?.slope) === 5
        && Number(priorityTrend?.latest) === 23
        && Number(priorityTrend?.forecast4Weeks) === 43,
      "3 eligible weeks and priority 3/5/23/43",
      `${intelligenceCall.code || "success"} / ${JSON.stringify(intelligence ?? null)}`);
    check("workload rebalancing is bounded and contains counts-only staff suggestions",
      intelligence?.rebalancing?.stewards?.length === 2
        && intelligence?.rebalancing?.stewards?.length <= 50
        && intelligence?.rebalancing?.suggestions?.length === 1
        && intelligence?.rebalancing?.suggestions?.length <= 10
        && !balancingText.includes("Private workload probe case")
        && !balancingText.includes("WKL-PROBE-")
        && !balancingText.includes("note")
        && !balancingText.includes("receipt"),
      "two count rows, one suggestion, no case/log content",
      balancingText);

    const foreignIntelligence = await callAs(
      aal2(foreignStaff),
      "select public.get_steward_workload_intelligence(8) as result",
    );
    check("workload trends never borrow another chapter's cohort",
      foreignIntelligence.code === ""
        && foreignIntelligence.rows?.[0]?.result?.available === false
        && foreignIntelligence.rows?.[0]?.result?.reason === "anonymity_floor"
        && foreignIntelligence.rows?.[0]?.result?.eligibleWeeks === 0,
      "chapter-local anonymity_floor with zero eligible weeks",
      `${foreignIntelligence.code || "success"} / ${JSON.stringify(foreignIntelligence.rows?.[0]?.result ?? null)}`);

    const reminderAal1 = await callAs(
      aal1(localUsers[0]),
      "select public.get_workload_reminder_preferences() as result",
    );
    check("workload reminder preferences refuse aal1 when a verified factor is enrolled",
      reminderAal1.code === "42501", "42501", reminderAal1.code || "success");

    const defaultReminder = await callAsKeeping(
      aal2(localUsers[2]),
      "select public.get_workload_reminder_preferences() as result",
    );
    const [defaultReminderRows] = await q(
      "select count(*)::int as count from private.workload_reminder_preferences where user_id = $1",
      [localUsers[2]],
    );
    check("reading workload reminder defaults creates no private row",
      defaultReminder.code === "" && defaultReminder.rows?.[0]?.result?.enabled === false
        && defaultReminderRows.count === 0,
      "disabled defaults and zero rows",
      `${defaultReminder.code || "success"} / ${JSON.stringify(defaultReminderRows)}`);

    const firstReminderSave = await callAsKeeping(
      aal2(localUsers[2]),
      "select public.set_workload_reminder_preferences(true, 'weekly', 1, 9, 'America/New_York') as result",
    );
    const secondReminderSave = await callAsKeeping(
      aal2(localUsers[2]),
      "select public.set_workload_reminder_preferences(true, 'weekly', 1, 9, 'America/New_York') as result",
    );
    check("identical workload reminder saves preserve the future due instant",
      firstReminderSave.code === "" && secondReminderSave.code === ""
        && firstReminderSave.rows?.[0]?.result?.nextDueAt != null
        && firstReminderSave.rows?.[0]?.result?.nextDueAt === secondReminderSave.rows?.[0]?.result?.nextDueAt,
      "same non-null nextDueAt",
      `${JSON.stringify(firstReminderSave.rows?.[0]?.result ?? null)} / ${JSON.stringify(secondReminderSave.rows?.[0]?.result ?? null)}`);

    const nullSchedules = [
      [null, 1, 9, "America/New_York", "cadence"],
      ["weekly", null, 9, "America/New_York", "weekday"],
      ["weekly", 1, null, "America/New_York", "hour"],
      ["weekly", 1, 9, null, "timezone"],
    ];
    const nullResults = [];
    for (const [cadence, weekday, hour, timezone, label] of nullSchedules) {
      const result = await callOwner(
        `select private.next_workload_reminder_at(
           $1::text, $2::integer, $3::integer, $4::text, pg_catalog.now())`,
        [cadence, weekday, hour, timezone],
      );
      nullResults.push(`${label}:${result.code}`);
    }
    check("workload reminder schedule rejects null cadence, weekday, hour, and timezone",
      nullResults.every((result) => result.endsWith(":22023")),
      "four 22023 refusals", nullResults.join(", "));

    const dstSchedule = await callOwner(
      `select private.next_workload_reminder_at(
         'weekly', 7, 1, 'America/New_York', '2026-10-31T12:00:00Z'::timestamptz) as due`,
    );
    check("workload reminder scheduling keeps the requested local hour across DST fallback",
      dstSchedule.code === ""
        && dstSchedule.rows?.[0]?.due instanceof Date
        && dstSchedule.rows[0].due.toISOString() === "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
      dstSchedule.code || dstSchedule.rows?.[0]?.due?.toISOString?.() || "no result");

    const malformedMetadata = await callOwner(
      `insert into public.member_notifications
         (user_id, title, body, kind, workload_event, workload_receipt_code)
       values ($1, 'WKL-PROBE-invalid', 'invalid', 'workload', 'reminder', 'deadbeef')`,
      [localUsers[3]],
    );
    check("workload reminder metadata structurally forbids a payload",
      malformedMetadata.code === "23514", "23514", malformedMetadata.code || "success");

    if (localTarget) {
      await client.query("update private.notification_controls set outbound_enabled = true where id");
      await client.query(
        `update public.member_profiles set
           dnd_enabled = true,
           notification_prefs = pg_catalog.jsonb_set(notification_prefs, '{workload}', 'true'::jsonb)
         where id = $1`,
        [localUsers[3]],
      );
      const receiptCall = await callAsKeeping(
        aal2(localUsers[3]),
        `select public.submit_workload_log(
           7, 8, 9, 10, 11, 12, 13, 14, 15, 'full_time', null,
           false, false, 0, null, null, false, false,
           'WKL private member note', '{"private":"member-only"}'::jsonb) as result`,
      );
      const receiptCode = receiptCall.rows?.[0]?.result?.receiptCode;
      const [receiptState] = await q(
        `select
           (select count(*)::int from public.member_workload_logs
             where user_id = $1 and receipt_code = $2) as logs,
           (select count(*)::int from public.member_notifications
             where user_id = $1 and workload_event = 'receipt'
               and workload_receipt_code = $2
               and title not like '%WKL private member note%'
               and body not like '%member-only%') as notifications,
           (select count(*)::int from public.member_notification_deliveries d
             join public.member_notifications n on n.id = d.notification_id
             where n.user_id = $1 and n.workload_event = 'receipt'
               and n.workload_receipt_code = $2 and d.channel = 'email') as deliveries`,
        [localUsers[3], receiptCode],
      );
      check("workload submission atomically creates a generic eight-hex receipt and queued email",
        receiptCall.code === "" && /^[0-9a-f]{8}$/.test(receiptCode ?? "")
          && receiptState.logs === 1 && receiptState.notifications === 1 && receiptState.deliveries === 1,
        "one log, generic notification and email delivery",
        `${receiptCall.code || "success"} / ${receiptCode ?? "no code"} / ${JSON.stringify(receiptState)}`);

      const receiptClaim = await callServiceKeeping(
        "select public.claim_notification_deliveries('email', 200) as result",
      );
      const claimedReceipt = receiptClaim.rows?.[0]?.result?.find(
        (delivery) => delivery.receiptCode === receiptCode,
      );
      check("workload receipt bypasses focus with event-only dispatcher metadata",
        receiptClaim.code === "" && claimedReceipt?.kind === "workload"
          && claimedReceipt?.event === "receipt"
          && claimedReceipt?.receiptCode === receiptCode
          && !Object.hasOwn(claimedReceipt ?? {}, "title")
          && !Object.hasOwn(claimedReceipt ?? {}, "body"),
        "claimed receipt event/code and no title/body",
        `${receiptClaim.code || "success"} / ${JSON.stringify(claimedReceipt ?? null)}`);

      const [focusReminder] = await q(
        "select private.notify_workload_event($1, 'reminder', null) as notification_id",
        [localUsers[3]],
      );
      await callServiceKeeping("select public.claim_notification_deliveries('email', 200) as result");
      const [focusReminderState] = await q(
        `select d.status from public.member_notification_deliveries d
         where d.notification_id = $1 and d.channel = 'email'`,
        [focusReminder.notification_id],
      );
      check("workload reminder remains pending while focus mode is active",
        focusReminderState?.status === "pending", "pending", focusReminderState?.status ?? "missing");

      await client.query(
        `update public.member_profiles set
           notification_prefs = pg_catalog.jsonb_set(notification_prefs, '{workload}', 'true'::jsonb)
         where id = $1`,
        [localUsers[4]],
      );
      for (let index = 0; index < 6; index += 1) {
        await q("select private.notify_workload_event($1, 'reminder', null)", [localUsers[4]]);
      }
      const [weeklyCap] = await q(
        `select
           count(*) filter (where d.status <> 'skipped')::int as queued,
           count(*) filter (where d.status = 'skipped'
             and d.last_error = 'rate limited: weekly nudge cap')::int as capped
         from public.member_notification_deliveries d
         join public.member_notifications n on n.id = d.notification_id
         where n.user_id = $1 and n.kind = 'workload' and n.workload_event = 'reminder'
           and d.channel = 'email'`,
        [localUsers[4]],
      );
      check("workload reminders respect the five-per-week nudge cap",
        weeklyCap.queued === 5 && weeklyCap.capped === 1,
        "five queued and one capped", JSON.stringify(weeklyCap));

      await client.query(
        `update public.member_profiles set
           notification_prefs = pg_catalog.jsonb_set(notification_prefs, '{workload}', 'false'::jsonb)
         where id = $1`,
        [localUsers[5]],
      );
      await q("select private.notify_workload_event($1, 'reminder', null)", [localUsers[5]]);
      const [topicOffState] = await q(
        `select
           count(*)::int as in_app,
           count(d.id)::int as deliveries
         from public.member_notifications n
         left join public.member_notification_deliveries d on d.notification_id = n.id
         where n.user_id = $1 and n.kind = 'workload' and n.workload_event = 'reminder'`,
        [localUsers[5]],
      );
      check("workload topic off preserves in-app history and blocks outbound",
        topicOffState.in_app === 1 && topicOffState.deliveries === 0,
        "one in-app and zero deliveries", JSON.stringify(topicOffState));

      await client.query(
        `update private.workload_reminder_preferences
         set next_due_at = pg_catalog.now() - interval '1 minute'
         where user_id = $1`,
        [localUsers[2]],
      );
      const [firstSweep] = await q("select private.workload_reminder_sweep() as sent");
      const [secondSweep] = await q("select private.workload_reminder_sweep() as sent");
      const [sweepState] = await q(
        `select p.next_due_at > pg_catalog.now() as future_due,
                p.last_sent_at is not null as sent_stamp,
                count(n.id)::int as notifications
         from private.workload_reminder_preferences p
         left join public.member_notifications n on n.user_id = p.user_id
           and n.kind = 'workload' and n.workload_event = 'reminder'
         where p.user_id = $1
         group by p.next_due_at, p.last_sent_at`,
        [localUsers[2]],
      );
      check("workload reminder sweep advances once from now without backlog replay",
        firstSweep.sent === 1 && secondSweep.sent === 0
          && sweepState.future_due === true && sweepState.sent_stamp === true
          && sweepState.notifications === 1,
        "1 then 0, future due, one notification",
        `${JSON.stringify(firstSweep)} / ${JSON.stringify(secondSweep)} / ${JSON.stringify(sweepState)}`);
    }
  }

  await runMemberSessionProbes();
  await runWorkloadIntelligenceProbes();
  await client.query("rollback");

  // Residue sweep on a fresh implicit transaction: nothing a probe created may
  // survive — INCLUDING everything the valid vote wrote (anonymous choice row,
  // receipt, action-log key, point event). The choice rows carry no user
  // column, so they are swept by probe ballot id — both probe ballots, in case
  // a defect ever files the cross-ballot choice. Markers are probe-unique and
  // user-scoped so a real member's data can never trip (or mask) the sweep.
  const [residue] = await q(`select
      (select count(*) from public.member_cases where reference like 'GR-2026-PROBECAP%')
    + (select count(*) from public.member_point_events where action_key like 'case-PROBE-SEED%' or action_key like 'case-GR-2026-PROBECAP%')
    + (select count(*) from public.member_action_log where action_key like 'case-GR-2026-PROBECAP%')
    + (select count(*) from public.member_ballots where id in ('probe-rpc-ballot-a', 'probe-rpc-ballot-b'))
    + (select count(*) from public.member_ballot_options where id in ('probe-rpc-option-a', 'probe-rpc-option-b'))
    + (select count(*) from public.member_ballot_choices where ballot_id in ('probe-rpc-ballot-a', 'probe-rpc-ballot-b'))
    + (select count(*) from public.member_ballot_receipts where ballot_id = 'probe-rpc-ballot-a')
    + (select count(*) from public.member_action_log where user_id = $1 and action_key = 'vote-probe-rpc-ballot-a')
    + (select count(*) from public.member_point_events where user_id = $1 and action_key = 'vote-probe-rpc-ballot-a')
    + (select count(*) from auth.mfa_factors where user_id = $2 and friendly_name = 'probe-totp')
    + (select count(*) from public.chapter_tasks where title like 'KANBAN-PROBE-DURABLE-KEY-%')
    + (select count(*) from public.chapter_documents where title like 'COMPASS-PROBE-%')
    as leftovers`, [u4.id, u1.id]);
  check("zero probe residue after rollback", Number(residue.leftovers) === 0, "0", String(residue.leftovers));
  const [intakeResidue] = await q(
    `select
       (select count(*) from public.member_intake_reports where id = any($1::uuid[]))
     + (select count(*) from public.member_cases where id = $2)
     + (select count(*) from public.chapter_tasks where id = $3)
     + (select count(*) from public.chapter_threads where id = $4)
     + (select count(*) from public.chapter_spaces where id = $5) as leftovers`,
    [[intakeCaseReport, intakeTaskReport, intakeThreadReport, intakeMemberDeniedReport, intakeForeignDeniedReport], intakeCaseId, intakeTaskId, intakeThreadId, createdIntakeSpaceId]);
  check("zero intake probe residue after rollback", Number(intakeResidue.leftovers) === 0,
    "0", String(intakeResidue.leftovers));
  const [sourceTaskResidue] = await q(
    `select
       (select count(*) from public.member_conversations where id = $1)
     + (select count(*) from public.member_messages where id = any($2::uuid[]))
     + (select count(*) from public.member_broadcasts where id = $3)
     + (select count(*) from public.member_notifications where id = $4)
     + (select count(*) from public.member_surveys where id = $5)
     + (select count(*) from public.member_cases where id = $6)
     + (select count(*) from public.chapter_tasks where id = any($7::uuid[]))
     + (select count(*) from public.chapter_task_attachments where source_kind is not null and source_id = any($8::text[]))
       as leftovers`,
    [
      sourceConversation.id,
      sourceMessages.map((row) => row.id),
      sourceBroadcast.id,
      sourceNotification.id,
      sourceSurvey.id,
      sourceCase.id,
      sourceTaskIds,
      positiveSources.map(([, id]) => String(id)).concat(String(sourceMessages[1].id)),
    ],
  );
  check("zero source-task probe residue after rollback",
    Number(sourceTaskResidue.leftovers) === 0, "0", String(sourceTaskResidue.leftovers));
  const [invitationResidue] = await q(
    `select
       (select count(*) from public.member_invitations where normalized_email like 'rpc-probe-invite-%')
     + (select count(*) from public.member_invitation_audit a join public.member_invitations i on i.id = a.invitation_id where i.normalized_email like 'rpc-probe-invite-%')
     + (select count(*) from private.member_invitation_admin_limits where scope_key like 'admin:00000000-0000-4000-8000-%' or scope_key like 'chapter:%' or scope_key like 'invitation:%')
     + (select count(*) from private.member_invitation_accept_limits where scope_hash = $1) as leftovers`,
    ["ef".repeat(32)],
  );
  check("zero invitation and rate-limit probe residue after rollback",
    Number(invitationResidue.leftovers) === 0, "0", String(invitationResidue.leftovers));
  const [recoveryResidue] = await q(
    `select
       (select count(*) from private.member_signin_recoveries
         where actor = $1 or target_user = any($2::uuid[]))
     + (select count(*) from private.member_signin_recovery_limits
         where scope_key = $3 or scope_key = any($4::text[]))
     + (select count(*) from public.member_admin_audit
         where actor = $1 and action in ('recover_signin_address', 'recover_signin_address_failed'))
     + (select count(*) from auth.mfa_factors
         where user_id = $1 and friendly_name = 'probe-recovery-totp') as leftovers`,
    [
      syntheticUsers.staff,
      [syntheticUsers.owner, syntheticUsers.invited],
      `admin:${syntheticUsers.staff}`,
      [`target:${syntheticUsers.owner}`, `target:${syntheticUsers.invited}`],
    ],
  );
  check("zero sign-in recovery probe residue after rollback",
    Number(recoveryResidue.leftovers) === 0, "0", String(recoveryResidue.leftovers));
  const [sessionResidue] = await q(
    `select
       (select count(*) from auth.sessions where id = any($1::uuid[]))
     + (select count(*) from auth.refresh_tokens where token like 'rpc-probe-session-%')
     + (select count(*) from public.member_push_subscriptions where endpoint like '%/rpc-probe-%')
     + (select count(*) from public.member_native_push_installations where device_token like 'rpc-probe-native-%')
     + (select count(*) from private.member_native_push_installation_audit where user_id = any($2::uuid[]))
     + (select count(*) from private.member_session_revocations where user_id = any($2::uuid[]))
     + (select count(*) from private.member_session_closing_barriers where user_id = any($2::uuid[]))
     + (select count(*) from public.organizations where slug like 'rpc-probe-reset-%')
     + (select count(*) from public.chapters where id like 'rpc-probe-reset-%')
       as leftovers`,
    [Object.values(syntheticSessions), Object.values(syntheticUsers)],
  );
  check("zero device-session, refresh, web/native push, audit, revocation, and closing-barrier residue after rollback",
    Number(sessionResidue.leftovers) === 0, "0", String(sessionResidue.leftovers));
  const [syntheticUserResidue] = await q(
    "select count(*)::int as leftovers from auth.users where id = any($1::uuid[])",
    [Object.values(syntheticUsers)],
  );
  check("zero synthetic identity residue after rollback",
    syntheticUserResidue.leftovers === 0, "0", String(syntheticUserResidue.leftovers));
  const [workloadResidue] = await q(
    `select
       (select count(*) from auth.users where email like 'rpc-probe-workload-%@example.test')
     + (select count(*) from public.chapters where id in ('wkl-probe-a', 'wkl-probe-b'))
     + (select count(*) from public.member_cases where reference like 'WKL-PROBE-%')
       as leftovers`,
  );
  check("zero workload intelligence probe residue after rollback",
    Number(workloadResidue.leftovers) === 0, "0", String(workloadResidue.leftovers));
}

async function runCli() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    if (requireDbVerify()) {
      console.error("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1 — this lane must run the live RPC probes.");
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log("::warning title=verify:rpc skipped::SUPABASE_DB_URL is not set, so the live RPC behaviour was NOT verified in this run.");
    }
    console.log("SKIP: SUPABASE_DB_URL not set — RPC behaviour was not verified.");
    process.exit(0);
  }

  // The probes below create rollback-only synthetic auth.users, chapters, and
  // related rows. The binding no-fiction tenancy rule forbids fictional
  // identities in any routine lane, so an armed run now needs an explicit
  // owner exception; required CI runs verify:task-comment:no-fiction instead.
  // TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816 owns the re-enable decision.
  if ((process.env.ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES ?? "").trim() !== "1") {
    console.error(
      "FAIL: verify:rpc is quarantined — its fixtures create fictional identities, which the"
      + " no-fiction tenancy contract forbids. Set ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES=1 only"
      + " under a recorded owner exception (TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816)."
      + " For legitimately onboarded identities, use verify:rpc:authorized with a short-lived"
      + " external authorization manifest instead.",
    );
    process.exit(1);
  }

  try {
    assertExactTarget(contract.target, connectionString, {
      disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
    });
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }

  const loopbackTarget = isLoopbackPostgresUrl(connectionString);
  localTarget = loopbackTarget;
  if ((process.env.VERIFY_RPC_PENDING_MIGRATION ?? "").trim() && !loopbackTarget) {
    console.error("FAIL: VERIFY_RPC_PENDING_MIGRATION is restricted to a loopback exact-target alias.");
    process.exit(1);
  }
  client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    // Supabase's local Postgres endpoint is plaintext; remote pooler/direct
    // targets stay TLS with chain validation. The exact-project guard above
    // still runs first.
    ssl: postgresSslForTarget(connectionString),
    application_name: "verify-rpc-behaviour",
  });

  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    failures.push({
      name: "run",
      expected: "completes",
      observed: [error.message, error.detail, error.where].filter(Boolean).join(" — "),
    });
  } finally {
    try { await client.query("rollback"); } catch { /* already rolled back or never began */ }
    await client.end().catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`FAIL — ${failures.length} of ${checks} RPC behaviour probes disagree with ${contract.target.projectRef ?? "the disposable loopback database"}.`);
    for (const f of failures) console.error(`  ${f.name}: expected ${f.expected}, observed ${f.observed}`);
    exitCode = 1;
  } else {
    console.log(`PASS — ${checks} RPC behaviour probes agree with ${contract.target.projectRef ?? "the disposable loopback database"}.`);
  }
  process.exit(exitCode);
}

// CLI entry behind a main guard, matching verify-db-contract.mjs. Everything
// above is declaration only, so the shared target guard now lives in
// scripts/lib/assert-exact-target.mjs instead of being pasted into both lanes.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
