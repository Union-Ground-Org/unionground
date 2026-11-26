import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';

// An owned disposable PostgreSQL fixture. The real current toggle body runs
// against a minimal source/MFA substrate. This verifies migration preservation
// and behavior, not the complete hosted RLS or lifecycle graph implementations.
const IMAGE = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const fixture = `recovered-reactions-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'recovered-reactions-'));
const migration = readFileSync(new URL('../supabase/migrations/20261001010000_recovered_message_reaction_artwork.sql', import.meta.url), 'utf8');
const originalGuard = "p_reaction not in ('like','support','celebrate','solidarity','strength')";
const expandedGuard = "p_reaction not in ('like','support','celebrate','solidarity','strength','seen','agreed','care','grievance','victory')";
const original = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'), migration.lastIndexOf('COMMIT;')).trim().replace(expandedGuard, originalGuard);
// Independently captured from two exact-20260928221008 local schemas, before
// this migration was written. No later guard can disappear into the fixture.
assert.equal(createHash('sha256').update(original.replace(/;$/, '\n')).digest('hex'),
  '2927a759e87d86545b60a18b1852bac10140d609b404aa1cfcad2f99c1ec589f');
let db; let connectionString; let started = false; let beforeMetadata;
const actor = '00000000-0000-4000-8000-000000000001';
const message = '00000000-0000-4000-8000-000000000002';
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function configure(client, { user = actor, mfa = true, access = true } = {}) {
  await client.query("select set_config('test.actor',$1,false), set_config('test.mfa',$2,false), set_config('test.access',$3,false)", [user ?? '', String(mfa), String(access)]);
}
async function metadata() {
  return (await db.query("select prosrc,proacl::text,proowner,prosecdef,proconfig from pg_proc where oid='public.toggle_member_message_reaction(text,uuid,text)'::regprocedure")).rows[0];
}
async function toggle(kind, source = 'private', client = db) {
  return (await client.query('select public.toggle_member_message_reaction($1,$2,$3) as result', [source, message, kind])).rows[0].result;
}
before(async () => {
  docker(['run', '--detach', '--rm', '--name', fixture, '--env', 'POSTGRES_PASSWORD=postgres',
    '--mount', `type=bind,src=${dir},dst=/var/lib/postgresql/data`, '--publish', '127.0.0.1::5432', IMAGE]);
  started = true;
  const port = docker(['port', fixture, '5432/tcp']).split(':').at(-1);
  connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 240; i += 1) {
    db = new pg.Client({ connectionString, connectionTimeoutMillis: 500 });
    try { await db.connect(); break; } catch (error) {
      await db.end().catch(() => {});
      if (i === 239) throw new Error(`Owned PostgreSQL fixture did not become ready: ${docker(['logs', fixture])}`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  await db.query(`create schema auth; create schema private; create role authenticated; create role anon;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
    create function private.mfa_satisfied() returns boolean language sql as $$select current_setting('test.mfa',true)::boolean$$;
    create function private.can_read_message_source(uuid,text,uuid,uuid,uuid) returns boolean language sql as $$select current_setting('test.access',true)::boolean$$;
    create function private.lock_message_lifecycle() returns void language sql as $$select pg_advisory_xact_lock(710509)$$;
    create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$select pg_advisory_xact_lock(710510)$$;
    create table public.member_message_reactions(id uuid primary key default gen_random_uuid(), actor_id uuid, source_kind text, private_message_id uuid,channel_post_id uuid,task_message_id uuid,reaction text,
      constraint member_message_reactions_reaction_check check(reaction in ('like','support','celebrate','solidarity','strength')));
    ${original}
    revoke all on function public.toggle_member_message_reaction(text,uuid,text) from public;
    grant execute on function public.toggle_member_message_reaction(text,uuid,text) to authenticated;
    insert into public.member_message_reactions(actor_id,source_kind,private_message_id,reaction) values ('${actor}','private','${message}','support');`);
  beforeMetadata = await metadata();
  await db.query(migration);
  await configure(db);
});
after(async () => {
  await db?.end().catch(() => {});
  if (started) {
    docker(['exec', '--user', '0', fixture, 'chown', '-R', `${process.getuid()}:${process.getgid()}`, '/var/lib/postgresql/data']);
    docker(['rm', '--force', fixture]);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('changes only the exact current vocabulary and preserves security mode, ACL, locks and historical rows', async () => {
  const afterMetadata = await metadata();
  assert.equal(afterMetadata.prosrc.replace(expandedGuard, originalGuard), beforeMetadata.prosrc);
  assert.deepEqual({ ...afterMetadata, prosrc: '' }, { ...beforeMetadata, prosrc: '' });
  assert.equal((await db.query("select count(*)::int as count from member_message_reactions where reaction='support'")).rows[0].count, 1);
  assert.equal((await db.query("select has_function_privilege('anon','public.toggle_member_message_reaction(text,uuid,text)','execute') as allowed")).rows[0].allowed, false);
});
test('all recovered kinds add and remove under each existing source boundary', async () => {
  for (const source of ['private','channel','task']) for (const kind of ['seen','agreed','solidarity','care','grievance','victory']) {
    assert.equal((await toggle(kind, source)).reacted, true);
    assert.equal((await toggle(kind, source)).reacted, false);
  }
  assert.equal((await toggle('support')).reacted, false, 'the existing legacy reaction remains removable');
});
test('MFA, missing-session, source-access and vocabulary denials cannot write a reaction', async () => {
  for (const options of [{ mfa: false }, { user: null }, { access: false }]) {
    await configure(db, options);
    await assert.rejects(toggle('care'), error => ['42501','22023'].includes(error.code));
  }
  await configure(db);
  await assert.rejects(toggle('unknown'), error => error.code === '22023');
  await assert.rejects(toggle('care', 'announcement'), error => error.code === '22023');
  assert.equal((await db.query('select count(*)::int as count from member_message_reactions')).rows[0].count, 0);
});
test('two concurrent toggles serialize without duplicate counts', async () => {
  const second = new pg.Client({ connectionString }); await second.connect();
  try {
    await configure(second);
    const result = await Promise.all([toggle('victory'), toggle('victory', 'private', second)]);
    assert.deepEqual(result.map(row => row.reacted).sort(), [false, true]);
    assert.equal((await db.query("select count(*)::int as count from member_message_reactions where reaction='victory'")).rows[0].count, 0);
  } finally { await second.end(); }
});
