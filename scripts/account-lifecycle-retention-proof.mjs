import assert from 'node:assert/strict';
import { migrateLegacyStewardFixtures } from '../tests/helpers/steward-unit-fixtures.js';

// #7663: an organization Steward grant exists only as one held before the
// unit migration, so a demoted coordinator also gets that migration's backfill.
async function demoteToLegacySteward(client, user) {
  await client.query("update public.organization_role_grants set role='steward' where user_id=$1 and role='coordinator'", [user]);
  await migrateLegacyStewardFixtures(client);
}

// Run through authenticated RLS and definer RPCs, never through the scope helper.
export async function proveRetainedAuthorization(client, ids, rows, phase) {
  async function asReader(reader, session, expected, assignmentExpected = expected) {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: reader, role: 'authenticated', aal: 'aal2', session_id: session })]);
    await client.query('set local role authenticated');
    const visible = (await client.query(`select
      exists(select 1 from public.casework_management_entries where id=$1) as entry,
      exists(select 1 from public.casework_management_addenda where id=$2) as addendum,
      exists(select 1 from public.casework_retaliation_reports where id=$3) as report,
      exists(select 1 from public.member_case_assignment_audit where id=$4) as assignment`, rows)).rows[0];
    await client.query('savepoint rpc_write');
    let error;
    try {
      const added = (await client.query('select (public.casework_add_management_addendum($1,$2)).id', [rows[0], 'Authorized retention regression addendum.'])).rows[0];
      assert.equal((await client.query("select exists(select 1 from public.casework_audit_events where entity_id=$1 and event_type='behavior_addendum_added') as visible", [added.id])).rows[0].visible, true, `${phase}: new addendum audit inherits retained readers`);
    } catch (caught) { error = caught; }
    await client.query('rollback to savepoint rpc_write');
    await client.query('release savepoint rpc_write');
    assert.equal(error?.code, expected ? undefined : 'P0002', `${phase}: addendum definer authorization`);
    assert.deepEqual(visible, { entry: expected, addendum: expected, report: expected, assignment: assignmentExpected }, `${phase}: table-specific reader predicate`);
    await client.query('reset role');
  }
  await asReader(ids.unauthorizedStaff, ids.unauthorizedSession, false);
  await asReader(ids.authorizedStaff, ids.authorizedSession, true);
  await client.query('savepoint role_change');
  await demoteToLegacySteward(client, ids.authorizedStaff);
  await asReader(ids.authorizedStaff, ids.authorizedSession, true, false);
  await client.query('rollback to savepoint role_change');
  await client.query('release savepoint role_change');
  await client.query('savepoint chapter_change');
  await client.query("delete from public.member_chapter_memberships where user_id=$1", [ids.authorizedStaff]);
  // Removing the selected chapter membership also removes the selected tenant.
  await asReader(ids.authorizedStaff, ids.authorizedSession, false);
  await client.query('rollback to savepoint chapter_change');
  await client.query('release savepoint chapter_change');

  await client.query('savepoint selected_tenant_change');
  const otherOrg = (await client.query("insert into public.organizations(slug,name) values ('retention-other-tenant','Disposable retention other tenant') returning id")).rows[0].id;
  await client.query("insert into public.chapters(id,name,region,order_index,organization_id,slug) values ('retention-other-chapter','Disposable other chapter','Proof',999,$1,'retention-other-chapter')",[otherOrg]);
  await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[otherOrg,ids.authorizedStaff]);
  await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,'retention-other-chapter','active')",[ids.authorizedStaff]);
  await client.query("update public.member_profiles set chapter_id='retention-other-chapter' where id=$1",[ids.authorizedStaff]);
  await asReader(ids.authorizedStaff,ids.authorizedSession,false);
  await client.query('rollback to savepoint selected_tenant_change');
  await client.query('release savepoint selected_tenant_change');

  if (phase === 'before deletion') {
    // Grants have no expiry column. Their validity is exactly revoked_at IS
    // NULL; even an old grant remains valid. Exercise BOTH conjuncts with an
    // unassigned coordinator and the same case before and after real deletion.
    for (const revoked of [false, true]) {
      await client.query('savepoint grant_validity');
      const caseId = (await client.query('select case_id from public.casework_management_entries where id=$1', [rows[0]])).rows[0].case_id;
      await client.query('update public.member_cases set coordinator_user_id=null, steward_user_id=null where id=$1', [caseId]);
      await client.query(`insert into public.casework_access_grants
        (case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason,granted_at,revoked_at,revoked_by)
        values ($1,$2,$3,$4,$4,'Retained grant validity proof.', now()-interval '10 years',
          case when $5 then now() else null end, case when $5 then $4::uuid else null end)`,
      [caseId,ids.organization,ids.chapter,ids.authorizedStaff,revoked]);
      await asReader(ids.authorizedStaff, ids.authorizedSession, !revoked, !revoked);
      await client.query('delete from auth.users where id=$1', [ids.deleting]);
      await asReader(ids.authorizedStaff, ids.authorizedSession, !revoked, !revoked);
      await asReader(ids.unauthorizedStaff, ids.unauthorizedSession, false);
      await demoteToLegacySteward(client, ids.authorizedStaff);
      await asReader(ids.authorizedStaff, ids.authorizedSession, false);
      await client.query('rollback to savepoint grant_validity');
      await client.query('release savepoint grant_validity');
    }
  }
}

export const RAISE_PATTERN_SQL = String.raw`'\mraise\M'`;

export async function proveTriggerNegativeControls(client, deletingUser) {
  assert.equal((await client.query(`select 'begin RAISE EXCEPTION' ~* ${RAISE_PATTERN_SQL} as matches`)).rows[0].matches, true);
  assert.equal((await client.query(`select 'praise raised' ~* ${RAISE_PATTERN_SQL} as matches`)).rows[0].matches, false);
  async function controls() {
    for (const [label, mutation, needle] of [
      ['unconditional blocker', `
        create function private.lifecycle_proof_blocker() returns trigger language plpgsql as $$begin raise exception 'proof blocker'; end$$;
        create trigger lifecycle_proof_blocker before update or delete on public.casework_management_entries for each row execute function private.lifecycle_proof_blocker();`, 'lifecycle_proof_blocker'],
      ['indirect blocker', `create or replace function private.account_lifecycle_capture_case(p_case public.member_cases) returns void language plpgsql security definer set search_path='' as $$begin raise exception 'indirect blocker'; end$$;`, 'account_lifecycle_capture_case'],
      ['indirect table blocker', `
        create function private.lifecycle_proof_blocker() returns trigger language plpgsql as $$begin raise exception 'indirect table blocker'; end$$;
        create trigger lifecycle_proof_blocker before update or delete on public.member_profiles for each row execute function private.lifecycle_proof_blocker();`, 'lifecycle_proof_blocker'],
      ['indirect rule blocker', `create rule lifecycle_proof_blocker as on delete to public.member_profiles do instead nothing;`, 'lifecycle_proof_blocker'],
    ]) {
      await client.query('savepoint trigger_negative');
      try {
        await client.query(mutation);
        const issues = await client.query('select * from private.account_lifecycle_referential_action_trigger_issues()');
        assert(issues.rows.some(row => row.trigger_name.includes(needle)), `${label}: disabled or incomplete trigger invariant`);
        if (!label.includes('rule')) {
          await client.query('savepoint blocked_delete');
          let error;
          try { await client.query('delete from auth.users where id=$1', [deletingUser]); }
          catch (caught) { error = caught; }
          await client.query('rollback to savepoint blocked_delete');
          await client.query('release savepoint blocked_delete');
          assert.equal(error?.code, 'P0001', `${label}: actual account delete must hit the blocker`);
        }
      } finally {
        await client.query('rollback to savepoint trigger_negative');
        await client.query('release savepoint trigger_negative');
      }
    }
  }
  await controls();
  await client.query('savepoint disabled_invariant');
  try {
    await client.query(`create or replace function private.account_lifecycle_referential_action_trigger_issues()
      returns table(schema_name text, table_name text, trigger_name text, inventory_issue text)
      language sql stable security definer set search_path='' as $$select null::text,null::text,null::text,null::text where false$$`);
    await assert.rejects(controls, /disabled or incomplete trigger invariant/, 'A WHERE false mutation must fail the proof itself');
  } finally {
    await client.query('rollback to savepoint disabled_invariant');
    await client.query('release savepoint disabled_invariant');
  }
}

export async function proveRetainedWriterBoundaries(client, ids, rows, phase) {
  const [entryId, , reportId] = rows;
  const before = (await client.query('select case_id from public.casework_management_entries where id=$1', [entryId])).rows[0];
  const patternId = phase === 'before deletion' ? '50900500-0000-4000-8000-000000000026' : '50900500-0000-4000-8000-000000000027';
  const patternEnvelope = { subject_label: { organization: ids.organization, record: patternId,
    field: 'subject_label', purpose: 'casework_retaliation_patterns', schema: '1', payload: {}, wrappedKey: {},
    keyVersion: 'proof', dataVersion: phase === 'before deletion' ? '50900500-0000-4000-8000-000000000028' : '50900500-0000-4000-8000-000000000029' } };
  await client.query("select set_config('app.sensitive_maintenance','on',true), set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify(patternEnvelope)]);
  const pattern = (await client.query(`insert into public.casework_retaliation_patterns
    (id,organization_id,chapter_id,fingerprint,subject_label,report_count)
    values ($1,$2,$3,$4,'[encrypted]',2) returning id`, [patternId,ids.organization,ids.chapter,`writer-${phase}`])).rows[0];
  await client.query("select set_config('app.sensitive_maintenance','off',true), set_config('app.sensitive_envelopes','',true)");
  for (const [reader,session,coordinator] of [[ids.unauthorizedStaff,ids.unauthorizedSession,false],[ids.authorizedStaff,ids.authorizedSession,true]]) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:reader,role:'authenticated',aal:'aal2',session_id:session})]);
    await client.query('set local role authenticated');
    for (const [label,sql,args,code] of [
      ['pattern disposition', 'select public.casework_review_retaliation_pattern($1,$2,$3,$4)', [pattern.id,'investigating','Investigating retained reports.','Retained pattern review note.'], coordinator ? undefined : 'P0002'],
      ['retaliation scan requires ENC ticket', 'select public.casework_scan_retaliation_patterns($1)', [ids.chapter], '42501'],
      ['retaliation withdrawal non-owner', 'select public.casework_withdraw_retaliation_report($1,$2)', [reportId,'Non-owner cannot withdraw retained history.'], 'P0002'],
      ['private audit writer', "select private.mi1_w2_write_audit($1,'case_reminder_disposed','{}'::jsonb)", [ids.organization], '42501'],
    ]) {
      await client.query('savepoint writer_boundary');
      let error;
      try { await client.query(sql,args); } catch(caught) { error=caught; }
      await client.query('rollback to savepoint writer_boundary');
      await client.query('release savepoint writer_boundary');
      assert.equal(error?.code,code,`${phase}: ${label}`);
    }
    await client.query('reset role');
  }
  // Reporter-self is an independent predicate, not staff case authorization.
  // Exercise a direct case detachment with the reporter still alive.
  if (before.case_id) {
    for (const detach of [false,true]) {
    await client.query('savepoint reporter_detach');
    if (detach) await client.query('delete from public.member_cases where id=$1',[before.case_id]);
    const reason = '[encrypted]';
    const argumentsJson = { p_report_id: reportId, p_reason: reason };
    const envelopesJson = { withdrawal_reason: { organization: ids.organization, record: reportId,
      field: 'withdrawal_reason', purpose: 'casework_retaliation_reports', schema: '1', payload: {}, wrappedKey: {},
      keyVersion: 'proof', dataVersion: detach ? '50900500-0000-4000-8000-000000000030' : '50900500-0000-4000-8000-000000000031' } };
    const ticket = (await client.query('select public.stage_sensitive_write($1,$2,$3,$4) id',
      [ids.deleting, 'casework_withdraw_retaliation_report', argumentsJson, envelopesJson])).rows[0].id;
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:ids.deleting,role:'authenticated',aal:'aal2',session_id:ids.session})]);
    await client.query('set local role authenticated');
    await client.query('select public.write_sensitive_content($1,$2,$3,$4)',
      ['casework_withdraw_retaliation_report', argumentsJson, envelopesJson, ticket]);
    await client.query('reset role');
    await demoteToLegacySteward(client, ids.authorizedStaff);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:ids.authorizedStaff,role:'authenticated',aal:'aal2',session_id:ids.authorizedSession})]);
    await client.query('set local role authenticated');
    assert.equal((await client.query("select exists(select 1 from public.casework_audit_events where entity_id=$1 and event_type='retaliation_withdrawn') as visible",[reportId])).rows[0].visible,true,'Withdrawal audit preserves assigned-staff readers');
    await client.query('reset role');
    await client.query('rollback to savepoint reporter_detach');
    await client.query('release savepoint reporter_detach');
    }
  }
}

export async function proveAdditionalRetainedReads(client, ids, auditId, extensionId, phase) {
  for (const [reader,session,expected] of [[ids.unauthorizedStaff,ids.unauthorizedSession,false],[ids.authorizedStaff,ids.authorizedSession,true]]) {
    for (const demote of [false,true]) {
      await client.query('savepoint additional_read');
      if (demote) await demoteToLegacySteward(client, reader);
      await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:reader,role:'authenticated',aal:'aal2',session_id:session})]);
      await client.query('set local role authenticated');
      const actual=(await client.query(`select
        exists(select 1 from public.casework_audit_events where id=$1) as audit,
        exists(select 1 from public.casework_deadline_extensions where id=$2) as extension`,[auditId,extensionId])).rows[0];
      assert.deepEqual(actual,{audit:expected,extension:expected},`${phase}: retained audit/extension assigned staff reads`);
      await client.query('reset role');
      await client.query('rollback to savepoint additional_read');
      await client.query('release savepoint additional_read');
    }
  }
}

// Every installed definer routine that directly names retained history. The
// trigger inventory separately pins the transitive helper surface. New public
// entry points must receive an explicit authorization disposition here.
const RETAINED_DEFINERS = {
  public: [
    'assign_member_case', 'casework_acknowledge_alert', 'casework_add_bargaining_event',
    'casework_add_bargaining_proposal', 'casework_add_case_note', 'casework_add_management_addendum',
    'casework_advance_step', 'casework_apply_macro',
    'casework_bulk_update_cases',
    // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
    // disposition: each writes one deadline or alert row and exactly one
    // deadline_created / alert_created casework_audit_events row, gated by
    // private.casework_staff_can_access on the case. They return only the row
    // just created, never a retained row image, and the audit metadata is
    // derived or drawn from a closed vocabulary, so no retention or export
    // disposition changes.
    'casework_create_alert',
    'casework_create_bargaining_workspace', 'casework_create_checklist_template',
    'casework_create_deadline',
    'casework_decide_deadline_extension',
    // REQ-UG-ULP-FILING-DEADLINE-20261001 disposition: each writes one
    // public.casework_retaliation_flags row and exactly one pattern_detected /
    // pattern_reviewed casework_audit_events row, gated by
    // private.casework_staff_can_access on the case. They return only the flag
    // just written, never a retained row image, and the audit metadata is drawn
    // from a closed vocabulary (source, window, status), so no retention or
    // export disposition changes.
    'casework_flag_retaliation_incident',
    'casework_grant_access', 'casework_link_cases',
    'casework_log_management_behavior',
    // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917 disposition: writes
    // exactly one casework_audit_events row for a desk CSV export and reads
    // public.member_cases only through private.casework_staff_can_access. It
    // returns no retained row image, free text or metadata — every recorded
    // value is derived or drawn from a closed vocabulary — so no retention or
    // export disposition changes.
    'casework_record_case_export',
    // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
    // (20261009000500) disposition: MFA and private.casework_staff_can_access
    // gate the case title update. Each real change appends one case_renamed
    // casework_audit_events row with a closed reason code and title lengths
    // only; it returns the case id, new title and changed flag, never retained
    // history. No retention or export disposition changes.
    'casework_rename_case',
    'casework_request_deadline_extension', 'casework_review_retaliation_flag', 'casework_review_retaliation_pattern',
    'casework_revoke_access', 'casework_save_intake_draft', 'casework_save_macro',
    'casework_scan_retaliation_patterns',
    'casework_score_case', 'casework_set_bargaining_status', 'casework_set_checklist_item',
    // BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001 disposition:
    // records met / waived / reopened on one deadline the caller may work and
    // writes exactly one deadline_decided casework_audit_events row with the
    // closed-vocabulary decision; it returns only that deadline row.
    'casework_set_deadline_status',
    'casework_set_reminder_status', 'casework_set_restriction', 'casework_submit_retaliation_report',
    'casework_transition_bargaining_proposal', 'casework_withdraw_retaliation_report',
    // REQ-UG-STEWARD-CASEWORK-GAPS-20261030 (20261030204500)
    // disposition: claim_member_case puts the calling steward on an active,
    // unassigned, unrestricted case in their steward scope and APPENDS exactly
    // one member_case_assignment_audit row, the same before/after assignee
    // image assign_member_case writes. It reads no retained row and returns
    // only the case id, reference and assigned flag, so no retention or export
    // disposition changes.
    'claim_member_case',
    // REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001 disposition: a read-only
    // count over the caller's OWN open retaliation reports (reporter_user_id =
    // auth.uid(), status submitted or in_review), the rows the
    // casework_retaliation_reports_read policy already returns to the
    // reporter. It returns a number only, never a row, free text or
    // envelope, and never writes, so no retention or export disposition
    // changes.
    'get_compass_nudges',
    // REQ-UG-DORMANT-68-AUDIT-SINKS-SURFACED-20260917 disposition: two paged
    // read-only definers over retained audit history (20260917090000). Each is
    // SECURITY DEFINER with an empty search_path only so it can re-state its
    // table's own SELECT policy rather than inherit it — organization scope from
    // private.mi1_require_selected_organization(), then exactly
    // public.staff_can_see_user(..., 'coordinator') for the assignment sink and
    // the organization-role / private.casework_staff_can_access pair for the
    // casework events. They project authorized record links only, never the
    // retained row images, free text or metadata, and they never write, so no
    // retention or export disposition changes.
    // 20260918202000 re-emits list_casework_audit_events to add the
    // cases_exported kind to its p_kind vocabulary. That widens which retained
    // rows the caller may ASK for by kind, not which rows the same two
    // authorization branches return, and the projected column list is
    // unchanged, so the disposition above still holds and the entry stays as it
    // is.
    'list_casework_audit_events', 'list_member_case_assignment_audit',
    // REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001 disposition: an
    // organization admin's explicit starter-procedure load writes exactly one
    // organization-level procedure_starter_loaded casework_audit_events row
    // (no case id; metadata is the template id, the trimmed case-type scope,
    // the locale and the step count) and returns only the procedure it just
    // saved through casework_save_procedure, never a retained row image, so no
    // retention or export disposition changes.
    'load_casework_starter_procedure',
    // REQ-UG-STEWARD-CASEWORK-GAPS-20261030 (20261030204500)
    // disposition: open_member_case opens a case (the member's own through
    // create_member_case, or a steward's for a member in scope) and, when the
    // steward assigns themselves, APPENDS exactly one
    // member_case_assignment_audit row like assign_member_case. It reads no
    // retained row and returns only the new case id, reference and assigned
    // flag, so no retention or export disposition changes.
    'open_member_case',
    'sensitive_pattern_source',
    // REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030
    // (20261031010000) disposition: steward_add_case_note APPENDS one
    // member_case_updates note and exactly one 'note_added'
    // casework_audit_events row (metadata {occurredOn, by: 'steward'}, no note
    // text). It admits only the case's own steward who still passes
    // private.casework_staff_can_access, reads no retained row and returns only
    // the note it just wrote, so no retention or export disposition changes.
    'steward_add_case_note',
  ],
  private: [
    // capture_casework_record_version writes only into the private version
    // table and never returns a row to a caller; casework_history_versions is
    // the single read boundary for those snapshots and re-applies
    // private.casework_can_read, private.mfa_satisfied and
    // private.casework_staff_can_access per source table before projecting a
    // changed-key diff. Neither exposes a raw snapshot or an encrypted
    // envelope, and both are revoked from every role but authenticated
    // execute on the reader.
    // REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001 (20261003051000):
    // chapter_leader_active_since checks a chapter leader's recent activity,
    // including casework audit events and organization role appointments. It
    // returns a boolean, never a retained row, actor of another person, or
    // metadata, never writes, and is revoked from every API role.
    'account_lifecycle_capture_case', 'capture_casework_record_version',
    // REQ-UG-RETALIATION-TIMING-DETECTOR-20261001: the timing detector and
    // its adverse-event reader read only ids, dates, categories and the
    // management entry summary for a keyword severity; they write flags and one
    // pattern_detected audit row per flag with closed-vocabulary metadata and
    // return a count or rows to that detector only (no client EXECUTE).
    'casework_detect_retaliation_timing',
    'casework_escalate_due_alerts', 'casework_history_versions',
    'casework_retaliation_adverse_events',
    // BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: the minute
    // sweep reads deadline and case scope only, sends case-free reminders and
    // writes one deadline_decided (decision missed, automatic) audit row per
    // deadline it marks missed; it returns a count.
    'casework_sweep_deadline_reminders',
    // REQ-UG-ULP-FILING-DEADLINE-20261001: the hourly ULP sweep reads only
    // id, case_id, scope, incident_at and status of casework_retaliation_reports
    // (never an encrypted field), writes flags and one pattern_detected audit row
    // per attached report with closed-vocabulary metadata, and returns a count.
    'casework_sweep_ulp_deadlines',
    'chapter_leader_active_since',
    'guard_casework_historical_attribution',
    // REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001 (20261002150000): the
    // retaliation family counts casework_retaliation_reports by reporter id,
    // status and created_at only (never an encrypted field) for a floored
    // aggregate; no row, person id or history leaves the function, and it is
    // revoked from every client role.
    'issue_intelligence_family_signal',
    // REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (20261104123000):
    // the casework journal reads only the caller's own case history rows of
    // this statement and writes journal entries; the row state and undo
    // handler read or put back one covered row (never a retaliation report,
    // which #6943 records and keeps). None returns
    // history and all are revoked from every client role.
    'learning_casework_journal',
    'learning_casework_row_state',
    // REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103
    // (20261104120000): the case access, assignment and restriction undo
    // handlers only APPEND one access_granted, access_revoked or
    // restriction_changed casework_audit_events row (metadata granteeUserId or
    // restricted) or one member_case_assignment_audit row, exactly as the
    // forward writers do. They read no retained row, return nothing and are
    // revoked from every client role.
    'learning_undo_case_access',
    'learning_undo_case_assignment',
    'learning_undo_case_restriction',
    'learning_undo_casework',
    'require_sensitive_envelopes',
    // REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001 (20261003033000):
    // route_steward_email_intake only APPENDS one 'entity_linked'
    // casework_audit_events row (metadata {source, automatic}, no email
    // content) when automatic routing attaches a steward email to a case. It
    // reads no retained row and returns no history, so no retention or export
    // disposition changes; it is revoked from every client role.
    'route_steward_email_intake',
  ],
};

export async function proveRetainedDefinerInventory(client) {
  for (const [schema, expected] of Object.entries(RETAINED_DEFINERS)) {
    const actual = (await client.query(`select p.proname from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname=$1 and p.prosecdef and p.prosrc ~
      '(casework_management_entries|casework_management_addenda|casework_retaliation_reports|casework_audit_events|casework_deadline_extensions|member_case_assignment_audit)'
      order by 1`,[schema])).rows.map(row=>row.proname);
    assert.deepEqual(actual,expected,`${schema}: unreviewed retained-history definer path`);
  }
}
