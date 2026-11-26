#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import pg from "pg";
import { assertDisposableProofUrl } from "../run-required-db-proofs.mjs";

// This is a committed, cleanup-bounded SAMPLE-shaped fixture. PostgreSQL
// exported snapshots cannot see another transaction's uncommitted rows, so
// concurrent waves require a brief committed fixture. The deterministic
// cleanup runs before and after every profile.
export const SCALE = Object.freeze({
  organizations: 4,
  chapters: 50,
  organizationChapters: 21,
  users: 31_068,
  chapterMemberships: 31_074,
  organizationMemberships: 31_006,
  stewardGrants: 831,
  conversations: 39_566,
  messages: 356_762,
  requests: 11_920,
  forms: 7_949,
  broadcasts: 317,
  sessions: 2_650,
  memberRoles: 899,
});

const DATABASE_URL = process.env.SUPABASE_DB_URL;
const UUID = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = (n) => UUID("a", n);

export const RPCS = Object.freeze([
  ["list_steward_requests", "select * from public.list_steward_requests('all', null, 'newest', null, null, 100)"],
  ["list_steward_conversations", "select * from public.list_steward_conversations('all', null, null, null, 50)"],
  ["list_steward_broadcasts", "select * from public.list_steward_broadcasts('all', null, null, null, 20)"],
  ["get_steward_desk_kpis", "select * from public.get_steward_desk_kpis()"],
  ["list_steward_forms", "select * from public.list_steward_forms('all', null, 'oldest', null, null, 50)"],
]);

const PROFILE_FUNCTION_NAMES = Object.freeze([
  ...RPCS.map(([name]) => name),
  "staff_visible_member_ids", "member_has_role", "mfa_satisfied",
  "current_member_organization", "can_read_member_broadcast",
  "has_organization_role", "member_has_chapter_role",
  "visible_member_broadcast_ids", "is_organization_member",
]);

const PROFILE_POLICY_NAMES = Object.freeze([
  ["public", "member_broadcasts", "member_broadcasts_read_authenticated"],
  // One merged SELECT policy each since 20261028210000.
  ["public", "member_conversations", "member_conversations_select"],
  ["public", "member_messages", "member_messages_select"],
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The profiler commits a large, deterministic fixture before opening peer
// connections. Keep its target boundary identical to the live DB proof: a
// local disposable Supabase port only, checked before pg.Client is constructed.
export function assertDisposableProfileUrl(rawUrl) {
  return assertDisposableProofUrl(rawUrl);
}

async function functionStats(client) {
  const { rows } = await client.query(`
    select n.nspname || '.' || p.proname as name,
           calls::bigint, total_time::double precision, self_time::double precision
    from pg_stat_xact_user_functions f
    join pg_proc p on p.oid = f.funcid
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname = any($1::text[])
    order by 1
  `, [PROFILE_FUNCTION_NAMES]);
  return new Map(rows.map((row) => [row.name, row]));
}

export async function stewardDeskDefinitionManifest(client) {
  const { rows: functions } = await client.query(`
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
           pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname = any($1::text[])
    order by 1
  `, [PROFILE_FUNCTION_NAMES]);
  const { rows: policies } = await client.query(`
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where (schemaname, tablename, policyname) in (
      ('public', 'member_broadcasts', 'member_broadcasts_read_authenticated'),
      ('public', 'member_conversations', 'member_conversations_select'),
      ('public', 'member_messages', 'member_messages_select')
    )
    order by 1, 2, 3
  `);
  const functionManifest = Object.fromEntries(functions.map((row) => [row.signature, {
    sha256: sha256(row.definition), definition: row.definition,
  }]));
  const policyManifest = Object.fromEntries(policies.map((row) => {
    const key = `${row.schemaname}.${row.tablename}.${row.policyname}`;
    const definition = JSON.stringify({ qual: row.qual, with_check: row.with_check });
    return [key, { sha256: sha256(definition), definition: JSON.parse(definition) }];
  }));
  if (policies.length !== PROFILE_POLICY_NAMES.length) {
    throw new Error("steward desk definition manifest is missing a required RLS policy");
  }
  return { functions: functionManifest, policies: policyManifest };
}

function statDelta(before, after) {
  return [...after.entries()].map(([name, stat]) => {
    const prior = before.get(name) ?? { calls: 0, total_time: 0, self_time: 0 };
    return {
      name,
      calls: Number(stat.calls) - Number(prior.calls),
      total_ms: Number(stat.total_time) - Number(prior.total_time),
      self_ms: Number(stat.self_time) - Number(prior.self_time),
    };
  }).filter((row) => row.calls || row.total_ms || row.self_ms);
}

async function seed(client, distribution = "balanced") {
  if (!["balanced", "sample-skew"].includes(distribution)) throw new Error("Unknown Steward scale distribution");
  // The hosted catalog has 30,006 profiles in 20 chapters of one organization,
  // 1,000 in the second organization, and 62 in legacy unscoped chapters.
  // Keep the balanced baseline too: total counts alone miss this tenant skew.
  const chapterNumber = distribution === "sample-skew"
    ? "case when n <= 30006 then ((n - 1) % 20) + 1 when n <= 31006 then 21 else ((n - 31007) % 29) + 22 end"
    : `((n - 1) % ${SCALE.organizationChapters}) + 1`;
  const organizationNumber = distribution === "sample-skew"
    ? "case when n <= 20 then 1 else 2 end"
    : `((n - 1) % ${SCALE.organizations}) + 1`;
  const broadcastOrganizationNumber = distribution === "sample-skew"
    ? `case when ((n - 1) % ${SCALE.organizationChapters}) + 1 <= 20 then 1 else 2 end`
    : `(((n - 1) % ${SCALE.organizationChapters}) % ${SCALE.organizations}) + 1`;
  // Auth's normal signup trigger correctly protects production identities, but
  // it takes a case-graph advisory lock for every inserted user.  A 31k-user
  // single transaction therefore exceeds PostgreSQL's default 64-lock budget.
  // This fixture deliberately disables triggers only while it writes the
  // trigger's durable shapes itself, then restores origin before auth sessions
  // and every observed RPC.  It never changes database schema or constraints.
  await client.query("set local session_replication_role = 'replica'");
  await client.query(`
    insert into auth.users (
      id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, is_sso_user, is_anonymous
    )
    select
      ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'authenticated', 'authenticated',
      'steward-scale-' || n::text || chr(64) || 'example.invalid',
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb, clock_timestamp(), clock_timestamp(), false, false
    from generate_series(1, ${SCALE.users}) as n
  `);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    select ('f0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'steward-scale-org-' || n::text, 'Steward scale organization ' || n::text,
      'active', 'a0000000-0000-4000-8000-000000000001'::uuid
    from generate_series(1, ${SCALE.organizations}) as n
  `);
  await client.query(`
    insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
    select 'steward-scale-chapter-' || n::text, 'Steward scale chapter ' || n::text,
      'scale', n = 1, n, case when n <= ${SCALE.organizationChapters}
        then ('f0000000-0000-4000-8000-' || lpad((${organizationNumber})::text, 12, '0'))::uuid
        else null end, 'steward-scale-chapter-' || n::text
    from generate_series(1, ${SCALE.chapters}) as n
  `);
  await client.query(`
    insert into public.member_profiles (
      id, first_name, full_name, initials, chapter_id, role_line,
      member_since, language, notification_prefs, dnd_enabled,
      quiet_hours_timezone, urgent_notifications_enabled, shortcut_keys,
      work_widget_order, created_at, updated_at
    )
    select
      ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'Scale ' || n::text, 'Scale member ' || n::text, 'SM',
      'steward-scale-chapter-' || (${chapterNumber})::text,
      'Member', 2020, 'en', '{}'::jsonb, false, 'UTC', true,
      '{}'::text[], '{}'::text[], clock_timestamp(), clock_timestamp()
    from generate_series(1, ${SCALE.users}) as n
  `);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, joined_at)
    select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'steward-scale-chapter-' || (${chapterNumber})::text,
      'active', n = 1, clock_timestamp()
    from generate_series(1, ${SCALE.users}) as n
    on conflict (user_id, chapter_id) do update set status = excluded.status, revoked_at = null
  `);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, joined_at)
    select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'steward-scale-chapter-' || (((n + 4) % ${SCALE.organizationChapters}) + 1)::text,
      'active', false, clock_timestamp()
    from generate_series(1, ${SCALE.chapterMemberships - SCALE.users}) as n
  `);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status)
    select chapter.organization_id, profile.id, 'active'
    from public.member_profiles profile
    join public.chapters chapter on chapter.id = profile.chapter_id
    where profile.full_name like 'Scale member %'
      and profile.id <= ('a0000000-0000-4000-8000-' || lpad(${SCALE.organizationMemberships}::text, 12, '0'))::uuid
    on conflict (organization_id, user_id) do update set status = excluded.status, revoked_at = null
  `);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by)
    select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      case when n <= ${SCALE.stewardGrants} then 'steward' else 'coordinator' end,
      'steward-scale-chapter-' || (${chapterNumber})::text,
      'a0000000-0000-4000-8000-000000000001'::uuid
    from generate_series(1, ${SCALE.memberRoles}) as n
  `);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'steward', 'steward-scale-chapter-' || (${chapterNumber})::text,
      'a0000000-0000-4000-8000-000000000001'::uuid
    from generate_series(1, ${SCALE.stewardGrants}) as n
  `);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    select ('f0000000-0000-4000-8000-' || lpad((((n - 1) % ${SCALE.organizations}) + 1)::text, 12, '0'))::uuid,
      ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'steward',
      'a0000000-0000-4000-8000-000000000001'::uuid
    from generate_series(1, 1) as n
    on conflict (organization_id, user_id, role) do nothing
  `);
  await client.query(`
    insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
    select ('b0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ('a0000000-0000-4000-8000-' || lpad((((n - 1) % ${SCALE.organizationMemberships}) + 1)::text, 12, '0'))::uuid,
      'Scale conversation ' || n::text, 'SM', clock_timestamp() - n * interval '1 second', clock_timestamp() - n * interval '1 second'
    from generate_series(1, ${SCALE.conversations}) as n
  `);
  await client.query(`
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, created_at)
    select ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      conversation.id,
      conversation.user_id,
      case when ((n - 1) % ${SCALE.conversations}) % 2 = 0 then 'member' else 'steward' end, 'Scale', 'Scale message ' || n::text,
      clock_timestamp() - (${SCALE.messages} - n) * interval '1 second'
    from generate_series(1, ${SCALE.messages}) as n
    join public.member_conversations conversation
      on conversation.id = ('b0000000-0000-4000-8000-' || lpad((((n - 1) % ${SCALE.conversations}) + 1)::text, 12, '0'))::uuid
  `);
  await client.query(`
    insert into public.member_steward_requests (id, user_id, lesson_id, status, created_at)
    select ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ('a0000000-0000-4000-8000-' || lpad((((n - 1) % ${SCALE.organizationMemberships}) + 1)::text, 12, '0'))::uuid,
      'scale-lesson', case when n <= 6130 then 'requested' else 'closed' end,
      clock_timestamp() - n * interval '1 second'
    from generate_series(1, ${SCALE.requests}) as n
  `);
  await client.query(`
    insert into public.member_forms (id, user_id, template_key, template_version, status, answers, step, submitted_at, created_at, updated_at)
    select ('d0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ('a0000000-0000-4000-8000-' || lpad((((n - 1) % ${SCALE.organizationMemberships}) + 1)::text, 12, '0'))::uuid,
      'scale-form', 1, case when n <= 1943 then 'submitted' else 'draft' end, '{}'::jsonb, 1,
      case when n <= 1943 then clock_timestamp() - n * interval '1 second' else null end,
      clock_timestamp(), clock_timestamp()
    from generate_series(1, ${SCALE.forms}) as n
  `);
  await client.query(`
    insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by, locale, organization_id, chapter_id, audience_scope)
    select 'steward-scale-broadcast-' || n::text, 'Scale', 'Scale broadcast ' || n::text, 'Scale body',
      clock_timestamp() - n * interval '1 hour', 1000000 + n, 'a0000000-0000-4000-8000-000000000001'::uuid, 'en',
      ('f0000000-0000-4000-8000-' || lpad((${broadcastOrganizationNumber})::text, 12, '0'))::uuid,
      'steward-scale-chapter-' || (((n - 1) % ${SCALE.organizationChapters}) + 1)::text,
      case when n % 3 = 0 then 'chapter' else 'organization' end
    from generate_series(1, ${SCALE.broadcasts}) as n
  `);
  const sessionId = UUID("9", 1);
  // Keep this fixture-only MFA write under replica: its normal trigger emits
  // notifications and delivery rows, which would make cleanup incomplete.
  await client.query(`
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values ('80000000-0000-4000-8000-000000000001'::uuid, $1::uuid,
      'Scale proof factor', 'totp', 'verified', 'scale-proof-secret', clock_timestamp(), clock_timestamp())
  `, [userId(1)]);
  await client.query("set local session_replication_role = 'origin'");
  await client.query(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    select ('90000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      clock_timestamp(), clock_timestamp(), 'aal2'
    from generate_series(1, ${SCALE.sessions}) as n
  `);
  return { stewardId: userId(1), sessionId, outsideUserId: userId(1_000) };
}

export async function seedStewardDeskScale(client, distribution = "balanced") {
  return seed(client, distribution);
}

// The committed fan-out proof calls this before seeding and in finally.  It is
// intentionally pattern-bound and idempotent so an interrupted proof cannot
// leave scale rows for the next run.  Replica is confined to cleanup writes,
// matching the fixture's trigger-safe bulk-insert discipline.
export async function cleanupStewardDeskScale(client) {
  await client.query("set local session_replication_role = 'replica'");
  try {
    for (const statement of [
    "delete from public.member_notification_deliveries where user_id::text like 'a0000000-0000-4000-8000-%'",
    "delete from public.member_notifications where user_id::text like 'a0000000-0000-4000-8000-%'",
    "delete from auth.mfa_factors where id = '80000000-0000-4000-8000-000000000001'::uuid",
    "delete from auth.sessions where id::text like '90000000-0000-4000-8000-%'",
    "delete from public.member_broadcasts where id like 'steward-scale-broadcast-%'",
    "delete from public.member_forms where template_key = 'scale-form'",
    "delete from public.member_steward_requests where lesson_id = 'scale-lesson'",
    "delete from public.member_messages where body like 'Scale message %'",
    "delete from public.member_conversations where title like 'Scale conversation %'",
    "delete from public.organization_role_grants where granted_by = 'a0000000-0000-4000-8000-000000000001'::uuid",
    "delete from public.member_role_chapters where granted_by = 'a0000000-0000-4000-8000-000000000001'::uuid",
    "delete from public.member_roles where granted_by = 'a0000000-0000-4000-8000-000000000001'::uuid",
    "delete from public.organization_memberships where organization_id::text like 'f0000000-0000-4000-8000-%'",
    "delete from public.member_chapter_memberships where chapter_id like 'steward-scale-chapter-%'",
    "delete from public.member_profiles where full_name like 'Scale member %'",
    "delete from public.chapters where id like 'steward-scale-chapter-%'",
    "delete from public.organizations where slug like 'steward-scale-org-%'",
    "delete from auth.users where email like 'steward-scale-%' || chr(64) || 'example.invalid'",
    ]) await client.query(statement);
  } finally {
    await client.query("set local session_replication_role = 'origin'");
  }
}

export async function asSteward(client, { stewardId, sessionId }) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: stewardId, role: "authenticated", aal: "aal2", session_id: sessionId,
  })]);
}

export async function scaleCounts(client) {
  const { rows } = await client.query(`
    select jsonb_build_object(
      'organizations', (select count(*) from public.organizations where slug like 'steward-scale-org-%'),
      'chapters', (select count(*) from public.chapters where id like 'steward-scale-chapter-%'),
      'profiles', (select count(*) from public.member_profiles where full_name like 'Scale member %'),
      'conversations', (select count(*) from public.member_conversations where title like 'Scale conversation %'),
      'messages', (select count(*) from public.member_messages where body like 'Scale message %'),
      'requests', (select count(*) from public.member_steward_requests where lesson_id = 'scale-lesson'),
      'forms', (select count(*) from public.member_forms where template_key = 'scale-form'),
      'broadcasts', (select count(*) from public.member_broadcasts where id like 'steward-scale-broadcast-%')
      ,'chapterMemberships', (select count(*) from public.member_chapter_memberships where chapter_id like 'steward-scale-chapter-%')
      ,'organizationMemberships', (select count(*) from public.organization_memberships where organization_id::text like 'f0000000-0000-4000-8000-%')
      ,'memberRoles', (select count(*) from public.member_roles where granted_by = 'a0000000-0000-4000-8000-000000000001'::uuid)
      ,'stewardRoleChapters', (select count(*) from public.member_role_chapters where granted_by = 'a0000000-0000-4000-8000-000000000001'::uuid)
      ,'sessions', (select count(*) from auth.sessions where id::text like '90000000-0000-4000-8000-%')
    ) as counts
  `);
  return rows[0].counts;
}

export async function assertStewardDeskScaleFixture(client) {
  const { rows } = await client.query(`
    select
      (select count(*) from public.organization_memberships membership
       join public.member_profiles profile on profile.id = membership.user_id
       join public.chapters chapter on chapter.id = profile.chapter_id
       where profile.full_name like 'Scale member %'
         and membership.organization_id is distinct from chapter.organization_id)::int as membership_mismatches,
      (select count(*) from public.member_messages message
       join public.member_conversations conversation on conversation.id = message.conversation_id
       where message.body like 'Scale message %' and message.sender_kind = 'member'
         and message.user_id is distinct from conversation.user_id)::int as member_message_owner_mismatches,
      (select count(*) from public.member_messages message
       join public.member_conversations conversation on conversation.id = message.conversation_id
       where message.body like 'Scale message %'
         and message.user_id is distinct from conversation.user_id)::int as message_owner_mismatches,
      (select count(*) from public.member_conversations conversation
       where conversation.title like 'Scale conversation %'
         and (select message.sender_kind from public.member_messages message
              where message.conversation_id = conversation.id
              order by message.created_at desc, message.id desc limit 1) = 'member')::int as awaiting_reply,
      (select count(*) from public.member_conversations conversation
       where conversation.title like 'Scale conversation %'
         and (select message.sender_kind from public.member_messages message
              where message.conversation_id = conversation.id
              order by message.created_at desc, message.id desc limit 1) = 'steward')::int as replied
  `);
  return rows[0];
}

export async function profileStewardDeskScale(client, repetitions = 3) {
  const results = [];
  for (const [name, sql] of RPCS) {
    const samples = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const before = await functionStats(client);
      const started = performance.now();
      const result = await client.query(sql);
      const wallMs = performance.now() - started;
      const after = await functionStats(client);
      const deltas = statDelta(before, after);
      const topLevelRpc = deltas.find((row) => row.name === `public.${name}`)
        ?? { name: `public.${name}`, calls: 0, total_ms: 0, self_ms: 0 };
      // These are deliberately separate observations. Function total time is
      // inclusive, so adding helpers to top_level_rpc would double-count.
      samples.push({
        wall_ms: wallMs, rows: result.rowCount, result: result.rows,
        top_level_rpc: topLevelRpc,
        helper_functions: deltas.filter((row) => row.name !== topLevelRpc.name),
      });
    }
    results.push({ name, samples });
  }
  return results;
}

export async function parallelStewardDeskWave(connectionString, identity, repetitions = 3) {
  const samples = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const peers = [];
    let operationError;
    const cleanupFailures = [];
    try {
      for (let index = 0; index < RPCS.length; index += 1) {
        const peer = new pg.Client({ connectionString, ssl: false, application_name: `steward-desk-wave-${repetition}-${index}` });
        // A connection can succeed while BEGIN, timeout setup, or claims setup
        // fails. Register before connect so every acquired client is ended.
        peers.push(peer);
        await peer.connect();
        await peer.query("begin read only");
        await peer.query("set local statement_timeout = '8s'");
        await asSteward(peer, identity);
      }
      const started = performance.now();
      const results = await Promise.all(peers.map(async (peer, index) => {
        const rpcStarted = performance.now();
        const result = await peer.query(RPCS[index][1]);
        return { name: RPCS[index][0], rows: result.rowCount, wall_ms: performance.now() - rpcStarted };
      }));
      samples.push({ wall_ms: performance.now() - started, sum_ms: results.reduce((sum, row) => sum + row.wall_ms, 0), rpcs: results });
    } catch (error) {
      operationError = error;
    } finally {
      await Promise.all(peers.map(async (peer) => {
        try {
          await peer.query("rollback");
        } catch (error) {
          cleanupFailures.push(error);
        } finally {
          try {
            await peer.end();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }));
    }
    // Error selection lives outside finally so cleanup always completes and
    // ESLint can prove no cleanup path unexpectedly replaces the operation.
    if (operationError) {
      if (cleanupFailures.length) operationError.cleanupFailures = cleanupFailures;
      throw operationError;
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "steward desk wave cleanup failed");
  }
  return samples;
}

export async function stewardDeskExplainPlans(client) {
  const plans = {};
  const statements = {
    awaitingReply: `
      select count(*) from public.member_conversations c
      where (select m.sender_kind from public.member_messages m
        where m.conversation_id = c.id
        order by m.created_at desc, m.id desc limit 1) = 'member'`,
    conversationsPage: `
      select c.* from public.member_conversations c
      order by c.updated_at desc, c.id desc limit 20`,
  };
  for (const [name, statement] of Object.entries(statements)) {
    const { rows } = await client.query(`explain (analyze, buffers, format json) ${statement}`);
    plans[name] = rows[0]["QUERY PLAN"][0];
  }
  return plans;
}

async function main() {
  const databaseUrl = assertDisposableProfileUrl(DATABASE_URL);
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false, application_name: "steward-desk-scale-profile" });
  await client.connect();
  try {
    await client.query("begin");
    await cleanupStewardDeskScale(client);
    await client.query("commit");
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local track_functions = 'all'");
    const identity = await seed(client);
    await client.query("commit");
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local track_functions = 'all'");
    const counts = await scaleCounts(client);
    const fixture = await assertStewardDeskScaleFixture(client);
    const definitions = await stewardDeskDefinitionManifest(client);
    // The local Supabase image preloads auto_explain.  `postgres` is not a
    // catalog superuser in that image, so a redundant LOAD is rejected even
    // though the session settings below are available and take effect.
    await client.query("set local auto_explain.log_nested_statements = on");
    await client.query("set local auto_explain.log_min_duration = 0");
    await client.query("set local auto_explain.log_analyze = on");
    await asSteward(client, identity);
    const rpcs = await profileStewardDeskScale(client);
    const plans = await stewardDeskExplainPlans(client);
    await client.query("commit");
    const wave = await parallelStewardDeskWave(databaseUrl, identity);
    process.stdout.write(`${JSON.stringify({ counts, fixture, definitions, rpcs, wave, plans }, null, 2)}\n`);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.query("begin");
    await cleanupStewardDeskScale(client);
    await client.query("commit");
    await client.end();
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
