import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { readableRecordKey, type NativeUiKey, type NativeUiText } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { mobileConfig } from '../lib/config';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../components/ui';
import {
  ACCOMMODATION_TYPES,
  EMERGENCY_SCENARIOS,
  HR_CONTACT_DISPOSITIONS,
  MEMBER_SUPPORT_STAFF_HATS,
  MEMBER_SUPPORT_TABS,
  createMemberSupportAdapter,
  normalizeMemberSupportActor,
} from '../../../../src/features/memberSupport/index.js';
import { queueAccessibilityAnnouncement, useAccessibilityAnnouncementQueue } from '../lib/announce';
import { buildNativeActor } from '../lib/mi1Shared';
import { haptics } from '../services/haptics';
import { getSupabaseClient } from '../services/supabase';
import { bindBusinessApi } from '../services/businessWriters';
import { useBusinessRequests, useBusinessWriter, useBusinessState, useBusinessOperationCache, useBusinessRequestOwner, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { NativeOnboardingOversight } from './NativeOnboardingOversight';
import { useApp } from '../state/AppProvider';
import { explicitLiveStaffHat } from '../lib/hatFunctions';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { NativeFeatureGuide } from './guideLayers/GuideLayers';
import { INCIDENT_NOTES_READERS, INCIDENT_NOTES_RETENTION, NOT_FOR_EMERGENCIES, STEWARD_ALERT_CONFIRMATION } from '../lib/sensitiveInputDisclosure';
import {
  canInitiateMemberHandoff,
  type HandoffPerson,
  type MemberHandoff,
  type MemberHandoffStatus,
  type PreviewHandoffDirectoryPerson,
} from './memberSupportHandoffs';
import {
  failureNotice,
  settleMemberSupportCommit,
  type MemberSupportNotice,
  type MemberSupportNoticeTone,
} from './memberSupportNotice';
import { createIntentStamp } from '../lib/intentStamp';
import { useRequestGeneration } from '../lib/useRequestGeneration';

import { typeface } from '../theme/typeface';
type TabID = 'rights' | 'accommodations' | 'hr' | 'onboarding' | 'mentorship' | 'handoffs';
type HandoffStatus = MemberHandoffStatus;
type Handoff = MemberHandoff;
type HandoffPage = {
  items: Handoff[];
  nextCursor: { createdAt: string; id: string } | null;
  loadError?: boolean;
};
type Workspace = {
  state: string;
  viewerUserId: string | null;
  staff: boolean;
  emergencyChecklists: Array<{ id: string; memberUserId?: string | null; memberLabel?: string; scenario: string; status: string; completedSteps: number[]; notes: string; alertedAt: string | null }>;
  accommodations: Array<{ id: string; memberUserId: string | null; memberLabel: string; requestType: string; description: string; status: string; staffNote: string; submittedAt: string | null }>;
  accommodationSummary: { open: number };
  hrDirectory: { name: string; title: string; department: string; email: string; phone: string; hours: string; notes: string } | null;
  hrContacts: Array<{ id: string; memberLabel: string; channel: string; purpose: string; disposition: string; note: string; occurredAt: string | null; followUpOn: string | null }>;
  onboardingProgram: Array<{ id: string; title: string; description: string; position: number; active: boolean }>;
  onboardingPlan: { id: string; status: string; completedStepIds: string[] } | null;
  onboardingRoster: Array<{ id: string; memberUserId: string; memberLabel: string; status: string; completedStepIds: string[] }>;
  mentorshipPairs: Array<{
    id: string; mentorLabel: string; menteeLabel: string; status: string; startedOn: string | null; outcome: string;
    goals: Array<{ id: string; title: string; completed: boolean }>;
    notes: Array<{ id: string; authorLabel: string; body: string; createdAt: string | null }>;
  }>;
  mentorshipDirectory: PreviewHandoffDirectoryPerson[];
  handoffs: HandoffPage;
};

const accommodationTypes: Readonly<Record<string, NativeUiKey>> = {
  schedule: 'Schedule',
  equipment: 'Equipment',
  workspace: 'Workspace',
  leave: 'Leave',
  communication: 'Communication',
  remote_work: 'Remote work',
  other: 'Other',
};

const hrChannels: Readonly<Record<string, NativeUiKey>> = {
  email: 'Email',
  phone: 'Phone',
  meeting: 'Meeting',
  letter: 'Letter',
  portal: 'Portal',
  other: 'Other',
};

const hrDispositions: Readonly<Record<string, NativeUiKey>> = {
  planned: 'Planned',
  attempted: 'Attempted',
  reached: 'Reached',
  follow_up_due: 'Follow-up due',
  resolved: 'Resolved',
};

function choiceLabel(labels: Readonly<Record<string, NativeUiKey>>, value: string, t: NativeUiText): string {
  return Object.hasOwn(labels, value) ? t(labels[value]!) : readableRecordKey(value);
}

// Keep each choice independently focusable. Android does not consistently speak
// the non-focusable radiogroup parent's role, so include context on each radio.
function radioChoiceLabel(group: string, option: string, index: number, count: number, t?: NativeUiText): string | undefined {
  if (Platform.OS !== 'android') return undefined;
  return t?.('{group}, {option}, {position} of {count}', { group, option, position: index + 1, count })
    ?? `${group}, ${option}, ${index + 1} of ${count}`;
}

function label(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? 'Date unavailable' : parsed.toLocaleDateString();
}

async function loadWorkspace(
  adapter: ReturnType<typeof createMemberSupportAdapter>,
  actor: unknown,
): Promise<Workspace> {
  const next = await adapter.load(actor) as Workspace;
  if (next.state === 'ready' && next.staff) {
    try {
      return { ...next, handoffs: await adapter.listHandoffs(actor) as HandoffPage };
    } catch {
      return { ...next, handoffs: { items: [], nextCursor: null, loadError: true } };
    }
  }
  return { ...next, handoffs: { items: [], nextCursor: null } };
}

export function resolveMemberSupportHat(
  mode: string,
  previewHat: string | null,
  authorizedRoles: readonly string[],
  organizationRoles: readonly string[],
): string {
  const staffHats = MEMBER_SUPPORT_STAFF_HATS as readonly string[];
  // The demo takes the hat the switcher shows; a live session takes its
  // organization staff grant.
  if (mode === 'preview') {
    return previewHat && previewHat !== 'member'
      && staffHats.includes(previewHat) && authorizedRoles.includes(previewHat)
      ? previewHat
      : 'member';
  }
  const selected = explicitLiveStaffHat(organizationRoles.filter((role) => staffHats.includes(role)));
  return selected ?? 'member';
}

// REQ-UG-HOME-NUDGES-20261001: the Home onboarding nudge opens the
// checklist directly (/feature/member-support?source=onboarding).
// The fictional preview's read-only workspace: every person, plan and record
// below is invented and never leaves the device.
const previewWorkspace: Workspace = {
  state: 'ready',
  viewerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
  staff: false,
  emergencyChecklists: [{ id: 'preview-emergency', scenario: 'disciplinary_meeting', status: 'draft', completedSteps: [0], notes: '', alertedAt: null }],
  accommodations: [
    { id: 'preview-accommodation-2025', memberUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', memberLabel: 'Sam Okafor', requestType: 'schedule', description: 'Adjusted start time for a recurring one-on-one.', status: 'approved', staffNote: 'Written schedule confirmed.', submittedAt: '2025-03-18T14:00:00.000Z' },
  ],
  accommodationSummary: { open: 0 },
  hrDirectory: { name: 'People Operations', title: 'Employee relations contact', department: 'Human Resources', email: 'people@example.test', phone: '(555) 014-0188', hours: 'Weekdays, 9 AM–5 PM', notes: 'Use the secure portal for documents.' },
  hrContacts: [
    { id: 'preview-hr-2024', memberLabel: 'Sam Okafor', channel: 'email', purpose: 'Confirm leave paperwork receipt', disposition: 'resolved', note: 'Receipt confirmed in writing.', occurredAt: '2024-11-07T15:30:00.000Z', followUpOn: null },
  ],
  onboardingProgram: [
    { id: 'preview-onboard-1', title: 'Meet your committee', description: 'Review contacts and how to ask for help.', position: 1, active: true },
    { id: 'preview-onboard-2', title: 'Learn core rights', description: 'Complete the workplace-rights introduction.', position: 2, active: true },
    { id: 'preview-onboard-3', title: 'Choose communication preferences', description: 'Set the channels you want the committee to use.', position: 3, active: true },
  ],
  onboardingPlan: { id: 'preview-plan-2024', status: 'completed', completedStepIds: ['preview-onboard-1', 'preview-onboard-2', 'preview-onboard-3'] },
  onboardingRoster: [
    { id: 'preview-plan-2024', memberUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', memberLabel: 'Sam Okafor', status: 'completed', completedStepIds: ['preview-onboard-1', 'preview-onboard-2', 'preview-onboard-3'] },
    { id: 'preview-plan-2026', memberUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', memberLabel: 'Maya Chen', status: 'in_progress', completedStepIds: ['preview-onboard-1'] },
  ],
  mentorshipPairs: [{
    id: 'preview-mentorship-2026', mentorLabel: 'Jordan Lee', menteeLabel: 'Sam Okafor', status: 'active', startedOn: '2026-02-03', outcome: '',
    goals: [{ id: 'preview-goal-1', title: 'Shadow a worker intake', completed: true }, { id: 'preview-goal-2', title: 'Lead a follow-up conversation', completed: false }],
    notes: [{ id: 'preview-note-1', authorLabel: 'Jordan Lee', body: 'Reviewed the next shadowing opportunity and agreed on a debrief.', createdAt: '2026-08-12T17:00:00.000Z' }],
  }],
  mentorshipDirectory: [
    { userId: 'a1111111-1111-4111-8111-111111111111', label: 'Sam Okafor', chapterId: 'wor', roles: ['steward'], switchablePreviewHat: true },
    { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', label: 'Maya Chen', chapterId: 'wor', roles: [] },
    { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', label: 'Jordan Lee', chapterId: 'wor', roles: ['steward'] },
  ],
  handoffs: {
    items: [
      {
        id: 'preview-handoff-2026', memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', memberName: 'Maya Chen',
        initiatedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
        fromStewardId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
        fromStewardName: 'Jordan Lee', toStewardName: 'Sam Okafor', direction: 'incoming', status: 'pending',
        toStewardId: 'a1111111-1111-4111-8111-111111111111',
        note: 'Confirm the next worker check-in and acknowledge responsibility.', canAcknowledge: true,
        canDecline: true, canCancel: false, createdAt: '2026-08-19T14:30:00.000Z',
      },
      {
        id: 'preview-handoff-2025', memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', memberName: 'Sam Okafor',
        initiatedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
        fromStewardId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
        fromStewardName: 'Maya Chen', toStewardName: 'Jordan Lee', direction: 'overseen', status: 'acknowledged',
        toStewardId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
        note: 'Completed after the receiving committee member confirmed the transition.', canAcknowledge: false,
        canDecline: false, canCancel: false, createdAt: '2025-10-09T16:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
};

export function MemberSupportScreen({ initialTab }: { initialTab?: 'onboarding' } = {}) {
  const { catalogLabel, t } = useNativeUi();
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { mode, dashboard, previewHat, authorizedRoles, chapterMemberships, organizationID, organizationRoles, chapterRoles } = useApp();
  const selectedMembership = chapterMemberships.find((entry) => entry.selected) ?? null;
  const selectedHat = resolveMemberSupportHat(mode, previewHat, authorizedRoles, organizationRoles);
  // Provider refreshes can recreate equivalent role arrays and membership
  // objects. Reload only when their authorization values actually change.
  const actorKey = JSON.stringify(buildNativeActor({
    userId: dashboard?.member.id ?? null,
    organizationId: organizationID,
    chapterId: selectedMembership?.chapterID ?? dashboard?.member.chapterID ?? null,
    roles: authorizedRoles,
    organizationRoles,
    chapterRoles,
    selectedHat,
    authenticated: mode === 'authenticated',
    mfaSatisfied: mode === 'authenticated',
  }));
  const requests = useBusinessRequests(writer);
  const actor = useMemo(() => normalizeMemberSupportActor(JSON.parse(actorKey)), [actorKey]);
  const operationOwner = useBusinessRequestOwner();
  const adapter = useBusinessOperationCache(operationOwner.workspace, () => {
    const client = getSupabaseClient();
    const factory = (bound: typeof client) => createMemberSupportAdapter(bound, { apiOrigin: mobileConfig.portalBaseUrl, randomUUID: Crypto.randomUUID });
    return client ? bindBusinessApi(client, writer, factory, ['get_member_support_workspace', 'get_member_onboarding_oversight', 'list_member_handoffs_v2', 'search_handoff_members', 'search_handoff_stewards']) : factory(null);
  });
  const [tab, setTab] = useBusinessDraftState<TabID>(initialTab ?? 'rights');
  const [model, setModel] = useBusinessState<Workspace | null>(null);
  const [busy, setBusy] = useBusinessState(false);
  const [control] = useBusinessState(() => ({ current: false }));
  const [unconfirmedWrite, setUnconfirmedWrite] = useBusinessSubjectState(JSON.stringify([organizationID, selectedMembership?.chapterID ?? dashboard?.member.chapterID]), false);
  const [notice, setNotice] = useBusinessDraftState<{ message: string; tone: MemberSupportNoticeTone; attempt: number }>({ message: '', tone: 'success', attempt: 0 });
  // Every outcome — the five member panels through commit() and the staff
  // handoff panel through onNotice — lands here. The Android live region below
  // speaks it on TalkBack; iOS has no live-region equivalent, so the same
  // sentence is queued through the shared helper, gated to iOS so TalkBack is
  // not told twice. The attempt counter makes a repeated identical outcome a
  // distinct announcement instead of a silent no-op. A failure carries the
  // error tone and renders through the destructive Notice.
  const publishNotice = useCallback((next: MemberSupportNotice) => {
    setNotice((current) => ({ message: next?.message ?? '', tone: next?.tone ?? 'success', attempt: current.attempt + 1 }));
  }, [setNotice]);
  const [reload, setReload] = useBusinessDraftState(0);
  const workspaceReads = useRef(0);
  const visibleTabs = MEMBER_SUPPORT_TABS
    .filter((item) => !('staffOnly' in item) || !item.staffOnly || Boolean(model?.staff))
    .map((item) => ({ id: item.id as TabID, label: item.label }));

  useEffect(() => {
    if (tab === 'handoffs' && !model?.staff) setTab('rights');
  }, [model?.staff, tab, setTab]);

  useEffect(() => {
    // The destructive Notice announces its own message, so an error tone is
    // left to it and VoiceOver hears each failure once.
    if (notice.message && notice.tone !== 'error' && Platform.OS === 'ios') {
      return queueAccessibilityAnnouncement(notice.message, `member-support:${notice.attempt}`);
    }
    return undefined;
  }, [notice.attempt, notice.message, notice.tone]);

  useEffect(() => {
    if (mode === 'preview') {
      setModel({ ...previewWorkspace, viewerUserId: dashboard?.member.id ?? null, staff: Boolean(previewHat && previewHat !== 'member') });
      return undefined;
    }
    const ticket = requests.capture();
    const at = ++workspaceReads.current;
    let current = true;
    setModel(null);
    void loadWorkspace(adapter, actor).then((next) => { if (current && ticket.isCurrent() && at === workspaceReads.current) setModel(next); });
    return () => { current = false; };
  }, [actor, adapter, dashboard?.member.id, mode, previewHat, reload, requests, setModel]);

  async function commit(operation: () => Promise<unknown>, success: string, editorCurrent?: () => boolean): Promise<boolean> {
    // The fictional preview keeps no records: nothing is sent, and the screen says so.
    if (mode === 'preview') { publishNotice({ message: 'Preview changes are not saved.', tone: 'success' }); return false; }
    const screenCurrent = requests.capture().isCurrent;
    const current = () => screenCurrent() && (editorCurrent?.() ?? true);
    if (control.current || unconfirmedWrite || !current()) return false;
    control.current = true;
    setBusy(true); publishNotice(null);
    try {
      let needsRefresh = false;
      const settled = await settleMemberSupportCommit(async () => {
        await operation();
        needsRefresh = true;
        // Records belong to the current workspace. Notices and draft resets
        // belong to the editor that submitted them.
        if (!editorCurrent) setUnconfirmedWrite(true);
        if (screenCurrent()) workspaceReads.current += 1;
        if (await checkBusinessContinuation(writer, screenCurrent) === 'current') {
          const at = ++workspaceReads.current;
          const next = await loadWorkspace(adapter, actor);
          if (await writer.isCurrent() && screenCurrent() && at === workspaceReads.current) {
            // A transient read failure must not replace a reopened editor.
            // An authorization refusal still replaces the old workspace.
            if (current() || (next.state !== 'error' && next.state !== 'unavailable')) setModel(next);
            if (next.state === 'ready') {
              needsRefresh = false;
              if (!editorCurrent) setUnconfirmedWrite(false);
            }
          }
        }
      }, success);
      const proof = await checkBusinessContinuation(writer, needsRefresh ? screenCurrent : current);
      if (proof === 'changed' || !screenCurrent()) return false;
      if (editorCurrent && needsRefresh) setUnconfirmedWrite(true);
      if (!current()) return false;
      publishNotice(settled.ok && proof === 'unavailable' ? { tone: 'success', message: t(BUSINESS_SAVED_STALE) } : settled.notice);
      if (await writer.isCurrent() && current()) void (settled.ok ? haptics.success() : haptics.warning());
      return settled.ok && current();
    } finally { control.current = false; setBusy(false); }
  }

  async function refreshAccepted() {
    if (control.current) return;
    control.current = true;
    setBusy(true);
    try {
      const ticket = requests.capture();
      if (!ticket.isCurrent()) return;
      const at = ++workspaceReads.current;
      const current = () => ticket.isCurrent() && at === workspaceReads.current;
      if (await checkBusinessContinuation(writer, current) !== 'current') return;
      const next = await loadWorkspace(adapter, actor);
      if (!current()) return;
      setModel(next); if (next.state === 'ready') { setUnconfirmedWrite(false); publishNotice(null); }
    } finally { control.current = false; setBusy(false); }
  }
  return <Screen>
    {unconfirmedWrite ? <Button label={t('Refresh')} variant="secondary" disabled={busy} onPress={() => void refreshAccepted()} /> : null}
    {unconfirmedWrite && !notice.message ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
    <NativeFeatureGuide feature="member-support" />
    <Heading>{catalogLabel('Worker support')}</Heading>
    <Body muted>Urgent guidance, accommodation intake, HR outreach, onboarding, and mentorship in one private place.</Body>
    <View accessibilityRole="tablist" style={styles.tabs}>
      {visibleTabs.map((item) => <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityState={{ selected: tab === item.id }}
        onPress={() => { setTab(item.id); void haptics.select(); }}
        style={({ pressed }) => [styles.tab, { borderColor: tab === item.id ? theme.ring : theme.border, backgroundColor: tab === item.id ? theme.secondary : theme.card, opacity: pressed ? 0.82 : 1 }]}
      ><Text style={[styles.tabLabel, { color: tab === item.id ? theme.secondaryForeground : theme.cardForeground }]}>{item.label}</Text></Pressable>)}
    </View>
    {!notice.message ? null : notice.tone === 'error'
      ? <Notice key={notice.attempt}>{notice.message}</Notice>
      : <Body style={{ color: theme.primary }}><Text accessibilityLiveRegion="polite">{notice.message === BUSINESS_SAVED_STALE ? t(BUSINESS_SAVED_STALE) : notice.message}</Text></Body>}
    {model === null ? <StateMessage title="Loading worker support" body="Getting your latest information." /> : model.state !== 'ready' ? <Card><Heading level={3}>Worker support is not available</Heading><Body muted>Nothing was changed.</Body><Button label="Try again" variant="secondary" onPress={() => setReload((value) => value + 1)} /></Card> : null}
    {model?.state === 'ready' && tab === 'rights' ? <EmergencyPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} /> : null}
    {model?.state === 'ready' && tab === 'accommodations' ? <AccommodationPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} /> : null}
    {model?.state === 'ready' && tab === 'hr' ? <HrPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} /> : null}
    {model?.state === 'ready' && tab === 'onboarding' ? <OnboardingPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} /> : null}
    {model?.state === 'ready' && tab === 'mentorship' ? <MentorshipPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} /> : null}
    {model?.state === 'ready' && model.staff && tab === 'handoffs' ? <HandoffsPanel model={model} actor={actor} adapter={adapter} busy={busy} disabled={unconfirmedWrite} commit={commit} selectedHat={selectedHat} onNotice={publishNotice} /> : null}
  </Screen>;
}

type PanelProps = { model: Workspace; actor: unknown; adapter: ReturnType<typeof createMemberSupportAdapter>; busy: boolean; disabled: boolean; commit: (operation: () => Promise<unknown>, success: string, editorCurrent?: () => boolean) => Promise<boolean> };

function EmergencyPanel({ model, actor, adapter, busy, disabled, commit }: PanelProps) {
  const theme = useTheme();
  const [scenarioId, setScenarioId] = useBusinessDraftState<string>(EMERGENCY_SCENARIOS[0]!.id);
  const scenario = EMERGENCY_SCENARIOS.find((entry: { id: string }) => entry.id === scenarioId) ?? EMERGENCY_SCENARIOS[0]!;
  const saved = model.emergencyChecklists.find((entry) => entry.scenario === scenario.id
    && (!entry.memberUserId || entry.memberUserId === model.viewerUserId));
  const stewardAlerts = model.staff
    ? model.emergencyChecklists.filter((entry) => entry.status === 'alerted' && entry.memberUserId !== model.viewerUserId)
    : [];
  const [steps, setSteps] = useBusinessDraftState<number[]>(saved?.completedSteps ?? []);
  const [notes, setNotes] = useBusinessDraftState(saved?.notes ?? '');
  useEffect(() => {
    setSteps(saved?.completedSteps ?? []);
    setNotes(saved?.notes ?? '');
  }, [saved?.completedSteps, saved?.notes, scenarioId, setSteps, setNotes]);
  const resolve = (checklistId: string) => {
    void commit(
      () => adapter.resolveEmergencyChecklist(actor, checklistId),
      'Emergency alert resolved.',
    );
  };
  return <View style={styles.section}>
    <View accessibilityRole="radiogroup" style={styles.choiceRow}>{EMERGENCY_SCENARIOS.map((entry: { id: string; label: string }, index: number, choices: readonly unknown[]) => <Pressable
      key={entry.id}
      accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Emergency scenario', entry.label, index, choices.length)}
      accessibilityState={{ selected: scenario.id === entry.id }}
      onPress={() => { setScenarioId(entry.id); void haptics.select(); }}
      style={[styles.choice, { backgroundColor: scenario.id === entry.id ? theme.secondary : theme.card, borderColor: scenario.id === entry.id ? theme.ring : theme.border }]}
    ><Text style={{ color: theme.foreground }}>{entry.label}</Text></Pressable>)}</View>
    <Card hero><Heading level={2}>Emergency rights checklist</Heading><Body muted>{scenario.summary}</Body><Body>{saved?.status === 'alerted' ? 'A committee member alert is open.' : `${steps.length} of ${scenario.steps.length} steps saved.`}</Body></Card>
    {model.staff ? <View style={styles.section}><Heading level={2}>Alerts needing a committee member response</Heading>{stewardAlerts.length === 0 ? <StateMessage title="No open alerts" body="Worker alerts that need a response will appear here." /> : stewardAlerts.map((entry) => {
      const alertedScenario = EMERGENCY_SCENARIOS.find((item: { id: string }) => item.id === entry.scenario);
      return <Card key={entry.id}><Body muted>{entry.memberLabel || 'Worker'} · {alertedScenario?.label || label(entry.scenario)}</Body><Heading level={3}>Committee response requested</Heading><Body>{entry.completedSteps.length} of {alertedScenario?.steps.length || 0} checklist steps saved.</Body>{entry.notes ? <Body muted>{entry.notes}</Body> : null}<Button label="Resolve alert" variant="secondary" disabled={disabled || (busy)} onPress={() => resolve(entry.id)} /></Card>;
    })}</View> : null}
    {scenario.steps.map((step: string, index: number) => <Pressable key={step} accessibilityRole="checkbox" accessibilityState={{ checked: steps.includes(index) }} onPress={() => setSteps((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index].sort())} style={({ pressed }) => [styles.check, { backgroundColor: theme.card, borderColor: steps.includes(index) ? theme.ring : theme.border, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.marker, { color: theme.primary }]}>{steps.includes(index) ? '✓' : String(index + 1)}</Text><Body>{step}</Body></Pressable>)}
    <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Private incident notes</Text>
    <Body muted>{INCIDENT_NOTES_READERS}</Body>
    <Body muted>{INCIDENT_NOTES_RETENTION}</Body>
    <Body muted>{NOT_FOR_EMERGENCIES}</Body>
    <TextInput accessibilityLabel="Private incident notes" multiline maxLength={4000} value={notes} onChangeText={setNotes} placeholder="Private incident notes" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
    <View style={styles.actions}><Button label="Save progress" busy={busy} onPress={() => { void commit(() => adapter.saveEmergencyChecklist(actor, { scenario: scenario.id, completedSteps: steps, notes }), 'Checklist progress saved.'); }} disabled={disabled || busy} /><Button label={saved?.status === 'alerted' ? 'Committee alerted' : 'Alert a committee member now'} variant="danger" disabled={disabled || (saved?.status === 'alerted')} busy={busy} onPress={() => {
      const sendAlert = () => { void commit(() => adapter.alertEmergencySteward(actor, { scenario: scenario.id, completedSteps: steps, notes }), 'Urgent committee member alert sent.'); };
      Alert.alert(STEWARD_ALERT_CONFIRMATION.title, STEWARD_ALERT_CONFIRMATION.body, [
        { text: STEWARD_ALERT_CONFIRMATION.cancelLabel, style: 'cancel' },
        { text: STEWARD_ALERT_CONFIRMATION.confirmLabel, style: 'destructive', onPress: sendAlert },
      ]);
    }} />{saved?.status === 'alerted' ? <Button label="Mark alert resolved" variant="secondary" disabled={disabled || (busy)} onPress={() => resolve(saved.id)} /> : null}</View>
  </View>;
}

function accommodationStatusLabel(status: string) {
  switch (status) {
    case 'submitted': return 'Request submitted';
    case 'under_review': return 'Request under review';
    case 'approved': return 'Request approved';
    case 'denied': return 'Request denied';
    case 'withdrawn': return 'Request withdrawn';
    default: return 'Request status unavailable';
  }
}

function AccommodationPanel({ model, actor, adapter, busy, disabled, commit }: PanelProps) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const [requestType, setRequestType] = useBusinessDraftState('schedule');
  const [description, setDescription] = useBusinessDraftState('');
  const [staffNote, setStaffNote] = useBusinessDraftState('');
  const transition = (requestId: string, status: string) => {
    void commit(
      () => adapter.transitionAccommodation(actor, { requestId, status, staffNote }),
      'Request status updated.',
    );
  };
  return <View style={styles.section}><Card><Heading level={2}>{t('Accommodation request')}</Heading><Body muted>Describe the requested change. Do not add a diagnosis or medical record unless the process specifically requires it.</Body>
    <View accessibilityRole="radiogroup" style={styles.choiceRow}>{
      ACCOMMODATION_TYPES.map((value, index, choices) => {
        const name = choiceLabel(accommodationTypes, value, t);
        return <Pressable key={value} accessibilityRole="radio"
          accessibilityLabel={radioChoiceLabel(t('Accommodation type'), name, index, choices.length, t)}
          accessibilityState={{ selected: requestType === value }} onPress={() => setRequestType(value)}
          style={[styles.choice, { backgroundColor: requestType === value ? theme.secondary : theme.card, borderColor: requestType === value ? theme.ring : theme.border }]}>
          <Text style={{ color: theme.foreground }}>{name}</Text>
        </Pressable>;
      })
    }</View>
    <TextInput accessibilityLabel="Requested accommodation" multiline maxLength={4000} value={description} onChangeText={setDescription} placeholder="Requested change or support" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
    <Button label="Submit request" busy={busy} disabled={disabled || (!description.trim())} onPress={() => { const submitted = description; const body = submitted.trim(); void commit(() => adapter.createAccommodation(actor, { requestType, description: body }), 'Accommodation request submitted.').then((saved) => { if (saved) setDescription((current) => current === submitted ? '' : current); }); }} /></Card>
    <Heading level={2}>{t('Request history · {count}', { count: model.accommodations.length })}</Heading>
    {model.staff ? <TextInput accessibilityLabel="Accommodation staff note" multiline maxLength={2000} value={staffNote} onChangeText={setStaffNote} placeholder="Staff update" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /> : null}
    {model.accommodations.length === 0 ? <StateMessage title={t('No accommodation requests')} body={t('A submitted request and each status change will appear here.')} /> : model.accommodations.map((item) => <Card key={item.id} testID="accommodation-request">
      <Body muted>{item.memberLabel} · {choiceLabel(accommodationTypes, item.requestType, t)} · {formatDate(item.submittedAt)}</Body>
      <Heading level={3} testID="accommodation-request-status">{t(accommodationStatusLabel(item.status))}</Heading><Body>{item.description}</Body>{item.staffNote ? <Body muted>{item.staffNote}</Body> : null}
      {item.memberUserId === model.viewerUserId && ['submitted', 'under_review'].includes(item.status) ? <Button label="Withdraw request" variant="secondary" disabled={disabled || (busy)} onPress={() => transition(item.id, 'withdrawn')} /> : null}
      {model.staff && !['withdrawn', 'approved', 'denied'].includes(item.status) ? <View style={styles.actions}><Button label="Review" variant="secondary" disabled={disabled || (busy)} onPress={() => transition(item.id, 'under_review')} /><Button label="Approve" disabled={disabled || (busy)} onPress={() => transition(item.id, 'approved')} /><Button label="Deny" variant="danger" disabled={disabled || (busy)} onPress={() => transition(item.id, 'denied')} /></View> : null}
    </Card>)}</View>;
}

function useEditableSupportField(initial: string): [string, (value: string) => void, (value?: string) => void] {
  const [field, setField] = useBusinessDraftState(() => ({ value: initial }));
  // Each edit creates a new identity, even when it restores the same text.
  const edit = (value: string) => setField({ value });
  const resetIfUntouched = (value = '') => setField((current) => current === field ? { value } : current);
  return [field.value, edit, resetIfUntouched];
}

export function HrPanel({ model, actor, adapter, busy, disabled, commit }: PanelProps) {
  // A retried contact keeps its first press's time, so it reuses its key.
  const [contactStamp] = useBusinessDraftState(createIntentStamp);
  const theme = useTheme();
  const [channel, setChannel] = useBusinessDraftState('email');
  const [disposition, setDisposition] = useBusinessDraftState('planned');
  const editorRequests = useRequestGeneration(useBusinessRequestOwner());
  const [purpose, setPurpose, resetPurpose] = useEditableSupportField('');
  const [note, setNote, resetNote] = useEditableSupportField('');
  const [followUpOn, setFollowUpOn, resetFollowUp] = useEditableSupportField('');
  // Staff pick the member explicitly (Save stays disabled until they do), so a
  // contact is never filed against the steward by default.
  const [memberUserId, setMemberUserId] = useBusinessDraftState(model.staff ? '' : model.viewerUserId ?? '');
  const [directoryName, setDirectoryName] = useBusinessDraftState(model.hrDirectory?.name ?? '');
  const [directoryEmail, setDirectoryEmail] = useBusinessDraftState(model.hrDirectory?.email ?? '');
  const [directoryPhone, setDirectoryPhone] = useBusinessDraftState(model.hrDirectory?.phone ?? '');
  const [directoryHours, setDirectoryHours] = useBusinessDraftState(model.hrDirectory?.hours ?? '');
  const { t } = useNativeUi();
  function saveContact() {
    const submittedPurpose = purpose.trim();
    const followUp = followUpOn || null;
    const current = editorRequests.capture().isCurrent;
    void commit(() => {
      const occurredAt = contactStamp.stamp(JSON.stringify([model.staff ? memberUserId : null, channel, submittedPurpose, disposition, note, followUp]));
      return adapter.recordHrContact(actor, {
        memberUserId: model.staff ? memberUserId : null, channel, purpose: submittedPurpose, disposition, note, occurredAt, followUpOn: followUp,
      });
    }, 'HR contact recorded.', current).then((saved) => {
      if (!saved || !current()) return;
      contactStamp.settle();
      resetPurpose();
      resetNote();
      resetFollowUp();
    });
  }

  // What holds Save contact, said beside it (record 9468); the panel's own hold has its own line.
  const contactReason = disabled ? undefined : model.staff && !memberUserId ? t('Choose the worker this contact was with.')
    : !purpose.trim() ? t('Enter the purpose of this contact.') : t('Enter the follow-up date as YYYY-MM-DD.');
  return <View style={styles.section}>{model.hrDirectory ? <Card hero><Heading level={2}>{model.hrDirectory.name}</Heading><Body muted>{[model.hrDirectory.title, model.hrDirectory.department].filter(Boolean).join(' · ')}</Body><Body>{model.hrDirectory.phone}{model.hrDirectory.email ? ` · ${model.hrDirectory.email}` : ''}</Body><Body muted>{model.hrDirectory.hours}</Body></Card> : <StateMessage title={t('HR directory is not configured')} body={t('No placeholder organization contact is shown.')} />}
    {model.staff ? <Card><Heading level={2}>{t('Configure HR directory')}</Heading><TextInput accessibilityLabel="HR contact name" maxLength={160} value={directoryName} onChangeText={setDirectoryName} placeholder="Contact name" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><TextInput accessibilityLabel="HR contact email" autoCapitalize="none" keyboardType="email-address" maxLength={320} value={directoryEmail} onChangeText={setDirectoryEmail} placeholder="Email" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><TextInput accessibilityLabel="HR contact phone" keyboardType="phone-pad" maxLength={80} value={directoryPhone} onChangeText={setDirectoryPhone} placeholder="Phone" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><TextInput accessibilityLabel="HR contact hours" maxLength={500} value={directoryHours} onChangeText={setDirectoryHours} placeholder="Hours" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><Button label="Save HR directory" busy={busy} onPress={() => { void commit(() => adapter.saveHrDirectory(actor, { name: directoryName, title: model.hrDirectory?.title ?? '', department: model.hrDirectory?.department ?? '', email: directoryEmail, phone: directoryPhone, hours: directoryHours, notes: model.hrDirectory?.notes ?? '', enabled: true }), 'HR directory saved.'); }} disabled={disabled || busy} /></Card> : null}
    <Card><Heading level={2}>{t('Record HR contact')}</Heading>{model.staff ? <View accessibilityRole="radiogroup" style={styles.choiceRow}>{model.mentorshipDirectory.map((person, index, choices) => <Pressable key={person.userId} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Worker for HR contact', person.label, index, choices.length)} accessibilityState={{ selected: memberUserId === person.userId }} onPress={() => setMemberUserId(person.userId)} style={[styles.choice, { backgroundColor: memberUserId === person.userId ? theme.secondary : theme.card, borderColor: memberUserId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: theme.foreground }}>{person.label}</Text></Pressable>)}</View> : null}<View accessibilityRole="radiogroup" style={styles.choiceRow}>{
      Object.keys(hrChannels).map((value, index, choices) => {
        const name = choiceLabel(hrChannels, value, t);
        return <Pressable key={value} accessibilityRole="radio"
          accessibilityLabel={radioChoiceLabel(t('HR contact channel'), name, index, choices.length, t)}
          accessibilityState={{ selected: channel === value }} onPress={() => setChannel(value)}
          style={[styles.choice, { backgroundColor: channel === value ? theme.secondary : theme.card, borderColor: channel === value ? theme.ring : theme.border }]}>
          <Text style={{ color: theme.foreground }}>{name}</Text>
        </Pressable>;
      })
    }</View><TextInput accessibilityLabel="Contact purpose" maxLength={240} value={purpose} onChangeText={setPurpose} placeholder="Purpose" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><View accessibilityRole="radiogroup" style={styles.choiceRow}>{
      HR_CONTACT_DISPOSITIONS.map((value, index, choices) => {
        const name = choiceLabel(hrDispositions, value, t);
        return <Pressable key={value} accessibilityRole="radio"
          accessibilityLabel={radioChoiceLabel(t('HR contact disposition'), name, index, choices.length, t)}
          accessibilityState={{ selected: disposition === value }} onPress={() => setDisposition(value)}
          style={[styles.choice, { backgroundColor: disposition === value ? theme.secondary : theme.card, borderColor: disposition === value ? theme.ring : theme.border }]}>
          <Text style={{ color: theme.foreground }}>{name}</Text>
        </Pressable>;
      })
    }</View>{disposition === 'follow_up_due' ? <><Body>{t('Follow-up date (YYYY-MM-DD)')}</Body><TextInput accessibilityLabel="Follow-up date" maxLength={10} value={followUpOn} onChangeText={setFollowUpOn} placeholder="YYYY-MM-DD" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /></> : null}<TextInput accessibilityLabel="Contact note" multiline maxLength={4000} value={note} onChangeText={setNote} placeholder="Optional note" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><Button label="Save contact" busy={busy} disabled={disabled || (!purpose.trim() || (model.staff && !memberUserId) || (disposition === 'follow_up_due' && !followUpOn))} disabledReason={contactReason} onPress={saveContact} /></Card>
    <Heading level={2}>{t('Contact history · {count}', { count: model.hrContacts.length })}</Heading>{model.hrContacts.map((item) => <Card key={item.id}><Body muted>{choiceLabel(hrChannels, item.channel, t)} · {formatDate(item.occurredAt)}</Body><Heading level={3}>{item.purpose}</Heading><Body>{choiceLabel(hrDispositions, item.disposition, t)}</Body>{item.note ? <Body muted>{item.note}</Body> : null}</Card>)}</View>;
}

// REQ-UG-DEFAULT-NEW-MEMBER-ONBOARDING-PROGRAM-20261006 (owner
// decision October 8, 2026): the web starting list, shown while the
// organization has no active step of its own. Content only: never stored and
// never a plan, so there is nothing to start or complete for it.
const DEFAULT_ONBOARDING_NOTE = 'Your campaign has no onboarding steps turned on right now, so here is where most new workers start. When your campaign turns on its own steps, they replace this list.';
const DEFAULT_ONBOARDING_STAFF_NOTE = 'Until you add an active step, workers see the Union Ground starting list (welcome, finish your profile, meet your committee contact, read the organizing guide). Your first active step replaces it. Worker plans start only from your own steps.';
const DEFAULT_ONBOARDING_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['Welcome', 'Union Ground is where you find your organizing rights, your committee contact and your campaign’s news.'],
  ['Finish your profile', 'Open your profile (Settings on the web, Account in the app) and check that your name is right. Then check your campaign (in Settings on the web, at the top of Home in the app), so your committee knows who you are.'],
  ['Meet your committee contact', 'Use Find my committee contact on Home to see who to reach. Send them a short hello in Messages so you know who to ask.'],
  ['Read the organizing guide', 'Open Organizing rights and start with the first lesson.'],
];

function OnboardingPanel({ model, actor, adapter, busy, disabled, commit }: PanelProps) {
  const theme = useTheme();
  const router = useRouter();
  const { mode } = useApp();
  const editorRequests = useRequestGeneration(useBusinessRequestOwner());
  const [stepTitle, setStepTitle, resetTitle] = useEditableSupportField('');
  const [stepDescription, setStepDescription, resetDescription] = useEditableSupportField('');
  const [stepPosition, setStepPosition, resetPosition] =
    useEditableSupportField(String((model.onboardingProgram.at(-1)?.position ?? 0) + 10));
  const [memberUserId, setMemberUserId] = useBusinessDraftState(model.mentorshipDirectory[0]?.userId ?? '');
  function saveStep() {
    const position = Number(stepPosition);
    const current = editorRequests.capture().isCurrent;
    void commit(() => adapter.saveOnboardingStep(actor, {
      title: stepTitle.trim(), description: stepDescription, position, active: true,
    }), 'Onboarding step saved.', current).then((saved) => {
      if (!saved || !current()) return;
      resetTitle();
      resetDescription();
      resetPosition(String(position + 10));
    });
  }

  const completed = new Set(model.onboardingPlan?.completedStepIds ?? []);
  const next = model.onboardingProgram.find((step) => step.active && !completed.has(step.id));
  return <View style={styles.section}>
    <Card hero><Heading level={2}>New-worker onboarding</Heading><Body muted>Plans begin only after a worker or a staff member starts one.</Body><Body>{model.onboardingPlan ? label(model.onboardingPlan.status) : 'Not started'}</Body></Card>
    {!model.onboardingProgram.some((step) => step.active) ? <><Card><Heading level={3}>Getting started</Heading><Body muted>{DEFAULT_ONBOARDING_NOTE}</Body></Card>{DEFAULT_ONBOARDING_STEPS.map(([title, description], index) => <Card key={title}><Body muted>{`Step ${index + 1}`}</Body><Heading level={3}>{title}</Heading><Body>{description}</Body>{index === DEFAULT_ONBOARDING_STEPS.length - 1 ? <Button label="Open Organizing rights" variant="secondary" onPress={() => router.push('/feature/rights')} /> : null}</Card>)}</> : model.onboardingProgram.filter((step) => step.active).map((step, index) => <Card key={step.id}><Body muted>{completed.has(step.id) ? 'Completed' : `Step ${index + 1}`}</Body><Heading level={3}>{step.title}</Heading><Body>{step.description}</Body></Card>)}
    {!model.onboardingPlan && model.onboardingProgram.some((step) => step.active) ? <Button label="Start my onboarding plan" busy={busy} onPress={() => { void commit(() => adapter.startOnboarding(actor), 'Onboarding plan started.'); }} disabled={disabled || busy} /> : null}
    {model.onboardingPlan && next ? <Button label={`Complete ${next.title}`} busy={busy} onPress={() => { void commit(() => adapter.completeOnboardingStep(actor, next.id), 'Onboarding step completed.'); }} disabled={disabled || busy} /> : null}
    {model.staff ? <Card><Heading level={2}>Program and oversight</Heading>{model.onboardingProgram.some((step) => step.active) ? null : <Body muted>{DEFAULT_ONBOARDING_STAFF_NOTE}</Body>}<TextInput accessibilityLabel="Onboarding step title" maxLength={160} value={stepTitle} onChangeText={setStepTitle} placeholder="Step title" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><TextInput accessibilityLabel="Onboarding step description" multiline maxLength={2000} value={stepDescription} onChangeText={setStepDescription} placeholder="Description" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><TextInput accessibilityLabel="Onboarding step position" keyboardType="number-pad" maxLength={4} value={stepPosition} onChangeText={setStepPosition} placeholder="Position" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><Button label="Add onboarding step" busy={busy} disabled={disabled || (!stepTitle.trim())} onPress={saveStep} /><Heading level={3}>Start a worker plan</Heading><View accessibilityRole="radiogroup" style={styles.choiceRow}>{model.mentorshipDirectory.map((person, index, choices) => <Pressable key={person.userId} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Onboarding worker', person.label, index, choices.length)} accessibilityState={{ selected: memberUserId === person.userId }} onPress={() => setMemberUserId(person.userId)} style={[styles.choice, { backgroundColor: memberUserId === person.userId ? theme.secondary : theme.card, borderColor: memberUserId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: theme.foreground }}>{person.label}</Text></Pressable>)}</View><Button label="Start selected worker" variant="secondary" busy={busy} disabled={disabled || (!memberUserId || !model.onboardingProgram.some((step) => step.active))} onPress={() => { void commit(() => adapter.startOnboarding(actor, memberUserId), 'Worker onboarding plan started.'); }} />{(() => {
      const roster = <><Heading level={3}>Roster</Heading>{model.onboardingRoster.length === 0 ? <Body muted>No plans have been started.</Body> : model.onboardingRoster.map((entry) => <Body key={entry.id}>{entry.memberLabel} · {label(entry.status)} · {entry.completedStepIds.length}/{model.onboardingProgram.filter((step) => step.active).length}</Body>)}</>;
      // REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001: live
      // staff get the stalled flag and complete / skip / reset.
      return mode === 'preview' ? roster : <NativeOnboardingOversight adapter={adapter} actor={actor} busy={busy} disabled={disabled} commit={commit} reloadKey={model} fallback={roster} />;
    })()}</Card> : null}
  </View>;
}

type MentorshipPairCardProps = Omit<PanelProps, 'model'> & {
  pair: Workspace['mentorshipPairs'][number];
  staff: boolean;
};

function MentorshipPairCard({ pair, staff, actor, adapter, busy, disabled, commit }: MentorshipPairCardProps) {
  const theme = useTheme();
  const [goal, setGoal] = useBusinessDraftState('');
  const [note, setNote] = useBusinessDraftState('');
  const [outcome, setOutcome] = useBusinessDraftState('');
  return <Card>
    <Body muted>{pair.status} · started {pair.startedOn ?? 'date unavailable'}</Body>
    <Heading level={3}>{pair.mentorLabel} → {pair.menteeLabel}</Heading>
    {pair.outcome ? <Body>{pair.outcome}</Body> : null}
    <Heading level={3}>Goals</Heading>
    {pair.goals.map((item) => <Pressable
      key={item.id}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: item.completed }}
      disabled={disabled || busy}
      onPress={() => { void commit(
        () => adapter.saveMentorshipGoal(actor, { pairId: pair.id, goalId: item.id, title: item.title, completed: !item.completed }),
        'Mentorship goal updated.',
      ); }}
      style={styles.goal}
    ><Text style={{ color: theme.primary }}>{item.completed ? '✓' : '○'}</Text><Body>{item.title}</Body></Pressable>)}
    <TextInput accessibilityLabel={`New goal for ${pair.menteeLabel}`} maxLength={200} value={goal} onChangeText={setGoal} placeholder="New goal" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
    <Button label="Add goal" variant="secondary" busy={busy} disabled={disabled || !goal.trim()} onPress={() => { const submitted = goal; const title = submitted.trim(); void commit(
      () => adapter.saveMentorshipGoal(actor, { pairId: pair.id, title, completed: false }),
      'Mentorship goal saved.',
    ).then((saved) => { if (saved) setGoal((current) => current === submitted ? '' : current); }); }} />
    <Heading level={3}>Notes</Heading>
    {pair.notes.slice(0, 4).map((item) => <Body key={item.id} muted>{item.authorLabel}: {item.body}</Body>)}
    <TextInput accessibilityLabel={`New note for ${pair.menteeLabel}`} multiline maxLength={4000} value={note} onChangeText={setNote} placeholder="New note" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
    <Button label="Add note" variant="secondary" busy={busy} disabled={disabled || !note.trim()} onPress={() => { const submitted = note; const body = submitted.trim(); void commit(
      () => adapter.addMentorshipNote(actor, { pairId: pair.id, body }),
      'Mentorship note saved.',
    ).then((saved) => { if (saved) setNote((current) => current === submitted ? '' : current); }); }} />
    {staff && pair.status === 'active' ? <>
      <TextInput accessibilityLabel={`Outcome for ${pair.menteeLabel}`} multiline maxLength={2000} value={outcome} onChangeText={setOutcome} placeholder="Outcome summary" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
      <View style={styles.actions}>
        <Button label="Complete pairing" disabled={disabled || busy} onPress={() => { void commit(
          () => adapter.transitionMentorshipPair(actor, { pairId: pair.id, status: 'completed', outcome }),
          'Mentorship completed.',
        ); }} />
        <Button label="Cancel pairing" variant="danger" disabled={disabled || busy} onPress={() => { void commit(
          () => adapter.transitionMentorshipPair(actor, { pairId: pair.id, status: 'cancelled', outcome }),
          'Mentorship cancelled.',
        ); }} />
      </View>
    </> : null}
  </Card>;
}

function MentorshipPanel({ model, actor, adapter, busy, disabled, commit }: PanelProps) {
  const theme = useTheme();
  const [mentorUserId, setMentorUserId] = useBusinessDraftState(model.mentorshipDirectory[0]?.userId ?? '');
  const [menteeUserId, setMenteeUserId] = useBusinessDraftState(model.mentorshipDirectory[1]?.userId ?? '');
  return <View style={styles.section}>
    <Heading level={2}>Mentorship · {model.mentorshipPairs.length}</Heading>
    {model.staff ? <Card><Heading level={2}>Create a pairing</Heading><Body muted>Choose two active workers in the selected organization.</Body><Heading level={3}>Mentor</Heading><View accessibilityRole="radiogroup" style={styles.choiceRow}>{model.mentorshipDirectory.map((person, index, choices) => <Pressable key={`mentor-${person.userId}`} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Mentorship mentor', person.label, index, choices.length)} accessibilityState={{ selected: mentorUserId === person.userId }} onPress={() => setMentorUserId(person.userId)} style={[styles.choice, { backgroundColor: mentorUserId === person.userId ? theme.secondary : theme.card, borderColor: mentorUserId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: theme.foreground }}>{person.label}</Text></Pressable>)}</View><Heading level={3}>Mentee</Heading><View accessibilityRole="radiogroup" style={styles.choiceRow}>{model.mentorshipDirectory.map((person, index, choices) => <Pressable key={`mentee-${person.userId}`} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Mentorship mentee', person.label, index, choices.length)} accessibilityState={{ selected: menteeUserId === person.userId }} onPress={() => setMenteeUserId(person.userId)} style={[styles.choice, { backgroundColor: menteeUserId === person.userId ? theme.secondary : theme.card, borderColor: menteeUserId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: theme.foreground }}>{person.label}</Text></Pressable>)}</View><Button label="Create mentorship pair" busy={busy} disabled={disabled || (!mentorUserId || !menteeUserId || mentorUserId === menteeUserId)} onPress={() => { void commit(() => adapter.createMentorshipPair(actor, { mentorUserId, menteeUserId }), 'Mentorship pair created.'); }} /></Card> : null}
    {model.mentorshipPairs.length === 0
      ? <StateMessage title="No mentorship pairing" body="A staff member can create a formal pairing." />
      : model.mentorshipPairs.map((pair) => <MentorshipPairCard
        key={pair.id}
        pair={pair}
        staff={model.staff}
        actor={actor}
        adapter={adapter}
        busy={busy}
        disabled={disabled}
        commit={commit}
      />)}
  </View>;
}

type HandoffsPanelProps = PanelProps & {
  selectedHat: string;
  onNotice: (notice: MemberSupportNotice) => void;
};

const HANDOFF_SEARCH_MIN_LENGTH = 2;

function HandoffsPanel({ model, actor, adapter, busy, disabled, commit, selectedHat, onNotice }: HandoffsPanelProps) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const announceSearch = useAccessibilityAnnouncementQueue(useId());
  const shortQueryHint = t('Enter at least {count} characters to search.', { count: HANDOFF_SEARCH_MIN_LENGTH });
  const [memberQuery, setMemberQuery] = useBusinessDraftState('');
  const [stewardQuery, setStewardQuery] = useBusinessDraftState('');
  const [members, setMembers] = useBusinessDraftState<HandoffPerson[]>([]);
  const [stewards, setStewards] = useBusinessDraftState<HandoffPerson[]>([]);
  const [emptySearch, setEmptySearch] = useBusinessDraftState({ member: false, steward: false });
  const [memberId, setMemberId] = useBusinessDraftState('');
  const [stewardId, setStewardId] = useBusinessDraftState('');
  const [note, setNote] = useBusinessDraftState('');
  const [status, setStatus] = useBusinessDraftState<'' | HandoffStatus>('');
  const [history, setHistory] = useBusinessDraftState<HandoffPage>(model.handoffs);
  const [searchingPeople, setSearchingPeople] = useBusinessDraftState(false);
  const [loadingHistory, setLoadingHistory] = useBusinessDraftState(false);
  const historyRequestRef = useRef(0);
  const peopleSearchRequestRef = useRef<Record<'member' | 'steward', number>>({ member: 0, steward: 0 });
  const memberQueryRef = useRef(memberQuery);
  const stewardQueryRef = useRef(stewardQuery);
  memberQueryRef.current = memberQuery;
  stewardQueryRef.current = stewardQuery;
  const statusRef = useRef<'' | HandoffStatus>(status);
  statusRef.current = status;
  const canInitiate = canInitiateMemberHandoff(selectedHat === 'member' ? [] : [selectedHat]);

  useEffect(() => {
    const requestId = ++historyRequestRef.current;
    const currentStatus = statusRef.current;
    if (!currentStatus) {
      setHistory({
        items: currentStatus ? model.handoffs.items.filter((item) => item.status === currentStatus) : model.handoffs.items,
        nextCursor: currentStatus ? null : model.handoffs.nextCursor,
        loadError: model.handoffs.loadError,
      });
      setLoadingHistory(false);
      return;
    }
    setLoadingHistory(true);
    void adapter.listHandoffs(actor, { status: currentStatus }).then((value) => {
      if (historyRequestRef.current !== requestId) return;
      const page = value as HandoffPage;
      setHistory({ ...page, loadError: false });
    }).catch(() => {
      if (historyRequestRef.current !== requestId) return;
      setHistory({ items: [], nextCursor: null, loadError: true });
      onNotice(failureNotice('Handoff history could not be refreshed.'));
    }).finally(() => {
      if (historyRequestRef.current === requestId) setLoadingHistory(false);
    });
  }, [actor, adapter, model.handoffs, onNotice, setHistory, setLoadingHistory]);

  useEffect(() => () => {
    historyRequestRef.current += 1;
    peopleSearchRequestRef.current.member += 1;
    peopleSearchRequestRef.current.steward += 1;
  }, []);

  function updatePeopleQuery(kind: 'member' | 'steward', value: string) {
    peopleSearchRequestRef.current[kind] += 1;
    setSearchingPeople(false);
    setEmptySearch((previous) => ({ ...previous, [kind]: false }));
    if (kind === 'member') {
      memberQueryRef.current = value;
      setMemberQuery(value);
      setMembers([]);
      setMemberId('');
      return;
    }
    stewardQueryRef.current = value;
    setStewardQuery(value);
    setStewards([]);
    setStewardId('');
  }

  function noMatches(kind: 'member' | 'steward', query: string) {
    return t(kind === 'member' ? 'No workers match “{query}”.' : 'No receiving committee members match “{query}”.', { query });
  }

  async function searchPeople(kind: 'member' | 'steward') {
    if (!canInitiate) return;
    const query = (kind === 'member' ? memberQuery : stewardQuery).trim();
    if (query.length < HANDOFF_SEARCH_MIN_LENGTH) return;
    const requestId = ++peopleSearchRequestRef.current[kind];
    setSearchingPeople(true);
    setEmptySearch((previous) => ({ ...previous, [kind]: false }));
    onNotice(null);
    try {
      const result = await (kind === 'member'
        ? adapter.searchHandoffMembers(actor, query)
        : adapter.searchHandoffStewards(actor, query)) as HandoffPerson[];
      const currentQuery = kind === 'member' ? memberQueryRef.current : stewardQueryRef.current;
      if (peopleSearchRequestRef.current[kind] !== requestId || currentQuery.trim() !== query) return;
      const safe = (Array.isArray(result) ? result : []).filter((person) => person?.userId && person?.displayName);
      if (kind === 'member') setMembers(safe);
      else setStewards(safe);
      if (Array.isArray(result) && safe.length === 0) {
        setEmptySearch((previous) => ({ ...previous, [kind]: true }));
        announceSearch(noMatches(kind, query));
      }
    } catch {
      const currentQuery = kind === 'member' ? memberQueryRef.current : stewardQueryRef.current;
      if (peopleSearchRequestRef.current[kind] !== requestId || currentQuery.trim() !== query) return;
      onNotice(failureNotice(`${kind === 'member' ? 'Worker' : 'Committee'} search could not be completed.`));
    } finally {
      if (peopleSearchRequestRef.current[kind] === requestId) setSearchingPeople(false);
    }
  }

  async function filterHistory(nextStatus: '' | HandoffStatus) {
    const requestId = ++historyRequestRef.current;
    setStatus(nextStatus);
    setLoadingHistory(true);
    onNotice(null);
    try {
      const page = await adapter.listHandoffs(actor, { status: nextStatus || null }) as HandoffPage;
      if (historyRequestRef.current !== requestId) return;
      setHistory({ ...page, loadError: false });
    } catch {
      if (historyRequestRef.current !== requestId) return;
      setHistory({ items: [], nextCursor: null, loadError: true });
      onNotice(failureNotice('Handoff history could not be filtered.'));
    } finally {
      if (historyRequestRef.current === requestId) setLoadingHistory(false);
    }
  }

  async function loadOlder() {
    if (!history.nextCursor) return;
    const requestId = ++historyRequestRef.current;
    const cursor = history.nextCursor;
    const currentStatus = status;
    setLoadingHistory(true);
    onNotice(null);
    try {
      const page = await adapter.listHandoffs(actor, {
        status: currentStatus || null,
        beforeCreatedAt: cursor.createdAt,
        beforeId: cursor.id,
      }) as HandoffPage;
      if (historyRequestRef.current !== requestId) return;
      setHistory((current) => ({ items: [...current.items, ...page.items], nextCursor: page.nextCursor, loadError: false }));
    } catch {
      if (historyRequestRef.current !== requestId) return;
      setHistory((current) => ({ ...current, loadError: true }));
      onNotice(failureNotice('Older handoffs could not be loaded.'));
    } finally {
      if (historyRequestRef.current === requestId) setLoadingHistory(false);
    }
  }

  function transitionHandoff(item: Handoff, nextStatus: HandoffStatus) {
    const operation = nextStatus === 'acknowledged'
      ? () => adapter.acknowledgeHandoff(actor, item.id)
      : nextStatus === 'declined'
        ? () => adapter.declineHandoff(actor, item.id)
        : () => adapter.cancelHandoff(actor, item.id);
    const success = nextStatus === 'acknowledged'
      ? 'Handoff acknowledged and responsibility updated.'
      : nextStatus === 'declined'
        ? 'Handoff declined.'
        : 'Handoff cancelled.';
    const run = () => { void commit(operation, success); };
    if (nextStatus === 'cancelled') {
      Alert.alert(
        'Cancel handoff?',
        'The receiving committee member will no longer be able to acknowledge this handoff.',
        [
          { text: 'Keep handoff', style: 'cancel' },
          { text: 'Cancel handoff', style: 'destructive', onPress: run },
        ],
      );
      return;
    }
    run();
  }

  const selectedMember = members.find((person) => person.userId === memberId) ?? null;
  const selectedSteward = stewards.find((person) => person.userId === stewardId) ?? null;
  const selfHandoff = Boolean(selectedMember && selectedSteward
    && selectedMember.userId === selectedSteward.userId);
  const loadedPendingCount = model.handoffs.items.filter((item) => item.status === 'pending').length;
  const statuses: ReadonlyArray<{ id: '' | HandoffStatus; label: string }> = [
    { id: '', label: 'All' },
    { id: 'pending', label: 'Pending' },
    { id: 'acknowledged', label: 'Acknowledged' },
    { id: 'declined', label: 'Declined' },
    { id: 'cancelled', label: 'Cancelled' },
  ];

  return <View style={styles.section}>
    <Card hero>
      <Heading level={2}>Committee handoffs</Heading>
      <Body muted>A receiving committee member must acknowledge before responsibility changes. Completed transfers stay in history.</Body>
      <Body>{model.handoffs.loadError
        ? 'Handoff history needs a refresh.'
        : `Latest page · ${loadedPendingCount} pending`}</Body>
    </Card>

    {canInitiate ? <Card>
      <Heading level={3}>Start a handoff</Heading>
      <TextInput accessibilityLabel="Search workers for handoff" accessibilityHint={shortQueryHint} value={memberQuery} onChangeText={(value) => updatePeopleQuery('member', value)} maxLength={100} placeholder="Search workers" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
      {memberQuery.trim().length < HANDOFF_SEARCH_MIN_LENGTH ? <Body muted>{shortQueryHint}</Body> : null}
      <Button label="Search workers" variant="secondary" busy={searchingPeople} disabled={disabled || (busy || searchingPeople || memberQuery.trim().length < HANDOFF_SEARCH_MIN_LENGTH)} onPress={() => { void searchPeople('member'); }} />
      {emptySearch.member ? <Body>{noMatches('member', memberQuery.trim())}</Body> : null}
      {members.length > 0 ? <View accessibilityRole="radiogroup" style={styles.choiceRow}>{members.map((person, index, choices) => <Pressable key={`handoff-member-${person.userId}`} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Handoff worker', person.displayName, index, choices.length)} accessibilityState={{ selected: memberId === person.userId }} onPress={() => { setMemberId(person.userId); void haptics.select(); }} style={[styles.choice, { backgroundColor: memberId === person.userId ? theme.secondary : theme.card, borderColor: memberId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: memberId === person.userId ? theme.secondaryForeground : theme.cardForeground }}>{person.displayName}</Text></Pressable>)}</View> : null}

      <TextInput accessibilityLabel="Search receiving committee members" accessibilityHint={shortQueryHint} value={stewardQuery} onChangeText={(value) => updatePeopleQuery('steward', value)} maxLength={100} placeholder="Search receiving committee members" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
      {stewardQuery.trim().length < HANDOFF_SEARCH_MIN_LENGTH ? <Body muted>{shortQueryHint}</Body> : null}
      <Button label="Search receiving committee members" variant="secondary" busy={searchingPeople} disabled={disabled || (busy || searchingPeople || stewardQuery.trim().length < HANDOFF_SEARCH_MIN_LENGTH)} onPress={() => { void searchPeople('steward'); }} />
      {emptySearch.steward ? <Body>{noMatches('steward', stewardQuery.trim())}</Body> : null}
      {stewards.length > 0 ? <View accessibilityRole="radiogroup" style={styles.choiceRow}>{stewards.map((person, index, choices) => <Pressable key={`handoff-steward-${person.userId}`} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Receiving committee member', person.displayName, index, choices.length)} accessibilityState={{ selected: stewardId === person.userId }} onPress={() => { setStewardId(person.userId); void haptics.select(); }} style={[styles.choice, { backgroundColor: stewardId === person.userId ? theme.secondary : theme.card, borderColor: stewardId === person.userId ? theme.ring : theme.border }]}><Text style={{ color: stewardId === person.userId ? theme.secondaryForeground : theme.cardForeground }}>{person.displayName}</Text></Pressable>)}</View> : null}

      <TextInput accessibilityLabel="Handoff note" multiline value={note} onChangeText={setNote} maxLength={1000} placeholder="Only the context the receiving committee member needs" placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
      {selfHandoff ? <Body muted>The worker and receiving committee member must be different people.</Body> : null}
      <Button label="Send handoff" busy={busy} disabled={disabled || (!selectedMember || !selectedSteward || selfHandoff)} onPress={() => {
        if (!selectedMember || !selectedSteward || selfHandoff) return;
        void commit(
          () => adapter.initiateHandoff(actor, { memberUserId: selectedMember.userId, toStewardId: selectedSteward.userId, note: note.trim() }),
          'Handoff sent for acknowledgement.',
        ).then((saved) => {
          if (!saved) return;
          setMemberId('');
          setStewardId('');
          setNote('');
        });
      }} />
    </Card> : <StateMessage title="Handoff history" body="This role can review handoffs but cannot start one." />}

    <Heading level={3}>Handoff history</Heading>
    <View accessibilityRole="radiogroup" style={styles.choiceRow}>{statuses.map((item, index, choices) => <Pressable key={`handoff-status-${item.id || 'all'}`} accessibilityRole="radio" accessibilityLabel={radioChoiceLabel('Handoff status', item.label, index, choices.length)} accessibilityState={{ selected: status === item.id }} onPress={() => { void filterHistory(item.id); void haptics.select(); }} style={[styles.choice, { backgroundColor: status === item.id ? theme.secondary : theme.card, borderColor: status === item.id ? theme.ring : theme.border }]}><Text style={{ color: status === item.id ? theme.secondaryForeground : theme.cardForeground }}>{item.label}</Text></Pressable>)}</View>
    {history.loadError ? <StateMessage title="Handoff history is temporarily unavailable" body="Other worker-support tools remain available. Try the history filter again." /> : null}
    {!history.loadError && history.items.length === 0 ? <StateMessage title="No handoff history" body="Incoming, outgoing, and overseen handoffs will appear here." /> : history.items.map((item) => <Card key={item.id}>
      <Body muted>{item.fromStewardName} → {item.toStewardName} · {item.direction}</Body>
      <Heading level={3}>{item.memberName}</Heading>
      <Body>{label(item.status)}</Body>
      {item.note ? <Body muted>{item.note}</Body> : null}
      <Body muted>{formatDate(item.createdAt)}</Body>
      {item.canAcknowledge || item.canDecline || item.canCancel ? <View style={styles.actions}>
        {item.canAcknowledge ? <Button label="Acknowledge handoff" disabled={disabled || (busy)} onPress={() => transitionHandoff(item, 'acknowledged')} /> : null}
        {item.canDecline ? <Button label="Decline handoff" variant="secondary" disabled={disabled || (busy)} onPress={() => transitionHandoff(item, 'declined')} /> : null}
        {item.canCancel ? <Button label="Cancel handoff" variant="danger" disabled={disabled || (busy)} onPress={() => transitionHandoff(item, 'cancelled')} /> : null}
      </View> : null}
    </Card>)}
    {history.nextCursor ? <Button label="Load older handoffs" variant="secondary" busy={loadingHistory} disabled={disabled || (busy || loadingHistory)} onPress={() => { void loadOlder(); }} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tab: { minHeight: minimumTouchTarget, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.md },
  tabLabel: { fontSize: 14, lineHeight: 20, ...typeface.controlStrong },
  section: { gap: spacing.md },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  check: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.md },
  marker: { width: 24, fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choice: { minHeight: minimumTouchTarget, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.md },
  goal: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
});
