// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {fnBody,latestFnBody,loadMigrationSql} from './helpers/migration.js';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';

const sql=loadMigrationSql('20261113147000_unit_steward_member_contact_records_in_unit');
const predecessor=loadMigrationSql('20261113115000_stewards_require_unit_with_carry_over');
describe('unit-steward member-contact record container migration',()=>{
  it('guards its two predecessors, receipts and direct-read policy in one transaction',()=>{
    expect(sourceTransactionProblem(sql)).toBeNull();
    for(const name of ['get_institutional_records_workspace','save_scoped_institutional_record']){
      expect(sql).toContain('unreviewed predecessor: public.'+name);
      expect(sql).toContain('stale trigger receipt: public.'+name);
      expect(latestFnBody('public.'+name)).toBe(fnBody(sql,'public.'+name));
    }
    expect(sql).toContain("pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual,p.polrelid))");
    expect(sql).toContain("unreviewed predecessor policy: chapter_records_select");
    expect(sql).toContain('revoke all on function private.chapter_member_contact_container_allowed(text,uuid,uuid) from public,anon,authenticated,service_role;');
    expect(sql).toContain('grant execute on function private.chapter_member_contact_container_allowed(text,uuid,uuid) to authenticated;');
  });
  it('keeps the staff contact oracle, MFA and unrelated workspace projections unchanged',()=>{
    const before=fnBody(predecessor,'public.get_institutional_records_workspace');
    const after=fnBody(sql,'public.get_institutional_records_workspace');
    for(const marker of ["'contacts',","'roster',","'exportRuns',"]){
      expect(after.slice(after.indexOf(marker))).toBe(before.slice(before.indexOf(marker)));
    }
    expect(after).toContain('private.can_read_chapter_contact_record(ctx.chapter_id)');
    expect(after).toContain("(v.record_type <> 'member_contact' or private.can_read_chapter_contact_record(v.chapter_id))");
    const save=fnBody(sql,'public.save_scoped_institutional_record');
    expect(save).toContain('if not private.mfa_satisfied()');
    expect(save).toContain("p_record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id)");
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+private\./i);
  });
  it('binds each new row, version, save and policy alternative to the same staff assignment',()=>{
    const name='private.chapter_member_contact_container_allowed';
    expect(fnBody(sql,'public.get_institutional_records_workspace').match(new RegExp(name+'\\(', 'g'))).toHaveLength(2);
    expect(fnBody(sql,'public.save_scoped_institutional_record').match(new RegExp(name+'\\(', 'g'))).toHaveLength(3);
    expect(sql.slice(sql.indexOf('alter policy chapter_records_select')).match(new RegExp(name+'\\(', 'g'))).toHaveLength(1);
    const helper=fnBody(sql,name);
    expect(helper).toContain('p_unit is not null or p_committee is not null');
    expect(helper).toContain("capability.role=any(array['steward','coordinator','advisor','admin','vp'])");
    expect(helper).toContain('scope.role=capability.role');
    expect(helper).toContain('scope.unit_id=p_unit');
    expect(helper).toContain('scope.committee_id=p_committee');
    expect(helper).toContain("private.unit_capability_enabled(p_chapter,p_unit,capability.role,'records')");
    expect(helper).not.toContain('chapter_officer_can');
  });
  it('captures new snapshot containers without guessing the scope of older versions',()=>{
    expect(sql).toContain('add column access_scope_captured boolean not null default false');
    expect(sql).not.toMatch(/update\s+public\.chapter_record_versions/i);
    const workspace=fnBody(sql,'public.get_institutional_records_workspace');
    const history=workspace.slice(workspace.indexOf("'versions',"),workspace.indexOf("'attendance',"));
    expect(history).toContain('v.access_scope_captured and private.chapter_member_contact_container_allowed(v.chapter_id, v.access_unit_id, v.access_committee_id)');
    expect(history).not.toContain('chapter_member_contact_container_allowed(r.');
    expect(fnBody(sql,'public.save_scoped_institutional_record')).toContain('target.access_unit_id, target.access_committee_id, true');
  });
  it('filters an inaccessible existing record before the missing-record refusal',()=>{
    const save=fnBody(sql,'public.save_scoped_institutional_record');
    const lookup=save.slice(save.indexOf('select * into target'),save.indexOf('for update;'));
    expect(lookup).toContain('private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)');
    expect(lookup).toContain('private.can_read_chapter_contact_record(r.chapter_id)');
    expect(save).toContain("if target.id is null then raise exception 'record not found' using errcode = 'P0002'");
  });
});
