// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const unlock = read('20261012010000_production_residue_window_unlock.sql');
const relock = read('20261012010003_production_residue_window_relock.sql');
const predecessor = read('20260927110000_uniondemo_production_removal_window_unlock.sql');
const triggers = ['forbid_organization_audit_mutation', 'mi1_audit_ledger_append_only'];
const definition = (sql, name) => sql.match(new RegExp(`CREATE OR REPLACE FUNCTION private\\.${name}\\(\\)[\\s\\S]*?AS \\$function\\$\\n[\\s\\S]*?\\$function\\$\\n`, 'i'))?.[0];

describe('production residue attended window migrations', () => {
  it('pins the production installation and keeps the owner window closed on installation', () => {
    for (const source of [unlock, relock]) {
      expect(source).toContain('productionprojectref');
      expect(source).toContain('7662742571317219726');
      expect(source).toMatch(/(?:pinned_database_oid constant oid := 5|database oid 5)/);
      expect(source).toMatch(/\nbegin;\n/);
      expect(source).toMatch(/\ncommit;\s*$/);
    }
    expect(unlock).not.toMatch(/insert into private\.production_residue_windows/i);
    expect(unlock).toContain('5155e1a3ed12485fe08548293aa3c12c49bf16bf0e0fbce8a4072914d7688a20');
  });

  it('keeps the predecessor database stamp without the Eastern band or the 4 h 50 min cap (owner order October 14)', () => {
    const body = source => source.match(/as \$stamp_window\$([\s\S]*?)\$stamp_window\$/)[1];
    const band = /\n {2}eastern_opened_at timestamp :=[^\n]*|\n {2}if eastern_opened_at::time[\s\S]*?\n {2}end if;/g;
    expect(body(predecessor).match(band)).toHaveLength(2);
    const update = "\n  if tg_op = 'UPDATE' then\n    new.opened_at := old.opened_at;\n  else\n    new.opened_at := database_opened_at;\n  end if;";
    expect(body(unlock)).toBe(body(predecessor).replace(band, '').replace('\n  new.opened_at := database_opened_at;', update));
    expect(unlock).not.toContain('production_residue_window_eastern_interval');
    expect(unlock).not.toContain('must open between 12:10 and 5:00 AM ET');
    expect(unlock).not.toMatch(/time '0[05]:[01]0'|4 hours 50 minutes/);
    expect(unlock).toContain("and expires_at <= opened_at + interval '24 hours')");
    expect(unlock).toContain("or active_window.expires_at > active_window.opened_at + interval '24 hours' then");
    expect(unlock).toContain("active_window.expires_at <= checked_at");
  });

  it('drops every new function, trigger and table without cascade', () => {
    for (const match of unlock.matchAll(/create (function|table|trigger) ((?:private|public)\.)?(production_residue_\w+)/gi)) {
      expect(relock).toMatch(new RegExp(`drop ${match[1]} ${match[2] || ''}${match[3]}\\b`, 'i'));
    }
    expect(relock).not.toMatch(/\bcascade\b/i);
  });

  it('restores each captured trigger exactly and adds only one branch to each', () => {
    for (const name of triggers) {
      const restored = definition(relock, name);
      const installed = definition(unlock, name);
      expect(restored).toBeTruthy();
      const hash = createHash('sha256').update(restored).digest('hex');
      expect(unlock).toContain(`captured Main body SHA-256: ${hash}`);
      expect(relock).toContain(`captured Main body SHA-256: ${hash}`);
      const stripped = installed.replace(/\n {2}if tg_op = 'DELETE' and[\s\S]*?\n {2}end if;/, '');
      expect(stripped).toBe(restored);
      expect(installed).toContain("l.cohort = 'org'");
      expect(installed).toContain("w.expires_at > pg_catalog.clock_timestamp()");
    }
  });

  it('grants only the four service-role entrypoints and revokes every private object', () => {
    const grants = [...unlock.matchAll(/grant execute on function ([^;]+) to service_role;/gi)].map(x => x[1]);
    expect(grants).toEqual([
      'public.production_residue_fill_ledger(text, text)',
      'public.production_residue_revoke_sessions(text, text, text)',
      'public.production_residue_remove_batch(text, integer, text, text)',
      'public.production_residue_status()',
    ]);
    for (const name of [...unlock.matchAll(/create function private\.(production_residue_\w+)/gi)].map(x => x[1])) {
      expect(unlock).toMatch(new RegExp(`revoke all on function private\\.${name}\\([^;]*from public, anon, authenticated, service_role;`));
    }
    expect(unlock.match(/enable row level security/g)).toHaveLength(4);
    expect(unlock).toContain('revoke all on table private.production_residue_kept_scope from public, anon, authenticated, service_role');
    expect(unlock).toContain('revoke all on table private.production_residue_audit_context from public, anon, authenticated, service_role');
    expect(unlock).not.toContain('unionground.production_residue_org');
  });

  it('introduces no identifier literal except the two authorized run IDs', () => {
    const allowed = new Set(['109141a8-bb29-4b02-af4f-f00ff45ba2ea', '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d']);
    for (const match of (unlock + relock).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) expect(allowed.has(match[0])).toBe(true);
  });

  it('does not replace any seed, login, apply or snapshot-refresh capability', () => {
    expect([...unlock.matchAll(/create or replace function ([^ (]+)/gi)].map(x=>x[1])).toEqual(triggers.map(x=>`private.${x}`));
    expect(unlock).not.toMatch(/update private\.(?:uniondemo|member_stress)_runs|delete from public\.member_messages|disable trigger/i);
    expect(unlock).toContain("private.redact_member_message_row(message_id, 'account_closed', null)");
  });

  it('fails closed on new dependencies and enforces all reviewed cohort counts', () => {
    expect(unlock).not.toContain('october_7_disposition');
    expect(unlock).toContain("p_cohort in ('account-4a', 'account-4b', 'account-4c')");
    expect(unlock).toContain('production residue unremoved or unreviewed dependency');
    expect(unlock).toContain('perform private.production_residue_check_references(selected_org, true)');
    expect(unlock).toContain('perform private.production_residue_check_references(selected_org, false)');
    expect(unlock).toContain('"org":10,"org-kept":1,"chapter":18,"chapter-kept":1,"account-4a":31,"account-4b":1,"account-kept":1,"account-4c":1,"account-bootstrap":4');
  });
});
