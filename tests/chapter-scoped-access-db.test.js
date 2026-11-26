// @vitest-environment node
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';
import {runPreparedProofMatrix} from './helpers/chapter-scoped-access-proof.mjs';
const migration=readFileSync(new URL('../supabase/migrations/20261102005607_unit_committee_scoped_access.sql',import.meta.url),'utf8');
describe('unit/committee access contract',()=>{
  it('keeps one atomic migration, private storage and authenticated role boundaries',()=>{
    expect(migration.trimStart().startsWith('-- REQ-UG-UNIT-AND-COMMITTEE-SCOPED-ACCESS-20261031')).toBe(true);
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
    expect(migration).toContain('private.chapter_case_readable');
    expect(migration).toContain('private.actor_case_scope_and_identity_allowed');
    expect(migration).not.toContain('create_organization_founder_invitation');
  });
});
const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('unit and committee scoped access on an owned disposable database',()=>{
  it('checks target scope, role delegation, committee toggles, private identities and explicit draft shares with positive and negative controls',async()=>{
    const db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'chapter-scoped-access-rollback-proof'});
    await db.connect();await db.query('begin');
    try {const checks=await runPreparedProofMatrix(db);console.info('Chapter access live checks:',checks);expect(checks).toBeGreaterThanOrEqual(85);}
    finally {await db.query('rollback');await db.end();}
  },120000);
});
