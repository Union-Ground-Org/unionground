// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import pg from 'pg';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const read = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const f2 = read('20261012010001_production_residue_seed_lanes_unlock.sql');
const f4 = read('20261012010003_production_residue_window_relock.sql');
const definition = sql => sql.match(/CREATE OR REPLACE FUNCTION private\.mi1_bind_case_owner\(\)[\s\S]*?\$function\$\n[\s\S]*?\$function\$\n/)[0];
const canonical = definition(f4);
const hash = createHash('sha256').update(canonical).digest('hex');
const substitutedHash = createHash('sha256').update(definition(f2)).digest('hex');
const restoreGuard = f4.match(/do \$case_owner_restore_hash\$[\s\S]*?\$case_owner_restore_hash\$;/)[0];

it('changes only the legacy UPDATE ownership comparison and restores the captured definition', () => {
  expect(hash).toBe('a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933');
  expect(f2).toContain(`('private.mi1_bind_case_owner()', '${hash}', '${substitutedHash}')`);
  expect(f2.indexOf("('private.mi1_bind_case_owner()'")).toBeLessThan(f2.indexOf('CREATE OR REPLACE FUNCTION private.mi1_bind_case_owner()'));
  expect(definition(f2)).toBe(canonical.replace(
    'if new.organization_id is not null or new.chapter_id is not null then',
    'if new.organization_id is distinct from old.organization_id\n         or new.chapter_id is distinct from old.chapter_id then',
  ));
  expect(f4).toContain(`-- captured Main body SHA-256: ${hash}`);
  expect(restoreGuard).toContain(hash);
  expect(restoreGuard).toContain(substitutedHash);
  expect(restoreGuard.replace(/\$captured_case_owner\$[\s\S]*?\$captured_case_owner\$/, '')).not.toContain('raise exception');
  expect(restoreGuard).toContain("raise warning 'production residue case owner source changed; preserved; full restoration failed'");
  expect(f4.indexOf(restoreGuard)).toBeLessThan(f4.indexOf('CREATE OR REPLACE FUNCTION'));
  expect(f4.indexOf('CREATE OR REPLACE FUNCTION private.mi1_bind_case_owner()')).toBeLessThan(f4.indexOf('drop table private.production_residue_windows;'));
});

const dbTest = process.env.REQUIRE_DB_REPAIR_PROOFS === '1' ? it : it.skip;
dbTest('F4 restores canonical or T7 definitions and preserves drift without blocking containment', async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await db.connect();
  await db.query('begin');
  try {
    for (const source of [canonical, definition(f2)]) {
      await db.query(source);
      await db.query(restoreGuard);
      expect((await db.query("select pg_get_functiondef('private.mi1_bind_case_owner()'::regprocedure) body")).rows[0].body).toBe(canonical);
    }
    const drifted = canonical.replace('declare\n', 'declare\n  -- unrelated emergency repair\n');
    await db.query(drifted);
    const warnings = [];
    db.on('notice', notice => warnings.push(notice.message));
    await db.query(restoreGuard);
    expect(warnings).toContain('production residue case owner source changed; preserved; full restoration failed');
    expect((await db.query("select pg_get_functiondef('private.mi1_bind_case_owner()'::regprocedure) body")).rows[0].body).toBe(drifted);
  } finally {
    await db.query('rollback');
    await db.end();
  }
});
dbTest('legacy SET NULL succeeds only with the substitution; ownership changes still refuse; restore refuses again', async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await db.connect();
  await db.query('begin');
  try {
    await db.query('create temporary table t7_actors(id integer primary key); insert into t7_actors values(1),(2)');
    await db.query(`create temporary table t7_cases(organization_id uuid, chapter_id text,
      coordinator_user_id integer references t7_actors on delete set null);
      insert into t7_cases values(null,'legacy-chapter',1);
      create trigger t7_owner before update on t7_cases for each row execute function private.mi1_bind_case_owner()`);
    const refuses = async sql => {
      await db.query('savepoint refused');
      await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' });
      await db.query('rollback to savepoint refused');
    };
    await db.query(canonical);
    await refuses('delete from t7_actors where id=1');
    await db.query(definition(f2));
    await refuses("update t7_cases set chapter_id='other-chapter'");
    await refuses('update t7_cases set chapter_id=null');
    await refuses("update t7_cases set organization_id='00000000-0000-4000-8000-000000000001'");
    await db.query('delete from t7_actors where id=1');
    expect((await db.query('select * from t7_cases')).rows).toEqual([
      { organization_id: null, chapter_id: 'legacy-chapter', coordinator_user_id: null },
    ]);
    await db.query('update t7_cases set coordinator_user_id=2');
    await db.query(canonical);
    await refuses('delete from t7_actors where id=2');
  } finally {
    await db.query('rollback');
    await db.end();
  }
});
