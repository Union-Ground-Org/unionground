// @vitest-environment node
// #9274: the migration must refuse a changed producer before its first DDL.
import {createHash} from 'node:crypto';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';
import {loadMigrationSql, migrationFiles} from './helpers/migration.js';
import {coordinationReplayNames} from './helpers/coordination-operation-replay.mjs';

const migration = loadMigrationSql('coordination_operation_replay_scope');
const guard = migration.match(/do \$guard\$[\s\S]*?end \$guard\$;/i)?.[0];
const pins = [...(guard ?? '').matchAll(/oid='([^']+)'::regprocedure\)\s+is distinct from '([a-f0-9]{32})'/g)]
  .map(match => ({signature:match[1],name:match[1].slice('public.'.length).split('(')[0],hash:match[2]}));
const md5 = value => createHash('md5').update(value).digest('hex');

// Read each newest declaration before this migration, retaining comments and
// whitespace because prosrc hashes those too. The lifecycle migration wrapped
// the older declarations; reproduce its exact, reviewed source transformation.
function mainPredecessor(name) {
  let source;
  const pattern = new RegExp("^\\s*create\\s+(?:or\\s+replace\\s+)?function\\s+public\\." + name
    + "\\([\\s\\S]*?\\bas\\s+(\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\1\\s*;", 'gim');
  for (const file of migrationFiles()) {
    if (file.name.endsWith('_coordination_operation_replay_scope.sql')) break;
    for (const match of file.sql.matchAll(pattern)) source = {file:file.name,sql:match[0],body:match[2],tag:match[1]};
  }
  if (!source) throw new Error('Missing Main declaration: ' + name);
  if (source.file < '20260907151000_account_deletion_finalization_reconciliation.sql') {
    const trimmed = source.body.replace(/[\n\r\t ]+$/, '');
    const wrapped = '\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n'
      + trimmed + (trimmed.endsWith(';') ? '' : ';') + '\nend;\n';
    source.sql = source.sql.replace(source.body, wrapped);
    source.body = wrapped;
  }
  return source;
}
const predecessors = coordinationReplayNames.map(name => ({name,...mainPredecessor(name)}));

describe('coordination replay predecessor preflight', () => {
  it('pins independently computed newest Main sources for exactly the six producers', () => {
    expect(pins.map(pin => pin.name).sort()).toEqual([...coordinationReplayNames].sort());
    for (const source of predecessors) {
      expect(pins.find(pin => pin.name === source.name)?.hash, source.name).toBe(md5(source.body));
    }
    console.info('C305 MAIN PREDECESSORS ' + JSON.stringify(predecessors.map(source => ({
      name:source.name,file:source.file,sourceMd5:md5(source.body),
    }))));
  });

  it('runs all six 55000 refusals after the local settings and before any DDL', () => {
    expect(guard).toBeTruthy();
    expect(guard.match(/errcode='55000'/g)).toHaveLength(6);
    expect(migration.indexOf(guard)).toBeGreaterThan(migration.indexOf("set local statement_timeout = '60s';"));
    expect(migration.indexOf(guard) + guard.length).toBeLessThan(migration.indexOf('alter table public.'));
  });
});

// Isolated temporary-schema copies of Main's real producer definitions let
// the actual preflight run both ways without replacing any installed producer.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live('coordination replay preflight on PostgreSQL', () => {
  let db, temporaryGuard;
  const temporaryDefinition = source => source.sql.replace(
    new RegExp('create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.' + source.name + '\\(', 'i'),
    'create or replace function pg_temp.' + source.name + '(');
  beforeAll(async () => {
    db = new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),ssl:false});
    await db.connect(); await db.query('begin');
    await db.query('set local search_path=pg_catalog');
    await db.query('create temporary table c305_guard_session(marker integer)');
    for (const source of predecessors) await db.query(temporaryDefinition(source));
    temporaryGuard = guard;
    for (const pin of pins) temporaryGuard = temporaryGuard.replace("'" + pin.signature + "'",
      "'" + pin.signature.replace('public.', 'pg_temp.') + "'");
  });
  afterAll(async () => { if (db) { await db.query('rollback'); await db.end(); } });

  it('admits the exact newest Main definitions', async () => {
    await expect(db.query(temporaryGuard)).resolves.toBeDefined();
  });

  it.each(coordinationReplayNames)('refuses a source change to %s with 55000', async name => {
    const source = predecessors.find(source => source.name === name);
    await db.query('savepoint changed_predecessor');
    let failure;
    try {
      await db.query(temporaryDefinition({...source,sql:source.sql.replace(source.body,
        source.body + '\n-- C305 proof: changed predecessor.\n')}));
      await db.query(temporaryGuard);
    } catch (error) { failure = error; }
    await db.query('rollback to savepoint changed_predecessor');
    await db.query('release savepoint changed_predecessor');
    expect(failure?.code).toBe('55000');
    expect(failure?.message).toBe('unreviewed public.' + name + ' predecessor');
  });
});
