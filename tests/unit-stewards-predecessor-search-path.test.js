// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrationSql } from './helpers/migration.js';
import { offlinePostgres } from './tamarack-postgres-helper.mjs';

const migration = loadMigrationSql('unit_stewards_member_data_per_member');
// Retained history-809 receipts: SAMPLE 2026-11-11 5:54:08 AM ET and
// Production 2026-11-11 6:34:18 AM ET. Both render pg_get_functiondef with
// search_path=''. No hosted connection is used by this proof.
const predecessors = [
  {
    name: 'casework_revoke_access', signature: 'public.casework_revoke_access(uuid)',
    source: '20261104120000_learning_period_case_access_assignment',
    table: 'casework_access_grants',
    publicPathDigest: 'c86154e865b36053f8a96eedb1555b22',
    hostedDigest: 'eee848dc11c065ab11e7dcd6547c2498',
  },
  {
    name: 'casework_add_management_addendum', signature: 'public.casework_add_management_addendum(uuid, text)',
    source: '20260907150000_account_lifecycle_manifest',
    table: 'casework_management_addenda',
    publicPathDigest: '5c40717ae872116317a1082c39c731f2',
    hostedDigest: '7c4d00e97da4945f08abe1c2fc0d2c55',
  },
  {
    name: 'casework_save_intake_draft', signature: 'public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer)',
    source: '20261106220000_conflict_refusals_not_retried',
    table: 'casework_intake_drafts',
    publicPathDigest: '15d25f8218ce79679759226b34336d1c',
    hostedDigest: '6eeb977a7bdc6d670e07ab1fecdd1e73',
  },
].map(row => ({
  ...row,
  definition: loadMigrationSql(row.source).match(new RegExp(
    `create or replace function public\\.${row.name}\\([\\s\\S]*?\\$function\\$;`, 'i',
  ))[0],
}));

const functionGuards = [...migration.matchAll(
  / {2}if pg_catalog\.md5\(pg_catalog\.pg_get_functiondef\(pg_catalog\.to_regprocedure\('([^']+)'\)\)\) is distinct from '([a-f0-9]{32})' then[\s\S]*? {2}end if;/g,
)];
// Exercise these three unmodified IF statements with the migration's real
// path setup and restoration; other functions/policies belong to the full
// from-zero replay. Do not substitute digests or re-emit fixture bodies.
const start = migration.slice(migration.indexOf('begin;') + 'begin;'.length, functionGuards[0].index);
const restore = migration.match(/\$predecessors\$;([\s\S]*?)do \$predecessor_policies\$/)?.[1] ?? '';
const guards = start + functionGuards.filter(([, signature]) => predecessors.some(row => row.signature === signature))
  .map(([statement]) => statement).join('\n') + '\nend;\n$predecessors$;\n' + restore;

describe('unit steward predecessor guards use the hosted definition rendering', () => {
  let database, client;
  beforeAll(async () => {
    database = await offlinePostgres(); client = database.client;
    await client.query('create schema private; create schema extensions');
    // Only composite types are needed: no predecessor is executed, and the
    // complete historical bodies, security and configuration remain intact.
    for (const name of ['casework_access_grants', 'casework_management_entries', 'casework_management_addenda', 'casework_intake_drafts']) {
      await client.query(`create table public.${name} (id uuid)`);
    }
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await client.query('rollback; begin');
    for (const { definition } of predecessors) await client.query(definition);
  });

  it.each(predecessors)('$name matches both retained hashes with identical stored metadata and body', async row => {
    const read = async path => {
      await client.query('select pg_catalog.set_config(\'search_path\', $1, true)', [path]);
      return (await client.query(`select pg_catalog.pg_get_functiondef(oid) as definition,
        pg_catalog.md5(pg_catalog.pg_get_functiondef(oid)) as digest,
        prosrc, proconfig, prosecdef, proowner from pg_catalog.pg_proc
        where oid = pg_catalog.to_regprocedure($1)`, [row.signature])).rows[0];
    };
    const publicPath = await read('pg_catalog, public, extensions');
    const hosted = await read('');
    expect(publicPath.digest).toBe(row.publicPathDigest);
    expect(hosted.digest).toBe(row.hostedDigest);
    expect(hosted.definition).toBe(publicPath.definition.replace(` RETURNS ${row.table}\n`, ` RETURNS public.${row.table}\n`));
    for (const key of ['prosrc', 'proconfig', 'prosecdef', 'proowner']) expect(hosted[key]).toEqual(publicPath[key]);
    expect(functionGuards.find(([, signature]) => signature === row.signature)?.[2]).toBe(hosted.digest);
  });

  it.each(['', 'pg_catalog, public, extensions'])('accepts the hosted definitions from incoming path %j and restores the policy path', async path => {
    await client.query('select pg_catalog.set_config(\'search_path\', $1, true)', [path]);
    await client.query(guards);
    expect((await client.query('show search_path')).rows[0].search_path).toBe('pg_catalog, public, extensions');
  });

  describe.each(predecessors)('$name refuses genuine whole-definition drift', row => {
    it.each(['body', 'search_path', 'security', 'missing'])('refuses %s drift with 55000', async kind => {
      if (kind === 'body') await client.query(row.definition.replace('perform private.casework_require_mfa();', 'perform pg_catalog.now();'));
      if (kind === 'search_path') await client.query(`alter function ${row.signature} set search_path = public`);
      if (kind === 'security') await client.query(`alter function ${row.signature} security invoker`);
      if (kind === 'missing') await client.query(`drop function ${row.signature}`);
      await client.query('savepoint refused');
      await expect(client.query(guards)).rejects.toMatchObject({
        code: '55000', message: `unreviewed predecessor: public.${row.name}`,
      });
      await client.query('rollback to savepoint refused');
    });
  });
});
