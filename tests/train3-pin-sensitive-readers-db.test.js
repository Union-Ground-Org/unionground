// @vitest-environment node
// Train 3 readers must not reopen the sensitive surfaces that PIN sign-in closes.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFunctions, codeOnly } from '../scripts/account-case-graph-inventory.mjs';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
const readers = [
  {
    "name": "public.get_compass_case_context",
    "sql": "select public.get_compass_case_context($1::uuid)",
    "uuidArgs": 1
  },
  {
    "name": "public.get_compass_nudges",
    "sql": "select public.get_compass_nudges()",
    "uuidArgs": 0
  },
  {
    "name": "public.list_compass_pinned_answers",
    "sql": "select public.list_compass_pinned_answers()",
    "uuidArgs": 0
  },
  {
    "name": "public.set_compass_answer_pinned",
    "sql": "select public.set_compass_answer_pinned($1::uuid,false)",
    "uuidArgs": 1
  },
  {
    "name": "public.get_compass_staff_data_context",
    "sql": "select public.get_compass_staff_data_context(array['members']::text[])",
    "uuidArgs": 0
  },
  {
    "name": "public.get_member_operational_profile",
    "sql": "select public.get_member_operational_profile($1::uuid)",
    "uuidArgs": 1
  },
  {
    "name": "public.get_organization_coordination_export_payload",
    "sql": "select public.get_organization_coordination_export_payload($1::uuid)",
    "uuidArgs": 1
  },
  {
    "name": "public.list_google_drive_filing_targets",
    "sql": "select public.list_google_drive_filing_targets()",
    "uuidArgs": 0
  },
  {
    "name": "public.get_task_checkoff_list",
    "sql": "select public.get_task_checkoff_list($1::uuid)",
    "uuidArgs": 1
  },
  {
    "name": "public.list_task_checkoff_candidates",
    "sql": "select public.list_task_checkoff_candidates($1::uuid)",
    "uuidArgs": 1
  },
  {
    "name": "public.authorize_google_drive_filing",
    "sql": "select public.authorize_google_drive_filing('create_folder','case',$1::text)",
    "uuidArgs": 1
  },
  {
    "name": "public.create_task_checkoff_list",
    "sql": "select public.create_task_checkoff_list($1::uuid,'split',array[]::uuid[],array[]::uuid[],'[]'::jsonb)",
    "uuidArgs": 1
  },
  {
    "name": "public.set_task_checkoff_entry",
    "sql": "select public.set_task_checkoff_entry($1::uuid,'complete','',null::text)",
    "uuidArgs": 1
  },
  {
    "name": "public.set_task_checkoff_list_status",
    "sql": "select public.set_task_checkoff_list_status($1::uuid,'complete')",
    "uuidArgs": 1
  },
  {
    "name": "public.get_organization_analytics_snapshot",
    "sql": "select public.get_organization_analytics_snapshot()",
    "uuidArgs": 0
  },
  {
    "name": "public.get_organization_analytics_workspace",
    "sql": "select public.get_organization_analytics_workspace()",
    "uuidArgs": 0
  },
  {
    "name": "public.get_chapter_health_portfolio",
    "sql": "select public.get_chapter_health_portfolio()",
    "uuidArgs": 0
  },
  {
    "name": "public.freeze_chapter_connection_issue_aggregates",
    "sql": "select public.freeze_chapter_connection_issue_aggregates('admin',$1::text)",
    "uuidArgs": 1
  },
  {
    "name": "public.list_chapter_leadership_claims",
    "sql": "select public.list_chapter_leadership_claims(50)",
    "uuidArgs": 0
  },
  {
    "name": "public.list_officer_removal_targets",
    "sql": "select public.list_officer_removal_targets('chapter')",
    "uuidArgs": 0
  }
];
const functions = readMigrationFunctions(new URL('../supabase/migrations', import.meta.url).pathname);
describe('train 3 restricted-session entry ordering', () => {
  it.each(readers)('$name refuses before evaluated declarations and content lookups', ({ name }) => {
    const body = codeOnly(functions.find(fn => fn.name === name).source);
    const first = body.indexOf('begin');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(body.slice(0, first)).not.toMatch(/:=|\bdefault\b/);
    const entry = body.slice(first + 5).trimStart().replace(/^perform private\.lock_case_graph(?:_read)?\([^;]*;\s*/u, '');
    expect(entry).toMatch(/^perform private\.member_pin_require_full_session\(\);/u);
  });
});
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live('train 3 restricted-session live readers', () => {
  let db;
  const user = '51003210-0000-4000-8000-000000000101';
  const org = '51003210-0000-4000-8000-000000000001';
  const session = '51003210-0000-4000-8000-000000000201';
  const absent = '51003210-0000-4000-8000-000000000999';
  async function call(row) {
    await db.query('savepoint reader_observation');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:user,role:'authenticated',session_id:session,aal:'aal2' })]);
      await db.query('set local role authenticated');
      const result = await db.query(row.sql, Array(row.uuidArgs).fill(absent));
      return { rows: result.rows };
    } catch (error) {
      return { code:error.code, message:error.message };
    } finally {
      await db.query('rollback to savepoint reader_observation');
      await db.query('release savepoint reader_observation');
    }
  }
  beforeAll(async () => {
    db = new pg.Client({ connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),ssl:false,application_name:'train3-pin-readers-proof' });
    await db.connect(); await db.query('begin');
    await db.query("set local statement_timeout='30s'");
    await db.query("insert into auth.users(id,email) values($1,'train3-pin@example.invalid')", [user]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,'train3-pin-org','PIN reader proof',$2)", [org,user]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org,user]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session,user]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values(gen_random_uuid(),$1,'totp','verified',now(),now())", [user]);
  },30000);
  afterAll(async () => { if(db) { await db.query('rollback').catch(()=>{}); await db.end(); } });
  it.each(readers)('$name refuses a PIN session and preserves full-session authorization', async row => {
    const full = await call(row);
    expect(full.message).not.toBe('step-up required');
    // Wrong signatures or missing functions must never count as a refusal proof.
    expect(full.code).not.toBe('42883');
    await db.query('insert into private.member_pin_sessions(session_id,user_id) values($1,$2)', [session,user]);
    try { expect(await call(row)).toEqual({code:'42501',message:'step-up required'}); }
    finally { await db.query('delete from private.member_pin_sessions where session_id=$1', [session]); }
    expect(await call(row)).toEqual(full);
  });
});
