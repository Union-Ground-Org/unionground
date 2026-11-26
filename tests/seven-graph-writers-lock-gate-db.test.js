// @vitest-environment node
// BUG-UG-DB-SEVEN-GRAPH-WRITERS-LOST-LOCK-GATE-20261109 (#7771).
// 20261109060229 re-emitted seven direct case graph writers from their August
// create text and dropped the outer private.lock_case_graph block that the
// 20260907151000 case_graph_writers wrapper had installed. The static cases
// run in every root test run, so a later re-emission that loses the gate fails
// pull request CI, not only the merge-group database job.
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  caseGraphWrappedSource, helperFirst, proveCaseGraphInventory, readMigrationFunctions,
} from '../scripts/account-case-graph-inventory.mjs';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { beforeSameRefusals, SAME_REFUSALS_MIGRATION } from './helpers/refusals-same-for-other-organizations.js';

const directory = new URL('../supabase/migrations/', import.meta.url);
const SEVEN = [
  ['public.casework_add_bargaining_event', 'public.casework_add_bargaining_event(uuid,text,text,text)'],
  ['public.casework_add_bargaining_proposal', 'public.casework_add_bargaining_proposal(uuid,text,text,text,timestamp with time zone)'],
  ['public.casework_create_bargaining_workspace', 'public.casework_create_bargaining_workspace(text,text,timestamp with time zone)'],
  ['public.close_chapter_handshake', 'public.close_chapter_handshake(uuid,uuid)'],
  ['public.countersign_chapter_handshake', 'public.countersign_chapter_handshake(uuid,uuid)'],
  ['public.respond_chapter_handshake', 'public.respond_chapter_handshake(uuid,text,uuid)'],
  ['public.share_chapter_handshake_document', 'public.share_chapter_handshake_document(uuid,uuid,uuid)'],
];
const repairFiles = readdirSync(directory).filter(name => name.endsWith('_seven_graph_writers_restore_lock_gate.sql'));
const functions = readMigrationFunctions(directory.pathname);
const latest = name => functions.filter(f => f.name === name);
const UNIT_DOCUMENTS_LINE = "         and private.unit_staff_capability_allows(d.chapter_id, d.access_unit_id, 'documents')\n";
const staffGrantBody = name => functions.historical
  .find(f => f.name === name && f.file === '20261109060229_unit_stewards_join_chapter_collaboration.sql').source;

describe('seven case graph writers keep their first lock gate (static)', () => {
  it('is one atomic repair migration that sorts after the regressing re-emission', () => {
    expect(repairFiles).toHaveLength(1);
    expect(repairFiles[0] > '20261109060229').toBe(true);
    const sql = readFileSync(new URL(repairFiles[0], directory), 'utf8');
    expect(sql.trimStart().startsWith('-- BUG-UG-DB-SEVEN-GRAPH-WRITERS-LOST-LOCK-GATE-20261109')).toBe(true);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect([...sql.matchAll(/^create or replace function ([\w.]+)\(/gm)].map(m => m[1]).sort())
      .toEqual(SEVEN.map(([name]) => name).sort());
  });

  it.each(SEVEN)('%s: newest definition takes the gate first and keeps the staff-grant body', name => {
    const [definition] = latest(name);
    expect(latest(name)).toHaveLength(1);
    expect(helperFirst(definition.source)).toBe(true);
    // Exactly what the 20260907151000 wrapper installs over the #7665 body,
    // apart from #8365's same-refusal lookups.
    // #7667 (per_unit_settings) re-emits the share with one added line: a unit's
    // documents switch narrows sharing a unit document. Apart from that line
    // it is the same wrapped body.
    const source = definition.file === SAME_REFUSALS_MIGRATION ? beforeSameRefusals(name, definition.source)
      : definition.file.endsWith('_per_unit_settings.sql') ? definition.source.replace(UNIT_DOCUMENTS_LINE, '') : definition.source;
    expect(source).toBe(caseGraphWrappedSource(staffGrantBody(name)));
    expect(definition.source).toContain('private.member_has_chapter_staff_grant(');
    expect(definition.source).not.toMatch(/private\.member_has_chapter_role\s*\(/);
  });

  it('keeps the document container check in the handshake document share', () => {
    expect(latest('public.share_chapter_handshake_document')[0].source).toContain('private.chapter_document_container_allows(');
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live('seven case graph writers keep their first lock gate (installed)', () => {
  it('installs the gated bodies with definer rights, an empty search_path and member-free execute grants', async () => {
    const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: 'seven-graph-writers-lock-gate-proof' });
    await client.connect(); await client.query('begin');
    try {
      const version = repairFiles[0].split('_')[0];
      expect((await client.query('select version from supabase_migrations.schema_migrations where version=$1', [version])).rows).toHaveLength(1);
      // regprocedure text drops a schema on the search_path, so name rows by schema.
      const { rows } = await client.query(`select n.nspname || '.' || p.proname name, p.prosrc source, p.prosecdef definer, p.proconfig,
          pg_catalog.pg_get_userbyid(p.proowner) owner, pg_catalog.pg_get_functiondef(p.oid) definition,
          pg_catalog.has_function_privilege('anon', p.oid, 'execute') anon_execute,
          pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') authenticated_execute
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where p.oid = any($1::regprocedure[])`, [SEVEN.map(([, signature]) => signature)]);
      expect(rows.map(row => row.name).sort()).toEqual(SEVEN.map(([name]) => name).sort());
      for (const row of rows) {
        const { name } = row;
        expect(helperFirst(row.source), name).toBe(true);
        expect(row.source, name).toBe(latest(name)[0].source);
        expect(row.definer, name).toBe(true);
        expect(row.proconfig, name).toEqual(['search_path=""']);
        expect(row.owner, name).toBe('postgres');
        expect(row.anon_execute, name).toBe(false);
        expect(row.authenticated_execute, name).toBe(true);
      }
      await proveCaseGraphInventory(client);
      // Stripping the gate from any one of them must fail the installed proof.
      const broken = rows.find(row => row.name === 'public.casework_add_bargaining_event');
      const stripped = broken.definition.replace('perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);', '');
      expect(stripped).not.toBe(broken.definition);
      await client.query(stripped);
      await expect(proveCaseGraphInventory(client)).rejects.toThrow('public.casework_add_bargaining_event');
    } finally {
      await client.query('rollback'); await client.end();
    }
  }, 180_000);
});
