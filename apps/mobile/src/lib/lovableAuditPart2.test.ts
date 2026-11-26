import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { caseDueLabel, casesByDeadline, type MemberCase } from '../models/member';
import { chapterMembershipCopy } from './chapterAdministrationCopy';
import { healthSnapshotOverwrite, healthSnapshotOverwriteMessage } from './chapterHealth';
import { auditDomainLabel, auditEventLabel, auditLedgerEmpty, auditLedgerReason, jobsPanelMessage, operationsPanelState, showJobCards } from './operationsHealthStates';
import { messageWorkflowCopy } from './messageWorkflow';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const memberCase = (id: string, deadline: string | null, updatedAt = '2026-08-01T00:00:00Z', status = 'active'): MemberCase => ({
  id, reference: id, title: id, deadline, caseType: 'Grievance', step: 'Step 1', status, updatedAt,
});

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103, part 2 of 2.
describe('Lovable audit, native part 2', () => {
  it('lists My issues by deadline with a dated due line (MOB-STEWARD-04)', () => {
    const ordered = casesByDeadline([memberCase('late', '2026-08-20'), memberCase('none', null), memberCase('soon', '2026-08-18')]);
    expect(ordered.map((item) => item.id)).toEqual(['soon', 'late', 'none']);
    // #7001 gate round 1 (r1g2): a closed case with an old deadline never
    // sits above open work.
    const mixed = casesByDeadline([memberCase('closed', '2024-06-01', '2024-06-02T00:00:00Z', 'closed'), memberCase('open', null, '2026-11-04T00:00:00Z')]);
    expect(mixed.map((item) => item.id)).toEqual(['open', 'closed']);
    expect(caseDueLabel('2026-08-18')).toBe('Due Aug 18, 2026');
    expect(caseDueLabel(null)).toBeNull();
    expect(read('../features/FeatureScreen.tsx')).toContain('const cases = casesByDeadline(dashboard?.cases ?? []);');
  });

  it('confirms a campaign role change and states its scope (MOB-ADMIN-08)', () => {
    expect(chapterMembershipCopy.en.confirmRoleTitle('Sam Rivera', 'Campaign lead', true)).toBe('Grant Campaign lead to Sam Rivera?');
    expect(chapterMembershipCopy.en.confirmRoleBody('Campaign lead', true)).toContain('in this campaign as soon as you confirm. Their other campaigns are untouched.');
    expect(chapterMembershipCopy.en.confirmRoleTitle('Sam Rivera', 'Campaign lead', false)).toBe('Remove Campaign lead from Sam Rivera?');
    const screen = read('../features/ChapterMembershipsScreen.tsx');
    expect(screen).toContain('onPress={() => confirmRoleChange(true)}');
    expect(screen).toContain('onPress={() => confirmRoleChange(false)}');
    expect(screen).toContain("{ text: copy.cancel, style: 'cancel' },");
  });

  it('confirms Withdraw and a snapshot correction, and names who sees participation', () => {
    const actions = read('../features/mi1/OrganizationIntelligenceScreens.tsx');
    expect(actions).toContain("Alert.alert(t('Withdraw from this action?')");
    expect(actions).toContain('confirmWithdraw(t, Boolean(action.viewerParticipation)');
    expect(actions).toContain('<Body muted>{t(ACTION_PARTICIPATION_READERS)}</Body>');
    expect(actions).toContain("? t('Goal reached')");
    const rpc = read('../../../../supabase/migrations/20261028080000_platform_organization_boundary.sql');
    expect(rpc).toContain("if p_selected_hat not in ('coordinator', 'admin', 'vp')");
    const feature = read('../features/FeatureScreen.tsx');
    expect(feature).toContain('const overwrite = chapter && snapshotDate ? healthSnapshotOverwrite(chapter, snapshotDate) : null;');
    expect(feature).toContain('onPress={confirmSaveSnapshot} />');
    expect(feature).not.toContain("if (snapshotMode !== 'correct') { void saveSnapshot(); return; }");
    expect(feature).toContain('Overall score out of 100, summarizing the six measures below.');
  });

  it('confirms any snapshot save that can replace a stored snapshot, in either form mode (#7001 r1s1, r1g1)', () => {
    const chapter = { measuredOn: '2026-11-04', databaseDate: '2026-11-04', trend: [{ measuredOn: '2026-10-01', score: 70 }, { measuredOn: '2026-11-04', score: 74 }] };
    // "Record snapshot" defaults to the database date, which here already holds today's snapshot.
    expect(healthSnapshotOverwrite(chapter, '2026-11-04')).toBe('replaces');
    expect(healthSnapshotOverwrite(chapter, '2026-10-01')).toBe('replaces');
    // A back-dated day the trend does not show may still hold a row.
    expect(healthSnapshotOverwrite(chapter, '2025-01-15')).toBe('may_replace');
    // Only a new snapshot for a database date with no row saves directly.
    expect(healthSnapshotOverwrite({ ...chapter, measuredOn: '2026-11-03', trend: [] }, '2026-11-04')).toBeNull();
    expect(healthSnapshotOverwriteMessage('replaces', '2026-11-04')).toContain('This replaces the 2026-11-04 snapshot for this campaign.');
    const rpc = read('../../../../supabase/migrations/20260902050000_g4_native_staff_authorization_depth.sql');
    expect(rpc).toMatch(/on conflict \(chapter_id, measured_on\)/i);
  });

  it('says Ready on Pay tools only when a scale is published (MOB-STEWARD-10, MOB-ADMIN-11)', () => {
    const pay = read('../features/mi1/PayToolsScreen.tsx');
    expect(pay).toContain("(catalogView.state === 'success' ? 'Ready' : catalogView.state)");
  });

  it('gives Operations health a reason for every empty or unavailable state (MOB-ADMIN-12)', () => {
    // #7001 gate round 1 (r1s2, r1g3): states come from the load, not from the
    // derived desk, which always lists the whole job catalog.
    const live = { authorized: true, live: true };
    expect(operationsPanelState({ ...live, loading: true, loadError: null })).toBe('loading');
    expect(operationsPanelState({ ...live, loading: false, loadError: 'x' })).toBe('not_loaded');
    expect(operationsPanelState({ ...live, loading: false, loadError: null })).toBe('ready');
    expect(operationsPanelState({ authorized: false, live: true, loading: false, loadError: null })).toBe('unavailable');
    expect(jobsPanelMessage('loading', 0)?.title).toBe('Loading job health');
    expect(jobsPanelMessage('not_loaded', 0)?.title).toBe('Job health not loaded');
    expect(jobsPanelMessage('ready', 0)?.title).toBe('No recorded runs yet');
    expect(jobsPanelMessage('ready', 3)).toBeNull();
    expect(showJobCards('loading')).toBe(false);
    expect(showJobCards('not_loaded')).toBe(false);
    expect(showJobCards('ready')).toBe(true);
    expect(auditLedgerReason('not_loaded')).toBe('The audit ledger could not be loaded. Try again below.');
    expect(auditLedgerReason('ready')).toBeNull();
    expect(auditLedgerEmpty('not_loaded', 0)).toBe(false);
    expect(auditLedgerEmpty('ready', 0)).toBe(true);
    const ops = read('../features/mi1/OperationsHealthScreen.tsx');
    expect(ops).toContain('const panel = operationsPanelState({ authorized, live, loading, loadError });');
    expect(ops).toContain('const jobsMessage = jobsPanelMessage(panel, jobRows.length);');
    expect(ops).toContain('{showJobCards(panel) ? listedJobs.map((job) => {');
    expect(ops).toContain('const lastRun: OperationsJobRun | null | undefined = job.lastRun;');
    // A failed acknowledgement is its own notice, never a ledger load failure.
    expect(ops).toContain("setLoadError(isMfaRequiredRpcError(caught)\n        ? 'Complete two-step sign-in, then reload operations health.'");
    expect(ops).not.toContain('jobs.length === 0');
  });

  it('fits Messages filters to a phone and says what the view choice changes (MOB-VP-01, MOB-COORDINATOR-01)', () => {
    const messages = read('../../app/messages.tsx');
    expect(messages).toContain("filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },");
    expect(messages).not.toContain('contentContainerStyle={styles.filterRow}');
    expect(messageWorkflowCopy.en.onboardingBody).toContain('Only how they are grouped changes');
  });

  // BUG-UG-LEDGER-SAYS-KNOWLEDGE-FILE-UPLOADED-BEFORE-ANY-BYTES-ARRIVE-20261112 (#8545).
  it('names a prepared knowledge upload in the ledger as started, never as uploaded', () => {
    expect(auditEventLabel('knowledge_file_uploaded', 'pending_scan')).toBe('Knowledge file upload started');
    expect(auditEventLabel('knowledge_file_uploaded', null)).toBe('Knowledge file uploaded');
    expect(auditEventLabel('case.status_changed', 'pending_scan')).toBe('Issue status changed');
    expect(auditEventLabel('analytics_snapshot_read', null, 'es')).toBe('Consulta de métricas');
    expect(auditEventLabel('message.react', null, 'es')).toBe('Reacción a un mensaje');
    expect(auditDomainLabel('data_access', 'es')).toBe('Acceso a datos');
    expect(auditEventLabel('future.record_type', null)).toBe('Future record type');
    const screen = read('../features/mi1/OperationsHealthScreen.tsx');
    expect(screen).toContain('{auditEventLabel(event.eventType, event.reviewStatus, language)}');
    expect(screen).toContain('formatZoneInstant(parseDatabaseTimestamp(event.occurredAt), language, operationsTimeZone)');
    expect(read('../services/supabase.ts')).toContain('reviewStatus: auditReviewStatus(item.metadata),');
  });

  it('does not offer catalog search when there is no catalog (MOB-PUBLIC-03)', () => {
    expect(read('../features/UnionCatalogScreen.tsx')).toContain("{!catalogKey && state !== 'unavailable' && <>");
  });
});
