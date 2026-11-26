import { useBusinessOperation } from '../../lib/useBusinessWriter';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { Body, Button, Card, Heading, StateMessage, StatusPill } from '../../components/ui';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import {
  CONNECTION_PRESETS, CONNECTION_WEIGHT_KEYS, canReadConnections, connectionDraft, connectionScopeKey, connectionHandshakeOutcome,
  createConnectionPreview, initialConnectionSettings, nativeConnectionCopy, normalizeConnectionProfile, organizationConnectionWeights, rankNativeConnections,
  type ConnectionActor, type ConnectionData, type ConnectionDraft, type ConnectionMatch, type ConnectionSettings,
  type ConnectionWeights,
} from '../../lib/connectionSuggestionsShared';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { connectionFailureState, createMobileConnectionAdapter, normalizeConnectionWorkspace } from '../../services/chapterConnections';
import { getSupabaseClient } from '../../services/supabase';
import { useRequestGeneration } from '../../lib/useRequestGeneration';
import { useBusinessWriter } from '../../lib/useBusinessWriter';
import { useApp } from '../../state/AppProvider';
import { ConnectionChoices, ConnectionDial, connectionStyles, type ConnectionTranslator } from './ConnectionControls';
import { ConnectionProfileEditor } from './ConnectionProfileEditor';
import { ConnectionSourceReview, type ConfirmedConnectionReview } from './ConnectionSourceReview';
import { ConnectionHandshakeRequest, type ConnectionHandshakeDraft, type ConnectionHandshakeSubmission } from './ConnectionHandshakeRequest';

const staffHats = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];

type ConnectionPanelProps = { onHandshakeRequested?: (submission: ConnectionHandshakeSubmission) => void };

export function ConnectionSuggestionsPanel({ onHandshakeRequested }: ConnectionPanelProps = {}) {
  const app = useApp();
  const preview = app.mode === 'preview';
  const roles = preview ? [app.previewHat || 'member'] : [...new Set([...app.organizationRoles, ...app.chapterRoles])];
  const actor: ConnectionActor = {
    userId: preview ? 'preview-member' : app.dashboard?.member.id ?? null,
    organizationId: preview ? 'preview-connections' : app.organizationID,
    chapterId: preview ? 'preview-river' : app.chapterMemberships.find((entry) => entry.selected)?.chapterID ?? app.dashboard?.member.chapterID ?? null,
    selectedHat: preview ? app.previewHat || 'member' : explicitLiveStaffHat(roles) || 'member',
    organizationRoles: preview ? roles : app.organizationRoles,
    chapterRoles: preview ? [] : app.chapterRoles,
    membershipStatus: app.mode === 'authenticated' || preview ? 'active' : 'inactive',
    mfaSatisfied: preview || (app.mode === 'authenticated' && !app.locked && !app.assuranceUnavailable),
  };
  const language = (app.memberLanguage ?? app.dashboard?.member.language) === 'es' ? 'es' : 'en';
  // Keyed remount clears profiles, local text, preferences and pending outcomes
  // before a new organization/chapter/role/session is rendered.
  return <ConnectionRoleScope key={connectionScopeKey(actor, app.mode)} actor={actor} mode={app.mode} language={language} onHandshakeRequested={onHandshakeRequested} />;
}

function ConnectionRoleScope({ actor, mode, language, onHandshakeRequested }: ConnectionPanelProps & { actor: ConnectionActor; mode: string; language: 'en' | 'es' }) {
  const [selectedHat, setSelectedHat] = useState(actor.selectedHat);
  const roles = [...new Set([...actor.organizationRoles, ...actor.chapterRoles])].filter((role) => staffHats.includes(role));
  const tr = nativeConnectionCopy(language);
  const scoped = { ...actor, selectedHat };
  return <View style={connectionStyles.section}>
    {roles.length > 1 && <ConnectionChoices label={tr('staffRole')} value={selectedHat}
      options={roles.map((key) => ({ key, label: tr(key) }))} onChange={setSelectedHat} />}
    <ConnectionSession key={connectionScopeKey(scoped, mode)} actor={scoped} mode={mode} tr={tr} onHandshakeRequested={onHandshakeRequested} />
  </View>;
}

function previewData(): ConnectionData {
  const sample = createConnectionPreview();
  return {
    workspace: normalizeConnectionWorkspace({ ...sample.workspace, canRequestHandshake: true, draft: connectionDraft(sample.workspace.profile), hiddenChapterIds: [],
      analysis: { nextPeriodKey: null, nextPeriodFrozen: false } }),
    profiles: sample.profiles.flatMap((row) => { const profile = normalizeConnectionProfile(row); return profile ? [profile] : []; }),
  };
}

type State = 'loading' | 'ready' | 'error' | 'unauthorized' | 'unavailable';
export function ConnectionSession({ actor, mode, tr, onHandshakeRequested }: ConnectionPanelProps & { actor: ConnectionActor; mode: string; tr: ConnectionTranslator }) {
  const router = useRouter();
  const preview = mode === 'preview';
  const allowed = (preview || mode === 'authenticated') && canReadConnections(actor);
  const [data, setData] = useState<ConnectionData | null>(null);
  const [state, setState] = useState<State>(allowed ? 'loading' : 'unauthorized');
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState(initialConnectionSettings);
  // Inventory B13: start from the organization's default weights (the
  // member-safe switches map) unless the person already moved a slider.
  const weightsTouched = useRef(false);
  useEffect(() => {
    if (preview || !allowed) return undefined;
    const client = getSupabaseClient();
    if (!client) return undefined;
    let live = true;
    const readDefaults = async (): Promise<void> => {
      const response: { data: unknown; error: unknown } = await client.rpc('get_member_organization_configuration');
      const weights: ConnectionWeights | null = response.error ? null : organizationConnectionWeights(response.data);
      if (live && weights && !weightsTouched.current) setSettings((current) => ({ ...current, weights }));
    };
    readDefaults().catch((): void => undefined);
    return () => { live = false; };
  }, [allowed, preview, actor.userId, actor.organizationId, actor.chapterId, actor.selectedHat]);
  const [resultLimit, setResultLimit] = useState(12);
  const [tuning, setTuning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState('');
  const [operate] = useBusinessOperation<typeof busy>(setBusy, '');
  const [notice, setNotice] = useState('');
  const [requestTarget, setRequestTarget] = useState<ConnectionMatch | null>(null);

  const scope = connectionScopeKey(actor, mode);
  const writer = useBusinessWriter();
  const requests = useRequestGeneration(scope);
  const reloadControllers = useRef(new Set<AbortController>());
  useEffect(() => () => {
    for (const controller of reloadControllers.current) controller.abort();
    reloadControllers.current.clear();
  }, [requests]);
  const adapter = useMemo(() => createMobileConnectionAdapter(writer, preview ? null : getSupabaseClient(), actor), [preview, scope, writer]); // actor is completely represented in scope.
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`chapter-connections:${scope}`);
  useEffect(() => notice ? queueAnnouncement(notice) : undefined, [notice, queueAnnouncement]);
  useEffect(() => {
    weightsTouched.current = false;
    setRequestTarget(null); setEditing(false); setReviewing(false);
    setSettings(initialConnectionSettings);
  }, [requests]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setNotice('');
    if (!allowed) { setState('unauthorized'); return () => controller.abort(); }
    if (preview) { setData(previewData()); setState('ready'); return () => controller.abort(); }
    setState('loading');
    void adapter.load(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setData(value); setState('ready'); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { setData(null); setState(connectionFailureState(error)); }
    });
    return () => controller.abort();
  }, [adapter, allowed, attempt, preview]);
  const ranking = useMemo(() => data ? rankNativeConnections(data, settings, Date.now(), Math.min(100, resultLimit + 1)) : null, [data, settings, resultLimit]);
  const updateSetting = <K extends keyof ConnectionSettings>(key: K, value: ConnectionSettings[K]) => {
    if (key === 'weights') weightsTouched.current = true;
    setSettings((current) => ({ ...current, [key]: value })); setResultLimit(12);
  };
  const run = async (key: string, operation: (current: () => boolean) => Promise<void>, success: string, failure: string, refresh = true) => {
    await operate(key, async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent() || !data?.workspace.canPublish || !allowed) return;
    const controller = new AbortController();
    reloadControllers.current.add(controller);
    const signal = controller.signal;
     setNotice('');
    try {
      await operation(ticket.isCurrent);
      setNotice(tr(success));
      if (!ticket.isCurrent()) return;
      if (!preview && refresh) {
        // Successful writes invalidate all previous results immediately. A failed
        // reload never leaves an outdated publication visible as current.
        setData(null); setState('loading');
        const proof = await writer.check();
        if (!ticket.isCurrent() || proof === 'changed') return;
        if (proof === 'unavailable') {
          setState('unavailable'); setNotice(tr('refreshAfterWriteError')); return;
        }
        try { const fresh = await adapter.load(signal); if (ticket.isCurrent()) { setData(fresh); setState('ready'); } }
        catch (error: unknown) {
          if (ticket.isCurrent()) { setData(null); setState(connectionFailureState(error)); setNotice(tr('refreshAfterWriteError')); }
          return;
        }
      }
      if (ticket.isCurrent()) setNotice(tr(success));
    } catch { if (ticket.isCurrent()) setNotice(tr(failure)); }
    finally { controller.abort(); reloadControllers.current.delete(controller); }

    });
  };
  const publish = (draft: ConnectionDraft) => void run('publish', async () => {
    if (!data?.workspace.chapterId) return;
    if (!preview) { await adapter.save(data.workspace.chapterId, draft); return; }
    const profile = normalizeConnectionProfile({ ...draft, id: data.workspace.chapterId, discoverable: true,
      displayName: data.workspace.chapterName, issuePriorities: draft.declaredIssueKeys.map((key) => ({ key, strength: 1 })),
      assistanceNeeds: draft.declaredIssueKeys.map((key) => ({ key, strength: 1 })),
      localKey: data.workspace.profile?.localKey, unionFamilyKey: data.workspace.profile?.unionFamilyKey, publishedAt: new Date().toISOString() });
    setData({ ...data, workspace: { ...data.workspace, draft, profile } });
  }, 'saved', 'saveError');
  const withdraw = () => void run('withdraw', async () => {
    if (!data?.workspace.chapterId) return;
    if (!preview) await adapter.withdraw(data.workspace.chapterId);
    else setData({ ...data, workspace: { ...data.workspace, profile: null } });
  }, 'withdrawn', 'saveError');
  const review = (value: ConfirmedConnectionReview, cleared: () => void) => void run('review', async (current) => {
    if (!data?.workspace.chapterId) return;
    if (!preview) await adapter.reviewSource(data.workspace.chapterId, value.sourceKind, value.sourceId, value.topicKeys);
    if (current()) cleared();
  }, preview ? 'reviewPreviewSaved' : 'reviewSaved', 'reviewError', false);
  const freeze = () => void run('freeze', async () => {
    if (!data?.workspace.chapterId) return;
    if (!preview) await adapter.freezeIssues(data.workspace.chapterId);
    else setData({ ...data, workspace: { ...data.workspace, analysis: { ...data.workspace.analysis, nextPeriodFrozen: true } } });
  }, preview ? 'freezePreview' : 'freezeSaved', 'freezeError');
  const hide = (targetId: string) => void run('hide', async () => {
    if (!data?.workspace.chapterId) return;
    if (!preview) await adapter.hide(data.workspace.chapterId, targetId, true);
    else setData({ ...data, workspace: { ...data.workspace, hiddenChapterIds: [...data.workspace.hiddenChapterIds, targetId] } });
  }, 'hidden', 'hideError');
  const restore = () => void run('restore', async (current) => {
    if (!data?.workspace.chapterId) return;
    if (preview) { setData({ ...data, workspace: { ...data.workspace, hiddenChapterIds: [] } }); return; }
    // Retain the still-hidden IDs if only part of this sequence succeeds.
    for (const id of data.workspace.hiddenChapterIds) {
      if (!current()) return;
      await adapter.hide(data.workspace.chapterId, id, false);
      if (!current()) return;
      setData((current) => current ? { ...current, workspace: { ...current.workspace,
        hiddenChapterIds: current.workspace.hiddenChapterIds.filter((entry) => entry !== id) } } : current);
    }
  }, 'unhidden', 'unhideError');
  const requestHandshake = async (fields: ConnectionHandshakeDraft) => {
    const ticket = requests.capture();
    if (!ticket.isCurrent() || !allowed || !requestTarget || !data?.workspace.chapterId || !data.workspace.canRequestHandshake
      || (!preview && requestTarget.handshake?.eligible !== true)) throw new Error('handshake_not_authorized');
    const receipt = preview ? null : await adapter.requestHandshake(data.workspace.chapterId, requestTarget.id, fields);
    if (!ticket.isCurrent()) return;
    const outcome = connectionHandshakeOutcome(receipt);
    const noticeKey = preview ? 'handshakePreviewSent' : outcome === 'declined' ? 'handshakeDeclined' : outcome === 'closed' ? 'handshakeClosed' : 'handshakeSent';
    setNotice(tr(noticeKey));
    onHandshakeRequested?.({ target: requestTarget, fields, noticeKey });
  };

  return <View style={connectionStyles.section}>
    <Heading level={2}>{tr('title')}</Heading><Body>{tr('intro')}</Body>
    {preview && <StatusPill label={tr('preview')} />}
    {notice && <StatusPill label={notice} />}
    {!onHandshakeRequested && <Button label={tr('openHandshakes')} variant="secondary" onPress={() => router.push('/feature/partners' as never)} />}
    {requestTarget && <ConnectionHandshakeRequest key={requestTarget.id} target={requestTarget} preview={preview} tr={tr}
      onSubmit={requestHandshake} onClose={() => setRequestTarget(null)} />}
    {state !== 'ready' && <StateMessage title={tr(state)} body={state === 'loading' ? tr('protected') : ''}
      action={state === 'error' || state === 'unavailable' ? <Button label={tr('retry')} variant="secondary" onPress={() => setAttempt((value) => value + 1)} /> : undefined} />}
    {state === 'ready' && data && <>
      {data.workspace.chapterName && <Body muted>{`${tr('ownChapter')}: ${data.workspace.chapterName}`}</Body>}
      {!data.workspace.chapterId ? <Body>{tr('noChapter')}</Body> : <>
        <Card><Button label={tuning ? `${tr('collapse')}: ${tr('tuning')}` : tr('tuneOpen')} variant="secondary" selected={tuning} onPress={() => setTuning(!tuning)} />
          {tuning && <View style={connectionStyles.section}>
            <Body muted>{tr('preferences')}</Body>
            <ConnectionChoices label={tr('tuning')} value={Object.entries(CONNECTION_PRESETS).find(([, weights]) => CONNECTION_WEIGHT_KEYS.every((key) => settings.weights[key as keyof ConnectionWeights] === weights[key as keyof ConnectionWeights]))?.[0] ?? ''}
              options={Object.keys(CONNECTION_PRESETS).map((key) => ({ key, label: tr(key) }))}
              onChange={(key) => { const weights = CONNECTION_PRESETS[key]; if (weights) updateSetting('weights', { ...weights }); }} />
            {CONNECTION_WEIGHT_KEYS.map((key) => <ConnectionDial key={key} label={tr(key)} help={tr(`${key}Help`)} value={settings.weights[key as keyof ConnectionWeights]}
              onChange={(value) => updateSetting('weights', { ...settings.weights, [key]: value })} tr={tr} />)}
            <ConnectionChoices label={tr('reach')} value={settings.reach} options={['anywhere', 'same-country', 'same-state'].map((key) => ({ key, label: tr(key) }))}
              onChange={(value) => updateSetting('reach', value as ConnectionSettings['reach'])} />
            <ConnectionChoices label={tr('scale')} value={settings.locationScale} options={['metro', 'state', 'country'].map((key) => ({ key, label: tr(key) }))}
              onChange={(value) => updateSetting('locationScale', value as ConnectionSettings['locationScale'])} />
            <ConnectionChoices label={tr('freshness')} value={String(settings.freshnessDays ?? 'all')}
              options={['all', '30', '90', '180'].map((key) => ({ key, label: tr(key === 'all' ? 'allAges' : `days${key}`) }))}
              onChange={(value) => updateSetting('freshnessDays', value === 'all' ? null : Number(value))} />
            <ConnectionDial label={tr('variety')} help={tr('varietyHelp')} value={Math.round(settings.diversity * 1000)} tr={tr}
              onChange={(value) => updateSetting('diversity', value / 1000)} />
          </View>}
        </Card>
        {!data.workspace.profile && <StateMessage title={tr('noSource')} body={data.workspace.canPublish ? tr('publicNotice') : tr('noPermission')} />}
        {ranking && <>
          <Heading level={2}>{tr('results')}</Heading><Body muted>{tr('scoreHelp')}</Body>
          <Body muted>{`${ranking.scannedCount} ${tr('examined')}`}</Body>
          {ranking.disabledDimensions.length > 0 && <Body muted>{`${tr('inactive')}: ${ranking.disabledDimensions.map(tr).join(', ')}`}</Body>}
          {ranking.results.length === 0 && <StateMessage title={tr(ranking.reason === 'needs_preferences' ? 'zero' : ranking.reason === 'insufficient_source_data' ? 'insufficient' : ranking.reason === 'reach_location_required' ? 'reachLocation' : ranking.reason === 'no_positive_match' ? 'noReason' : 'empty')} body="" />}
          {ranking.results.slice(0, resultLimit).map((match) => <ConnectionResult key={match.id} match={match} tr={tr} busy={Boolean(busy)}
            onRequest={data.workspace.canRequestHandshake && (preview || match.handshake?.eligible === true) ? () => setRequestTarget(match) : undefined}
            onHide={data.workspace.canPublish ? () => hide(match.id) : undefined} />)}
          {ranking.results.length > resultLimit && <Button label={tr('showMore')} variant="secondary" onPress={() => setResultLimit((value) => Math.min(100, value + 12))} />}
        </>}
        {data.workspace.canPublish && data.workspace.hiddenChapterIds.length > 0 && <Button label={tr('unhide')} variant="secondary" busy={busy === 'restore'} disabled={Boolean(busy)} onPress={restore} />}
        {data.workspace.canPublish ? <>
          <Card><Button label={editing ? tr('close') : data.workspace.profile ? tr('edit') : tr('setup')} variant="secondary" selected={editing} disabled={Boolean(busy)} onPress={() => setEditing(!editing)} />
            {editing && <ConnectionProfileEditor workspace={data.workspace} busy={Boolean(busy)} onPublish={publish} onWithdraw={withdraw} tr={tr} />}
          </Card>
          <Card><Button label={`${tr(reviewing ? 'collapse' : 'expand')}: ${tr('reviewTitle')}`} variant="secondary" selected={reviewing} disabled={Boolean(busy)} onPress={() => setReviewing(!reviewing)} />
            {reviewing && <ConnectionSourceReview workspace={data.workspace} busy={Boolean(busy)} onReview={review} onFreeze={freeze} tr={tr} />}
          </Card>
        </> : data.workspace.profile && <Body muted>{tr('noPermission')}</Body>}
      </>}
    </>}
  </View>;
}

function ConnectionResult({ match, tr, busy, onHide, onRequest }: { match: ConnectionMatch; tr: ConnectionTranslator; busy: boolean; onHide?: () => void; onRequest?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <Card>
    <Heading level={3}>{match.displayName}</Heading>
    <Body muted>{[match.location.metro, match.location.state, match.location.country].filter(Boolean).join(' · ')}</Body>
    <Body>{`${tr('score')}: ${Math.round(match.score * 100)}% · ${tr('coverage')}: ${Math.round(match.coverage * 100)}%`}</Body>
    {match.sectorKeys.length > 0 && <Body>{match.sectorKeys.map(tr).join(', ')}</Body>}
    {match.diversityPenalty > 0 && <Body muted>{tr('diversityApplied')}</Body>}
    <Button label={`${tr('why')}: ${match.displayName}`} variant="secondary" selected={expanded} onPress={() => setExpanded(!expanded)} />
    {expanded && <View style={connectionStyles.group}>{match.contributions.filter((item) => item.weight > 0).map((item) =>
      <Body key={item.dimension}>{`${tr(item.dimension)}: ${item.available ? `${Math.round((item.similarity ?? 0) * 100)}%` : tr('missing')}`}</Body>)}</View>}
    {onHide && <Button label={`${tr('hide')}: ${match.displayName}`} variant="secondary" disabled={busy} onPress={onHide} />}
    {onRequest && <Button label={`${tr('requestHandshake')}: ${match.displayName}`} disabled={busy} onPress={onRequest} />}
    {!onRequest && match.handshake?.eligible === false && <Body muted>{tr('handshakeUnavailable')}</Body>}
  </Card>;
}
