import type { Session } from '@supabase/supabase-js';
import { leadershipPulse, organizationFloor, type LeadershipFloors, type LeadershipHat, type LeadershipInput, type LeadershipRead } from '../lib/leadershipPulse';
import { pulseCount, pulseObject, pulseRows, pulseText } from '../lib/pulseCatalog';
import { createCapturedSessionRpcClient } from './supabase';

// The advisor portfolio covers the organization; every other hat reads one
// selected chapter and refuses without it.
export async function loadLeadershipPulse(session: Session, hat: LeadershipHat, organizationID: string, chapterID: string | null, signal: AbortSignal) {
  if (hat !== 'advisor' && !chapterID) throw new Error('Leadership figures need a selected campaign.');
  const client = createCapturedSessionRpcClient(session);
  async function settled(read: PromiseLike<LeadershipRead>): Promise<LeadershipRead> { try { return await read; } catch (error) { return { data: null, error }; } }
  // Every call carries the read's signal, and none is sent once it is aborted
  // (#9482 r1s1, r2s1): a read stopped at the screen's deadline stops here too.
  const rpc = (name: string, args: Record<string, unknown> = {}) => signal.aborted
    ? Promise.reject(new Error('Leadership figures are unavailable for your current role.'))
    : settled(client.rpc(name, args).abortSignal(signal));
  async function verifyScope(): Promise<LeadershipFloors> {
    // Chapter-bound RPCs resolve the chapter from the server-side selection,
    // which another device can switch; confirm it is still the chapter these
    // figures are filtered and labelled with. The advisor portfolio is
    // organization-wide and never reads the selection.
    const [result, memberships] = await Promise.all([rpc('get_my_mobile_staff_scope'), hat === 'advisor' ? null : rpc('get_my_chapter_memberships')]);
    const scope = pulseObject(result.data);
    const roles = [scope.roles, scope.chapterRoles].flatMap((value) => Array.isArray(value) ? value : []);
    const selected = memberships === null || (!memberships.error && pulseRows(memberships.data).some((row) => row.selected === true && row.chapterId === chapterID && row.organizationId === organizationID));
    if (signal.aborted || result.error || scope.staffAuthorized !== true || scope.organizationId !== organizationID || !roles.includes(hat) || !selected) throw new Error('Leadership figures are unavailable for your current role.');
    // The organization's own floors, held on the server (never below 25).
    return { privacy: organizationFloor(scope.privacyFloor), chapterHealth: organizationFloor(scope.chapterHealthFloor) };
  }
  const before = await verifyScope();
  const input: LeadershipInput = {};
  if (hat === 'vp' || hat === 'president') {
    const [overview, events, notices] = await Promise.all([rpc('get_vp_overview'), rpc('get_admin_events'), rpc('list_my_member_notices', { p_limit: 20 })]);
    input.overview = overview;
    const now = Date.now();
    const meetings = pulseRows(events.data).filter((row) => row.chapterId === chapterID && row.eventKind === 'meeting' && !row.cancelledAt && Number.isFinite(Date.parse(pulseText(row.startsAt))) && Date.parse(pulseText(row.startsAt)) <= now).sort((a, b) => Date.parse(pulseText(b.startsAt)) - Date.parse(pulseText(a.startsAt))).slice(0, 4);
    input.events = { data: Array.isArray(events.data) ? meetings : null, error: events.error };
    input.quorum = events.error ? { data: null, error: events.error } : await rpc('get_member_event_quorum', { p_event_ids: meetings.map((row) => row.id) });
    const published = pulseRows(pulseObject(notices.data).notices).filter((row) => row.chapterId === chapterID && !row.retractedAt && pulseText(row.publishedAt) && pulseText(row.id)).slice(0, 3);
    input.notices = { data: Array.isArray(pulseObject(notices.data).notices) ? published : null, error: notices.error };
    const receipts = await Promise.all(published.map((row) => rpc('get_member_notice_receipts', { p_broadcast_id: row.id })));
    input.receipts = { data: receipts.map((row) => { const value = pulseObject(row.data); return { id: value.id, readCount: value.readCount, audienceCount: value.audienceCount }; }), error: receipts.find((row) => row.error)?.error ?? notices.error };
  } else if (hat === 'advisor') input.health = await rpc('get_chapter_health_portfolio');
  else if (hat === 'coordinator') {
    const [workload, cases, unassigned] = await Promise.all([
      rpc('get_workload_stats'),
      settled(client.from('member_cases').select('id,status,user_id,steward_user_id,chapter_id').eq('organization_id', organizationID).order('updated_at', { ascending: false }).order('id').limit(200).abortSignal(signal)),
      rpc('list_coordinator_cases', { p_focus: 'all', p_limit: 200 }),
    ]);
    input.workload = workload;
    input.cases = cases;
    input.unassigned = { data: Array.isArray(unassigned.data) ? pulseRows(unassigned.data).filter((row) => row.organization_id === organizationID && row.chapter_id === chapterID && row.steward_user_id === null) : null, error: unassigned.error };
  } else {
    // Profile and form row access has no admin branch, so the forms figures
    // come from one server aggregate that checks admin authority over the
    // chapter and applies the organization's privacy floor before anything is returned
    // (BUG-UG-ADMIN-PULSE-FORMS-CARD-NEVER-SHOWS-FOR-ADMIN-ONLY-20261110).
    const [overview, mfa, logins, events, forms] = await Promise.all([
      rpc('get_vp_overview'), rpc('get_staff_mfa_policy'), rpc('list_failed_login_operations_inbox', { p_status: 'open', p_limit: 100 }), rpc('get_admin_events'),
      rpc('get_admin_chapter_form_states', { p_chapter_id: chapterID }),
    ]);
    // Each joined current profile has one current name in this one SQL
    // snapshot. Distinct non-placeholder names are a conservative lower bound
    // on distinct profiles (equal names only reduce it). Never carry those
    // names, identity-hash suffixes or request details into the screen model.
    const inbox = pulseObject(logins.data);
    const subjects = new Set(pulseRows(inbox.items).filter((row) => row.status === 'open').map((row) => pulseText(row.memberName).trim()).filter((name) => name && name !== 'Former worker'));
    Object.assign(input, { overview, mfa, forms });
    input.logins = { data: { openCount: inbox.openCount, verifiedSubjects: subjects.size }, error: logins.error };
    input.events = { data: Array.isArray(events.data) ? pulseRows(events.data).filter((row) => row.chapterId === chapterID && !row.cancelledAt) : null, error: events.error };
  }
  // A floor that changed during the load, or went missing, is unknown, and
  // every figure it gates is withheld. Taking the stricter value is not
  // enough: some reads return totals the server counted against the floor it
  // held at that moment (the forms card's form counts are not people), so the
  // phone cannot recheck them against a raised floor.
  // Equal reads do not prove the floor stayed put in between, so the forms
  // count also returns the floor it applied and must match.
  const after = await verifyScope();
  const unchanged = (a: number | null, b: number | null) => a !== null && a === b ? a : null;
  input.floors = { privacy: unchanged(before.privacy, after.privacy), chapterHealth: unchanged(before.chapterHealth, after.chapterHealth) };
  return leadershipPulse(hat, input);
}
