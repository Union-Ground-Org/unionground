import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import { useBusinessOperation, useBusinessSubjectState } from '../../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../../lib/businessWriteContinuation';
import { useNativeUi } from '../../lib/useNativeUi';
import type { NativeUiText } from '../../lib/nativeUiCopy';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../../lib/useBusinessWriter';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Share, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';

import { buildMemberPickerOptions, type RelationshipMemberNode } from '../../components/optionPickerFilter';
import { Body, Button, Card, Heading, OptionPicker, Screen, StateMessage, StatusPill } from '../../components/ui';
import {
  applyPreviewCollectiveActionJoin,
  buildDigitalActionParticipantCsv,
  composeCollectiveActions,
  composeOrganizationIntelligence,
  DIGITAL_ACTION_PARTICIPATION_KINDS,
  ORGANIZATION_INTELLIGENCE_STAFF_HATS,
  participationKindForAction,
  type OrganizationIntelligenceActor,
} from '../../lib/mi1OrganizationShared';
import {
  loadMobileCollectiveActions,
  loadMobileOrganizationIntelligenceSnapshot,
  requestMobileCollectiveActionExport,
  saveMobileCollectiveAction,
  saveMobileOrganizationChartNode,
  saveMobileOrganizationRelationship,
  saveMobileOrganizationTimelineEvent,
  saveMobileOrganizationTopicProgress,
  toggleMobileCollectiveActionParticipation,
} from '../../services/supabase';
import { useMemberSwitchRead } from '../../services/memberSwitches';
import { NEURO_MAP_SWITCH_KEY } from './neuroMapSwitch';
import { useApp } from '../../state/AppProvider';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { useTheme } from '../../theme/ThemeProvider';
import { mi1Styles as styles } from './mi1Styles';
import { COLLECTIVE_ACTION_GOAL_MAX, collectiveActionGoalSave, parseCollectiveActionGoal } from '../../lib/collectiveActionGoal';
import { nativeConnectionCopy } from '../../lib/connectionSuggestionsShared';
import { ConnectionSuggestionsPanel } from './ConnectionSuggestionsPanel';

type Snapshot = Record<string, unknown>;
type LoadState = 'loading' | 'ready' | 'error';
type CollectiveActionRow = {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  participantCount: number | null;
  targetCount: number;
  strengthPercent: number | null;
  viewerParticipation: string | null;
  viewerCanEdit?: boolean;
  // #9166: false when the join refuses this caller (another chapter's action).
  viewerCanJoin?: boolean;
  chapterId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
};

const previewOrganization = 'preview-organization-intelligence';
// REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112: the organization
// switch for the Neuro Map tab. Default on, and on in the offline preview; the
// server also withholds the relationship graph when it is off.
export { NEURO_MAP_SWITCH_KEY };
function participationLabel(kind: string): string {
  if (kind === 'signature') return 'signatory';
  return kind;
}

const previewSnapshot: Snapshot = {
  organizationId: previewOrganization,
  generatedAt: '2026-08-28T12:00:00Z',
  chartNodes: [
    { id: 'union', chartKind: 'union', nodeKind: 'organization', label: 'Organizing campaign', sortOrder: 0 },
    { id: 'north', chartKind: 'union', nodeKind: 'chapter', parentId: 'union', label: 'North Shore Committee', subtitle: 'Regional organizing committee', sortOrder: 1 },
    { id: 'agency', chartKind: 'agency', nodeKind: 'organization', label: 'Human Services Agency', sortOrder: 0 },
    { id: 'division', chartKind: 'agency', nodeKind: 'division', parentId: 'agency', label: 'Community Programs', sortOrder: 1 },
  ],
  relationshipNodes: [
    { id: 'sam', label: 'Sam Okafor', roleLabel: 'Committee member' },
    { id: 'maya', label: 'Maya Chen', roleLabel: 'Campaign lead' },
    { id: 'luis', label: 'Luis Rivera', roleLabel: 'Worker organizer' },
  ],
  relationships: [
    { id: 'r1', sourceId: 'sam', targetId: 'maya', kind: 'works_with', strength: 4 },
    { id: 'r2', sourceId: 'sam', targetId: 'luis', kind: 'mentors', strength: 3 },
  ],
  topicProgress: [
    { memberId: 'luis', topicKey: 'workplace_mapping', topicLabel: 'Workplace mapping', state: 'developing', progress: 65 },
  ],
  timeline: [
    { id: 't1', kind: 'leadership_term', title: 'Committee leadership term', effectiveOn: '2024-01-01', endedOn: '2025-12-31' },
    { id: 't2', kind: 'payroll_snapshot', title: 'Annual payroll snapshot', effectiveOn: '2025-07-01', amountCents: 18450000, amountBasis: 'Annual aggregate', sourceLabel: 'Organization-provided payroll file', sourceAsOf: '2025-07-01' },
    { id: 't3', kind: 'leadership_term', title: 'New organizing committee seated', effectiveOn: '2026-03-15' },
  ],
};

const previewActions: Snapshot = {
  organizationId: previewOrganization,
  generatedAt: '2026-08-28T12:00:00Z',
  actions: [
    { id: 'a1', kind: 'petition', status: 'published', title: 'Safe staffing commitment', summary: 'Ask coworkers to support the campaign staffing proposal.', targetCount: 250, participantCount: 168, viewerParticipation: null },
    { id: 'a2', kind: 'rally', status: 'published', title: 'Budget hearing turnout', summary: 'Commit to attending the public budget hearing.', targetCount: 120, participantCount: 74, viewerParticipation: 'attendee' },
    { id: 'a3', kind: 'picket', status: 'closed', title: 'Respect the schedule', summary: 'Past action retained with its final aggregate.', targetCount: 90, participantCount: 91, viewerParticipation: null },
  ],
};

type OrganizationTimelineEvent = {
  id: string;
  kind: string;
  title: string;
  effectiveOn: string;
  amountCents?: number | null;
  amountBasis?: string | null;
  sourceLabel?: string | null;
  sourceAsOf?: string | null;
};

function useOrganizationActor(surface: 'intelligence' | 'actions'): { actor: OrganizationIntelligenceActor; mode: string } {
  const { mode, dashboard, previewHat, authorizedRoles, chapterMemberships, organizationID, organizationRoles } = useApp();
  const selected = chapterMemberships.find((entry) => entry.selected) ?? null;
  const roles = organizationRoles;
  const staffHats = (held: readonly string[]) => held.filter((role) => ORGANIZATION_INTELLIGENCE_STAFF_HATS.includes(role));
  // #9166: on collective actions the one hat the person holds or chose,
  // granted for the selected chapter, is worn too (get_collective_actions
  // answers its chapter scope); an organization-wide hat keeps precedence.
  const selectedHat = mode === 'preview' ? previewHat ?? 'member' : explicitLiveStaffHat(staffHats(roles))
    ?? (surface === 'actions' ? explicitLiveStaffHat(staffHats(authorizedRoles)) : null)
    ?? 'member';
  return { mode, actor: {
    userId: mode === 'preview' ? 'preview-member' : dashboard?.member.id ?? null,
    organizationId: mode === 'preview' ? previewOrganization : organizationID,
    chapterId: mode === 'preview' ? 'preview-chapter' : selected?.chapterID ?? dashboard?.member.chapterID ?? null,
    selectedHat,
    organizationRoles: [...roles],
    membershipStatus: 'active',
    // AppProvider exposes authenticated mode only after sessionNeedsMfa has
    // confirmed that the current session satisfies the required AAL.
    mfaSatisfied: mode === 'authenticated' || mode === 'preview',
  } };
}

function Tab({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, { backgroundColor: selected ? theme.primary : theme.secondary }]}><Text style={[styles.chipText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{label}</Text></Pressable>;
}

function Field({ label, value, onChange, keyboardType, multiline = false }: { label: string; value: string; onChange: (value: string) => void; keyboardType?: 'default' | 'numeric'; multiline?: boolean }) {
  const theme = useTheme();
  return <View><Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} keyboardType={keyboardType} multiline={multiline} style={[styles.input, multiline ? styles.multiline : null, { backgroundColor: theme.card, borderColor: theme.border, color: theme.foreground }]} /></View>;
}

function useSnapshot(loader: (() => Promise<Snapshot>) | null) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const [snapshot, setSnapshot] = useBusinessDraftState<Snapshot | null>(null);
  const [state, setState] = useBusinessDraftState<LoadState>('loading');
  const sequence = useRef(0);
  const retry = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++sequence.current;
    if (!loader) { setState('error'); return; }
    setState('loading');
    try { const value = await loader(); if (at === sequence.current && ticket.isCurrent()) { setSnapshot(value); setState('ready'); return true; } }
    catch { if (at === sequence.current && ticket.isCurrent()) { setSnapshot(null); setState('error'); } }
    return false;
  }, [loader, requests, setState, setSnapshot]);
  useEffect(() => { void retry(); return () => { sequence.current += 1; }; }, [retry]);
  return { snapshot, state, retry, setSnapshot };
}

export function OrganizationIntelligenceScreen() {
  const { catalogLabel, t } = useNativeUi();
  const writer = useBusinessWriter();
  const { actor, mode } = useOrganizationActor('intelligence');
  const { memberLanguage, dashboard } = useApp();
  const connectionTr = nativeConnectionCopy((memberLanguage ?? dashboard?.member.language) === 'es' ? 'es' : 'en');
  const loader = useMemo(() => mode === 'preview' ? async () => previewSnapshot : mode === 'authenticated' ? () => loadMobileOrganizationIntelligenceSnapshot(actor.selectedHat) : null, [actor.selectedHat, mode]);
  const { snapshot, state, retry } = useSnapshot(loader);
  const model: any = useMemo(() => composeOrganizationIntelligence({ snapshot: snapshot as any, actor } as any), [actor, snapshot]);
  const chapterNameById = useMemo(() => {
    const names = new Map<string, string>();
    const chartNodes: ReadonlyArray<{ nodeKind?: string; chapterId?: string | null; label: string }> = model?.charts?.nodes ?? [];
    for (const node of chartNodes) {
      if (node.nodeKind === 'chapter' && node.chapterId && !names.has(node.chapterId)) names.set(node.chapterId, node.label);
    }
    return names;
  }, [model]);
  // Role + campaign (chart label, else the snapshot campaign id) plus a stable
  // ordinal when that pair still collides, so two active profiles that share
  // full_name, role, and campaign never render as identical rows.
  const memberOptions = useMemo(() => {
    const relationshipNodes: RelationshipMemberNode[] = model?.relationships?.nodes ?? [];
    return buildMemberPickerOptions(relationshipNodes, chapterNameById);
  }, [model, chapterNameById]);
  const [pickedTab, setTab] = useBusinessDraftState<'charts' | 'relationships' | 'timeline' | 'connections'>('charts');
  const cachedSwitch = useMemberSwitchRead(NEURO_MAP_SWITCH_KEY, true);
  // The snapshot is read on every open, so it wins over the configuration,
  // which is cached per access token and can lag a change to the switch.
  // Signed in, neither the tab nor the subtitle names the Neuro Map until a
  // read says it is on, so nothing shows it while it is held for its release
  // day (BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113).
  const snapshotSwitch = snapshot?.neuroMapEnabled;
  const neuroMap = typeof snapshotSwitch === 'boolean' ? snapshotSwitch : mode === 'preview' || cachedSwitch === true;
  const tab = !neuroMap && pickedTab === 'relationships' ? 'charts' : pickedTab;
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [needsRefresh, setNeedsRefresh] = useBusinessSubjectState(JSON.stringify([actor.organizationId, actor.chapterId]), false);
  const [notice, setNotice] = useBusinessDraftState('');
  const [label, setLabel] = useBusinessDraftState('');
  const [pickedSource, setSource] = useBusinessDraftState('');
  const [pickedTarget, setTarget] = useBusinessDraftState('');
  const [topic, setTopic] = useBusinessDraftState('');
  const [timelineTitle, setTimelineTitle] = useBusinessDraftState('');
  // A refresh can drop a picked worker (for example, deactivated in another
  // session). The pickers, save guards, and payloads read only picks still on
  // the roster, in the same render that drops the worker, so no commit shows an
  // enabled save for a stale id; the effect then clears the stale pick so it
  // cannot come back if that worker returns in a later refresh.
  const memberIds = useMemo(() => new Set(memberOptions.map((option) => option.id)), [memberOptions]);
  const source = memberIds.has(pickedSource) ? pickedSource : '';
  const target = memberIds.has(pickedTarget) ? pickedTarget : '';
  useEffect(() => {
    if (pickedSource && !memberIds.has(pickedSource)) setSource('');
    if (pickedTarget && !memberIds.has(pickedTarget)) setTarget('');
  }, [memberIds, pickedSource, pickedTarget, setSource, setTarget]);
  const canWrite = mode === 'authenticated' && model?.writeAllowed === true && !needsRefresh;
  // StatusPill has no live region, so each save outcome is spoken with the
  // same text the pill shows. Every save clears the notice first, so a repeated
  // identical outcome is spoken again.
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`organization-map:${actor.userId ?? ''}:${actor.organizationId ?? ''}:${actor.selectedHat}`);
  useEffect(() => {
    if (notice) return queueAnnouncement(notice);
    return undefined;
  }, [notice, queueAnnouncement]);
  const requests = useBusinessRequests(writer);
  const mutate = useCallback(async (operation: () => Promise<void>) => {
    await operate(true, async () => {
      if (needsRefresh) return;
      const current = requests.capture().isCurrent;
      setNotice('');
      try {
        await operation(); setNeedsRefresh(true); setNotice('Saved.');
        await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setNotice(BUSINESS_SAVED_STALE),
          refresh: async () => { const fresh = await retry(); if (fresh && current()) setNeedsRefresh(false); return fresh; } });
      } catch { setNotice('The change could not be saved.'); }
    });
  }, [needsRefresh, operate, retry, setNotice, setNeedsRefresh, writer, requests]);
  async function refreshView() {
    await operate(true, async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current' && await retry() && current()) {
        setNeedsRefresh(false); setNotice('');
      }
    });
  }

  return <Screen>
    <Heading>{catalogLabel('Power map')}</Heading><Body muted>{neuroMap ? 'Agency and organization charts, relationship strength, topic readiness, and sourced leadership history.' : 'Agency and organization charts and sourced leadership history.'}</Body>
    {needsRefresh ? <Button label="Refresh" disabled={busy} variant="secondary" onPress={() => void refreshView()} /> : null}
    {needsRefresh && !notice ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
    {mode === 'preview' ? <StatusPill label="Preview" /> : null}
    <View accessibilityRole="tablist" style={styles.wrap}><Tab label="Charts" selected={tab === 'charts'} onPress={() => setTab('charts')} />{neuroMap ? <Tab label="Neuro Map" selected={tab === 'relationships'} onPress={() => setTab('relationships')} /> : null}<Tab label="Timeline" selected={tab === 'timeline'} onPress={() => setTab('timeline')} /><Tab label={connectionTr('connectionsTab')} selected={tab === 'connections'} onPress={() => setTab('connections')} /></View>
    {tab === 'connections' ? <ConnectionSuggestionsPanel /> : null}
    {tab !== 'connections' && state === 'loading' ? <StateMessage title="Loading power map" body="Checking current organization access." /> : null}
    {tab !== 'connections' && state === 'error' ? <StateMessage title="Power map unavailable" body="No earlier organization data is shown." action={<Button label="Try again" variant="secondary" onPress={retry} />} /> : null}
    {tab !== 'connections' && state === 'ready' && model.state !== 'ready' ? <StateMessage title="Power map restricted" body="Choose an authorized organization staff role to continue." /> : null}
    {tab !== 'connections' && model.state === 'ready' ? <>
      {notice ? <StatusPill label={notice} /> : null}
      {tab === 'charts' ? <>{(['agency', 'union'] as readonly ['agency', 'union']).map((kind) => <Card key={kind}><Heading level={3}>{kind === 'agency' ? 'Agency chart' : 'Campaign chart'}</Heading>{model.charts.nodes.filter((node: any) => node.chartKind === kind).map((node: any) => <Body key={node.id}>{`${node.parentId ? '↳ ' : ''}${node.label} · ${String(node.nodeKind).replaceAll('_', ' ')}`}</Body>)}{model.charts.nodes.filter((node: any) => node.chartKind === kind).length === 0 ? <Body muted>No nodes yet.</Body> : null}</Card>)}</> : null}
      {tab === 'relationships' ? <><Card><Heading level={3}>Relationships</Heading><Body muted>Neuro Map lists working relationships between workers, each with a strength out of 5, and each worker's topic progress.</Body>{model.relationships.edges.map((edge: any) => <Body key={edge.id}>{`${model.relationships.nodes.find((node: any) => node.id === edge.source)?.label ?? 'Worker'} → ${model.relationships.nodes.find((node: any) => node.id === edge.target)?.label ?? 'Worker'} · ${String(edge.kind).replaceAll('_', ' ')} · ${edge.strength}/5`}</Body>)}{model.relationships.topics.map((entry: any) => <Body key={`${entry.memberId}-${entry.topicKey}`}>{`${entry.topicLabel} · ${entry.progress}% · ${entry.state}`}</Body>)}</Card></> : null}
      {tab === 'timeline' ? model.timeline.map((event: OrganizationTimelineEvent) => <Card key={event.id}><Body muted>{event.effectiveOn}</Body><Heading level={3}>{event.title}</Heading><Body>{String(event.kind).replaceAll('_', ' ')}</Body>{event.amountCents != null ? <Body>{`${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(event.amountCents / 100)} · ${event.amountBasis}`}</Body> : null}{event.sourceLabel ? <Body muted>{`${event.sourceLabel} · ${event.sourceAsOf}`}</Body> : null}</Card>) : null}
      {canWrite && tab === 'charts' ? <Card><Heading level={3}>Add top-level chart node</Heading><Field label="Label" value={label} onChange={setLabel} /><Button label="Save agency node" busy={busy} disabled={!label.trim()} onPress={() => void mutate(async () => { await saveMobileOrganizationChartNode(writer, actor.selectedHat, { p_id: null, p_chart_kind: 'agency', p_node_kind: 'organization', p_parent_id: null, p_chapter_id: null, p_label: label, p_subtitle: null, p_position_x: 0, p_position_y: 0, p_sort_order: model.charts.nodes.length }); setLabel(''); })} /></Card> : null}
      {canWrite && tab === 'relationships' ? <Card><Heading level={3}>Add relationship or topic</Heading>{memberOptions.length > 0 ? <><OptionPicker label="Source worker" value={source} options={memberOptions} onChange={setSource} /><OptionPicker label="Target worker" value={target} options={memberOptions} onChange={setTarget} /><Button label="Save working relationship" busy={busy} disabled={!source || !target || source === target} onPress={() => void mutate(async () => { await saveMobileOrganizationRelationship(writer, actor.selectedHat, { p_id: null, p_source_user_id: source, p_target_user_id: target, p_relationship_kind: 'works_with', p_strength: 3 }); setSource(''); setTarget(''); })} /><Field label="Topic label" value={topic} onChange={setTopic} /><Button label="Save topic progress" busy={busy} disabled={!source || !topic} onPress={() => void mutate(async () => { await saveMobileOrganizationTopicProgress(writer, actor.selectedHat, { p_member_user_id: source, p_topic_key: topic.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80), p_topic_label: topic, p_progress_state: 'introduced', p_progress: 0 }); setTopic(''); })} /></> : <Body muted>Workers appear here once they are on the map. Until then, add relationships and topics from the web editor, which is the supported path.</Body>}</Card> : null}
      {canWrite && tab === 'timeline' ? <Card><Heading level={3}>Add leadership meeting</Heading><Field label="Title" value={timelineTitle} onChange={setTimelineTitle} /><Button label="Save leadership meeting" busy={busy} disabled={!timelineTitle.trim()} onPress={() => void mutate(async () => { await saveMobileOrganizationTimelineEvent(writer, actor.selectedHat, { p_id: null, p_chapter_id: null, p_event_kind: 'leadership_term', p_title: timelineTitle, p_detail: null, p_effective_on: new Date().toISOString().slice(0, 10), p_ended_on: null, p_amount_cents: null, p_amount_basis: null, p_source_label: null, p_source_as_of: null }); setTimelineTitle(''); })} /></Card> : null}
      {!canWrite ? <Body muted>{mode === 'preview' ? 'Preview shows the complete backed shape. Changes require a signed-in organization session.' : 'Advisor, admin, or campaign chair access with two-step sign-in is required to edit.'}</Body> : null}
    </> : null}
  </Screen>;
}

// Audit MOB-COORDINATOR-11, MOB-ADVISOR-11: who can see that a member joined.
// request_digital_action_participant_export admits only the coordinator, admin
// and vp (president) hats of the organization, after two-step sign-in.
const ACTION_PARTICIPATION_READERS = 'Your organization’s campaign leads, admins and campaign chair can export the list of who joined an action.';

// Withdrawing changes the member's recorded participation, so it confirms
// first (audit MOB-STEWARD-11, MOB-ADMIN-13). Joining stays one tap.
// #9502: the dialog speaks the member's language, as the screen does.
function confirmWithdraw(t: NativeUiText, withdrawing: boolean, run: () => void) {
  if (!withdrawing) { run(); return; }
  Alert.alert(t('Withdraw from this action?'), t('You will no longer be counted as joined. You can join again while the action is published.'), [
    { text: t('Stay joined'), style: 'cancel' },
    { text: t('Withdraw'), style: 'destructive', onPress: run },
  ]);
}

// #9166: the chapter a chapter-scoped manager writes for, as the server named
// it (the shared model's manageScope "chapter" and manageChapterId); null for
// everyone else, so an organization-wide officer still saves for the whole
// organization.
function chapterScopeOf(model: { manageScope?: unknown; manageChapterId?: unknown } | null | undefined): string | null {
  return model?.manageScope === 'chapter' && typeof model.manageChapterId === 'string' ? model.manageChapterId : null;
}

// The shortest title or summary Publish action accepts.
const COLLECTIVE_ACTION_TEXT_MIN = 3;

export function CollectiveActionsScreen() {
  const { catalogLabel, t } = useNativeUi();
  const writer = useBusinessWriter();
  const { actor, mode } = useOrganizationActor('actions');
  const requests = useBusinessRequests(writer);
  const [previewValue, setPreviewValue] = useState(previewActions);
  // #9166: the server scopes the list and the form to the selected chapter, so
  // a chapter switch under the same hat reads the list again.
  const loader = useMemo(() => mode === 'preview' ? async () => previewValue : mode === 'authenticated' ? () => loadMobileCollectiveActions(actor.selectedHat) : null, [actor.selectedHat, actor.chapterId, mode, previewValue]);
  const { snapshot, state, retry, setSnapshot } = useSnapshot(loader);
  const model: any = useMemo(() => composeCollectiveActions({ snapshot: snapshot as any, actor } as any), [actor, snapshot]);
  const [busy, setBusy] = useBusinessState('');
  const [operate] = useBusinessOperation<typeof busy>(setBusy, '');
  const [title, setTitle] = useBusinessDraftState('');
  const [summary, setSummary] = useBusinessDraftState('');
  // #8220: the goal is asked for, never a silent 100, and an editor can correct it.
  const [goal, setGoal] = useBusinessDraftState('');
  const [goalEdit, setGoalEdit] = useBusinessDraftState<{ id: string; value: string } | null>(null);
  const [notice, setNotice] = useBusinessDraftState('');
  const manage = mode === 'authenticated' && model?.manageAllowed === true;
  const chapterScope = chapterScopeOf(model);
  const newGoal = parseCollectiveActionGoal(goal);
  // #9918 (carved from #9468, M2-19): what holds Publish action or Save goal,
  // said beside the button. The goal takes digits only, so the limit is
  // written without a thousands separator.
  const goalRule = t('Enter the goal in digits only: a whole number from 1 to {max}, with no commas or words.', { max: COLLECTIVE_ACTION_GOAL_MAX });
  const createReason = title.trim().length < COLLECTIVE_ACTION_TEXT_MIN ? t('Use at least {count} characters for the title.', { count: COLLECTIVE_ACTION_TEXT_MIN })
    : summary.trim().length < COLLECTIVE_ACTION_TEXT_MIN ? t('Use at least {count} characters for the summary.', { count: COLLECTIVE_ACTION_TEXT_MIN }) : goalRule;
  // Join/withdraw, publish, export, and load-more failures render only in a
  // StatusPill; speak the same sentence. Each run clears the notice first.
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`digital-picket-line:${actor.userId ?? ''}:${actor.organizationId ?? ''}:${actor.selectedHat}`);
  useEffect(() => {
    if (notice) return queueAnnouncement(notice);
    return undefined;
  }, [notice, queueAnnouncement]);
  const [acceptedActions, setAcceptedActions] = useBusinessState(() => new Set<string>());
  const run = async (key: string, operation: (current: () => boolean) => Promise<void>, reload = true) => {
    await operate(key, async () => { const current = requests.capture().isCurrent; if (reload && acceptedActions.has(key)) return; setNotice(''); try { await operation(current); if (reload) { setAcceptedActions(previous => new Set(previous).add(key)); setNotice(t('The change was saved.')); } const proof = await checkBusinessContinuation(writer, current); if (proof === 'changed') return; if (reload && proof === 'current' && await retry()) setAcceptedActions(previous => new Set([...previous].filter(value => value !== key))); if (reload && proof === 'unavailable') setNotice(t('The change was saved, but the view could not refresh. Pull to refresh.')); } catch { if (current()) setNotice(t('The action could not be completed.')); }
    });
  };
  return <Screen>
    <Heading>{catalogLabel('Digital Picket Line')}</Heading>{mode === 'preview' ? <StatusPill label="Preview" /> : null}
    <Button label={t('Refresh')} variant="secondary" disabled={busy !== ''} onPress={() => void operate('refresh', async () => { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current' && await retry()) setAcceptedActions(new Set()); })} /><Body muted>{t('Join petitions, rallies, pickets, meetings, and volunteer actions in your organization.')}</Body><Body muted>{t(ACTION_PARTICIPATION_READERS)}</Body>
    {state === 'loading' ? <StateMessage title={t('Loading collective actions')} body={t('Checking current organization access.')} /> : null}
    {state === 'error' ? <StateMessage title={t('Collective actions unavailable')} body={t('No earlier action data is shown.')} action={<Button label={t('Try again')} variant="secondary" onPress={retry} />} /> : null}
    {notice ? <StatusPill label={notice} /> : null}
    {model.state === 'ready' && model.actions.length === 0 ? <StateMessage title={t('No active actions')} body={t('Published actions will appear here.')} /> : null}
    {model.state === 'ready' ? model.actions.map((action: CollectiveActionRow) => <Card key={action.id} hero={action.status === 'published'}><View style={styles.row}><StatusPill label={action.kind} /><StatusPill label={action.status} /></View><Heading level={2}>{action.title}</Heading><Body>{action.summary}</Body><Body muted>{`${action.participantCount === null ? t('Participation withheld') : t('{count} joined', { count: action.participantCount })} · ${t('{count} goal', { count: action.targetCount })}`}</Body><Body>{action.strengthPercent === null ? t('Progress withheld') : action.participantCount !== null && action.targetCount > 0 && action.participantCount >= action.targetCount ? t('Goal reached') : t('{percent}% of goal', { percent: action.strengthPercent })}</Body>{action.viewerParticipation ? <Body>{t('You joined as {kind}.', { kind: catalogLabel(action.viewerParticipation) })}</Body> : null}{manage && action.viewerCanEdit ? (goalEdit?.id === action.id
      ? <View><Field label={t('Participation goal')} keyboardType="numeric" value={goalEdit.value} onChange={(value) => setGoalEdit({ id: action.id, value })} /><View style={styles.wrap}><Button label={t('Save goal')} busy={busy === `goal-${action.id}`} disabled={busy !== '' || acceptedActions.has(`goal-${action.id}`) || parseCollectiveActionGoal(goalEdit.value) === null} disabledReason={busy === '' && !acceptedActions.has(`goal-${action.id}`) ? goalRule : undefined} onPress={() => void run(`goal-${action.id}`, async () => { await saveMobileCollectiveAction(writer, actor.selectedHat, collectiveActionGoalSave({ id: action.id, chapterId: action.chapterId ?? null, kind: action.kind, title: action.title, summary: action.summary, status: action.status, startsAt: action.startsAt ?? null, endsAt: action.endsAt ?? null }, parseCollectiveActionGoal(goalEdit.value) as number)); setGoalEdit(null); })} /><Button label={t('Cancel')} variant="secondary" onPress={() => setGoalEdit(null)} /></View></View>
      : <Button label={t('Change goal')} disabled={busy !== '' || acceptedActions.has(`goal-${action.id}`)} variant="secondary" onPress={() => setGoalEdit({ id: action.id, value: String(action.targetCount) })} />) : null}{action.status === 'published' && !action.viewerParticipation && action.viewerCanJoin === false ? <Body muted>{t("Only workers of this action's campaign can join it.")}</Body> : null}{action.status === 'published' && (action.viewerParticipation || action.viewerCanJoin !== false) ? <Button label={action.viewerParticipation ? t('Withdraw') : t('Join action')} busy={busy === action.id} disabled={busy !== '' || acceptedActions.has(action.id)} onPress={() => confirmWithdraw(t, Boolean(action.viewerParticipation), () => void run(action.id, async () => { if (mode === 'preview') { setPreviewValue((current) => ({ ...current, actions: applyPreviewCollectiveActionJoin(current.actions as any[], action.id) })); return; } await toggleMobileCollectiveActionParticipation(writer, { actionId: action.id, participationKind: action.viewerParticipation ?? participationKindForAction(action.kind), joined: !action.viewerParticipation }); }))} /> : null}{model.exportAllowed && mode === 'authenticated' ? <View style={styles.wrap}>{DIGITAL_ACTION_PARTICIPATION_KINDS.map((kind) => <Button key={kind} label={`Share protected ${participationLabel(kind)} CSV`} variant="secondary" busy={busy === `export-${action.id}-${kind}`} onPress={() => void run(`export-${action.id}-${kind}`, async (current) => { const payload = await requestMobileCollectiveActionExport(writer, actor.selectedHat, action.id, kind); if (!(await writer.isCurrent()) || !current()) return; if (await writer.isCurrent() && current()) await Share.share({ title: `${action.title} ${participationLabel(kind)} list`, message: buildDigitalActionParticipantCsv(payload as any) }); })} disabled={Boolean(busy)} />)}</View> : null}</Card>) : null}
    {model.state === 'ready' && model.hasMore && mode === 'authenticated' ? <Button label={t('Load more actions')} variant="secondary" busy={busy === 'load-more'} onPress={() => void run('load-more', async () => {
      const next = await loadMobileCollectiveActions(actor.selectedHat, 25, model.nextOffset);
      setSnapshot((current) => ({ ...next, actions: [...((current?.actions as any[]) ?? []), ...((next.actions as any[]) ?? [])] }));
    }, false)} disabled={Boolean(busy)} /> : null}
    {manage ? <Card><Heading level={2}>{t('Create action')}</Heading>{chapterScope ? <Body muted>{t('Actions you create here are for your campaign.')}</Body> : null}<Field label={t('Title')} value={title} onChange={setTitle} /><Field label={t('Summary')} value={summary} onChange={setSummary} multiline /><Field label={t('Participation goal (people)')} keyboardType="numeric" value={goal} onChange={setGoal} /><Button label={t('Publish action')} busy={busy === 'create'} disabled={title.trim().length < COLLECTIVE_ACTION_TEXT_MIN || summary.trim().length < COLLECTIVE_ACTION_TEXT_MIN || newGoal === null} disabledReason={busy === '' ? createReason : undefined} onPress={() => void run('create', async () => { await saveMobileCollectiveAction(writer, actor.selectedHat, { p_id: null, p_chapter_id: chapterScope, p_action_kind: 'petition', p_title: title, p_summary: summary, p_status: 'published', p_target_count: newGoal, p_starts_at: null, p_ends_at: null }); setTitle(''); setSummary(''); setGoal(''); })} /></Card> : null}
  </Screen>;
}
