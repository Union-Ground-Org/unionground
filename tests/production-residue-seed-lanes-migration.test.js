// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFunctions } from '../scripts/account-case-graph-inventory.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const unlock = read('supabase/migrations/20261012010001_production_residue_seed_lanes_unlock.sql');
const relock = read('supabase/migrations/20261012010002_production_residue_seed_lanes_relock.sql');
const manifest = JSON.parse(read('config/production-residue-seed-lanes-sources.json'));
const predecessor = read('supabase/migrations/20260927110000_uniondemo_production_removal_window_unlock.sql');
const digest = text => createHash('sha256').update(text).digest('hex');
const functions = sql => new Map(parseFunctions(sql).map(fn => [fn.name, fn]));
const opened = functions(unlock), closed = functions(relock);
function definition(sql, name) {
  const escaped = name.replace('.', '\\.');
  const start = sql.search(new RegExp(`^CREATE OR REPLACE FUNCTION ${escaped}\\(`, 'm'));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start);
  const marker = /\bAS (\$\w*\$)/.exec(body);
  expect(marker, name).not.toBeNull();
  const end = body.indexOf(marker[1], marker.index + marker[0].length);
  // pg_get_functiondef ends after the dollar tag and newline; the migration's
  // separate statement terminator is not part of that canonical definition.
  return body.slice(0, end + marker[1].length) + '\n';
}

describe('production residue seed lane window', () => {
  it('captures exactly the six removal definitions', () => {
    expect(manifest.functions.map(entry => entry.signature.split('(')[0])).toEqual([
      'public.remove_mi1_knowledge_sample', 'public.uniondemo_remove_function_parity',
      'public.uniondemo_begin_remove', 'public.uniondemo_remove_batch',
      'public.member_stress_begin_remove', 'public.member_stress_remove_batch',
    ]);
    expect([...closed.keys()]).toEqual(manifest.functions.map(entry => entry.signature.split('(')[0]));
    expect(manifest.functions.filter(entry => entry.main_replay_variant_sha256)).toHaveLength(4);
  });

  it.each(manifest.functions)('uses one exact substitution and byte-for-byte relock: $signature', entry => {
    const name = entry.signature.split('(')[0];
    const original = definition(relock, name), replacement = definition(unlock, name);
    expect(digest(original)).toBe(entry.definition_sha256);
    expect(digest(closed.get(name).source)).toBe(entry.source_sha256);
    expect(original.split(entry.substitution.from)).toHaveLength(2);
    expect(original.replace(entry.substitution.from, entry.substitution.to)).toBe(replacement);
    expect(digest(replacement)).toBe(entry.unlock_definition_sha256);
    if (entry.main_replay_variant_sha256) {
      expect(digest(original.replace('AS $function$\n', 'AS $function$\n\n'))).toBe(entry.main_replay_variant_sha256);
    }
    expect(replacement.slice(0, replacement.indexOf('AS $function$')))
      .toBe(original.slice(0, original.indexOf('AS $function$')));
    expect(opened.get(name).source).toContain('perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);');
    expect(opened.get(name).source.includes('perform private.lock_message_lifecycle();'))
      .toBe(closed.get(name).source.includes('perform private.lock_message_lifecycle();'));
  });

  it('routes only the four uniondemo removers and two stress removers', () => {
    expect([...opened.keys()].filter(name => name.startsWith('public.'))).toEqual([...closed.keys()]);
    expect(unlock).not.toMatch(/(?:create|alter)\s+(?:or replace\s+)?function\s+private\.(?:uniondemo|member_stress)_authorize/i);
    for (const [name, fn] of opened) {
      if (!name.startsWith('public.')) continue;
      const lane = name.includes('member_stress') ? 'member_stress' : 'uniondemo';
      expect(fn.source).toContain("if p_target_ref = 'productionprojectref' then");
      expect(fn.source.match(new RegExp(`perform private.production_residue_authorize\\('${lane}'`, 'g'))).toHaveLength(1);
      expect(fn.source.match(/return residue_result;/g)).toHaveLength(fn.source.match(/perform private.production_residue_seed_assert_active\(\);/g).length);
      if (lane === 'uniondemo') expect(fn.source).toContain('perform private.uniondemo_authorize(p_target_ref, p_confirm_token);');
      else {
        expect(fn.source.indexOf('perform private.production_residue_authorize('))
          .toBeLessThan(fn.source.indexOf('perform private.member_stress_authorize('));
        expect(fn.source).toContain("if p_run_id is distinct from '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d'::uuid then");
        expect(fn.source).toContain('perform private.member_stress_authorize(p_target_ref, p_confirm_token);');
      }
    }
    expect(unlock).not.toMatch(/\bgrant\s/i);
  });

  it('uses accounted snapshots only for production and retains every other comparison', () => {
    for (const lane of ['uniondemo', 'member_stress']) {
      for (const operation of ['begin_remove', 'remove_batch']) {
        const source = opened.get(`public.${lane}_${operation}`).source;
        expect(source).toContain(`not private.production_residue_snapshot_accounted(run.protected_snapshot, private.${lane}_protected_snapshot(p_run_id), '${lane}')`);
        expect(source).toContain(`else run.protected_snapshot <> private.${lane}_protected_snapshot(p_run_id) end`);
      }
    }
    expect(definition(unlock, 'public.member_stress_begin_remove')).toContain("SET statement_timeout TO '120s'");
    expect(definition(unlock, 'public.member_stress_remove_batch')).toContain("SET statement_timeout TO '120s'");
  });

  it('retains reviewed checks and adds event organizers and retained root provenance', () => {
    const old = functions(predecessor);
    expect(opened.get('private.production_residue_actors_owned').source)
      .toBe(old.get('private.uniondemo_production_removal_actors_owned').source.replace("'user_id', 'watcher_id'", "'user_id', 'watcher_id', 'organizer_id'"));
    const guard = opened.get('private.production_residue_uniondemo_preflight').source;
    const before = old.get('private.uniondemo_production_removal_authorize').source;
    expect(before).toContain('uniondemo_production_removal_actors_owned');
    for (const table of ['chapter_workstreams','member_events','member_ballots','member_surveys','member_broadcasts']) {
      expect(guard).toContain(`private.production_residue_root_owned(p_run_id, '${table}'`);
      expect(guard).toContain(`select p_run_id, '${table}', body ->> 'id', body`);
    }
    expect(guard).toContain("p_run_id is distinct from '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid");
    expect(guard).toContain('run.member_count = 30000');
    expect(guard).toContain('private.uniondemo_ledger where run_id = p_run_id) <> 30000');
    expect(guard).toContain('from auth.sessions as sessions');
    expect(guard).toContain('from auth.refresh_tokens as tokens');
    expect(guard).toContain("users.raw_app_meta_data ->> 'uniondemo_run_id' is distinct from p_run_id::text");
  });

  it('drops all temporary helpers and preserves existing public ACLs', () => {
    for (const name of [...opened.keys()].filter(name => name.startsWith('private.production_residue_'))) {
      expect(unlock).toContain(`revoke all on function ${name}(`);
      expect(relock).toContain(`drop function if exists ${name}(`);
    }
    expect(unlock.match(/from public, anon, authenticated, service_role;/g)).toHaveLength(7);
    expect(relock).toContain('drop table if exists private.production_residue_root_ownership;');
    expect(unlock).toContain('alter table private.production_residue_root_ownership enable row level security;');
    expect(relock).not.toMatch(/\b(?:grant|revoke)\b/i);
  });

  it('refuses to replace a drifted live definition before creating capabilities', () => {
    expect(unlock.indexOf('do $source_hashes$')).toBeLessThan(unlock.indexOf('create function private.'));
    for (const entry of manifest.functions) {
      expect(unlock).toContain(`('${entry.signature}', '${entry.definition_sha256}', `);
      if (entry.main_replay_variant_sha256) expect(unlock).toContain(entry.main_replay_variant_sha256);
    }
    expect(unlock).toContain('production_installation or entry.replay_sha256 is null');
    expect(unlock).toContain('current_sha256 is distinct from entry.replay_sha256');
    expect(unlock).toContain('live_system_identifier is not distinct from pinned_system_identifier');
    expect(unlock).toContain('live_database_oid is not distinct from pinned_database_oid');
    expect(unlock).toContain("raise exception 'production residue seed source changed; unlock refused'");
    expect(relock.indexOf('do $restore_hashes$')).toBeLessThan(relock.indexOf('CREATE OR REPLACE FUNCTION'));
    for (const entry of manifest.functions) {
      expect(relock).toContain(`('${entry.signature}', '${entry.definition_sha256}', '${entry.unlock_definition_sha256}')`);
    }
    expect(relock).toContain("raise exception 'production residue seed source changed; relock refuses overwrite'");
  });
});
