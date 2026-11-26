import { captureSessionWriter } from '../../src/services/supabase';
import { Ionicons } from '@expo/vector-icons';
import { LiveChartMessage } from '../../src/features/SavedPulseCharts';
import { chartReference } from '../../src/lib/savedPulseCharts';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from '../../src/components/Text';

import { PinnedHeaderScreen, useScreenNameAlreadySpoken } from '../../src/components/PinnedHeader';
import { Avatar, Body, Button, Notice, Screen, StateMessage } from '../../src/components/ui';
import { WorkflowMessageActions } from '../../src/components/WorkflowActions';
import { AddReactionChip, MessageReactionButton, MessageReactionPicker } from '../../src/components/MessageReactions';
import { NativeMessageActions } from '../../src/components/NativeMessageActions';
import { ChannelPollCard } from '../../src/components/ChannelPollCard';
import { MessageReplies, ParentMessageControl, ReplyCountControl, useMessageReplyCounts } from '../../src/components/MessageReplies';
import { messageActionRequest } from '../../../../src/features/messaging/actions.js';
import { parseRemindCommand, remindErrorTextEn, REMIND_USAGE_EN } from '../../../../src/features/messaging/remindCommand.js';
import { createChannelHereReminder, REMIND_HERE_SWITCH, remindHereRefusal, remindHereRefusalTextEn } from '../../../../src/features/messaging/remindHere.js';
import { isFeatureEnabled } from '../../src/lib/featureSwitches';
import { formatDateTime } from '../../../../src/lib/i18n/format.js';
import { announceForAccessibility } from '../../src/lib/announce';
import { getSupabaseClient } from '../../src/services/supabase';
import { type ChannelMessage } from '../../src/data/demoChannels';
import { liveChannelStore, resolveChannelRoute, withChannelDayLines, type ChannelRouteState } from '../../src/data/liveChannels';
import { channelMessageInReaderLanguage, channelReaderLanguage } from '../../src/lib/channelContent';
import { CONVERSATION_RECONCILE_MS, conversationHistoryCopy, useConversationHistory } from '../../src/features/useConversationHistory';
import { usePrependAnchor } from '../../src/features/prependAnchor';
import { useChannelStore } from '../../src/data/useChannels';
import { channelControlsApi, useChannelControls, type MentionCandidate } from '../../src/data/channelControls';
import { CHANNEL_BODY_LINE_HEIGHT, ChannelHighlightedBody, ChannelSettingsPanel, MentionPickerPanel, channelHasAnyControl } from '../../src/components/ChannelControls';
import { appendMentionText, channelSettingFor, isMuteActive, mentionIdsForBody } from '../../src/lib/channelControlsShared';
import { channelActionNotice, channelLoadFailureNotice, messageInboxCopy } from '../../src/lib/messageInboxCopy';
import { haptics } from '../../src/services/haptics';
import { useApp } from '../../src/state/AppProvider';
import { isAuthoritativeReadRefusal, isReadRefusal } from '../../src/lib/readRefusal';
import { useHeldScreenScope } from '../../src/lib/heldScreenScope';
import { retireResumeDraft, useResumeDraftKey } from '../../src/lib/resumeDraftHolder';
import { connectedWorkflowApi } from '../../src/lib/connectedWorkflows';
import { withReadDeadline } from '../../src/lib/readDeadline';
import { useNativeUi } from '../../src/lib/useNativeUi';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';

import { typeface } from '../../src/theme/typeface';
// A body's 48 pt target reaches up over the plain author line (and an
// "@ Mentions you" line) by up to the space one line leaves, so a one-line
// body's words sit next to their author and the footer row with no band of
// space around them; the line grows with the text size, which the body text
// does not cap (cap this too if it ever is), so the reach shrinks to nothing
// once one line fills the target. Under a "Replying to" chip, whose own target
// is above, the body keeps its centred target; so does every body while a
// screen reader may run (NativeMessageActions), so the time and role in the
// author line stay apart for touch exploration.
function bodyReachOverAuthor(fontScale: number): number {
  return Math.max(0, minimumTouchTarget - Math.round(CHANNEL_BODY_LINE_HEIGHT * fontScale) - 2 * spacing.xs);
}

// A PostgREST/PostgreSQL insufficient_privilege refusal: the workspace declined
// the write (closed thread, lost membership), which is not a transport failure.
function isWriteRefusal(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '42501');
}

export default function ChannelScreen() {
  const route = useLocalSearchParams<{ id?: string; message?: string; post?: string }>();
  const actor = useApp();
  const { t } = useNativeUi();
  const sourceKey = useHeldScreenScope(actor.mode === 'booting', [actor.session?.user.id, route.id, route.message, route.post], [actor.mode, actor.organizationID, actor.dashboard?.member.chapterID, actor.authorizedRoles, actor.previewHat]);
  const [named, setNamed] = useState({ scope: sourceKey, name: 'Channel' });
  const setScreenName = useCallback((name: string) => setNamed((previous) => previous.scope === sourceKey && previous.name === name ? previous : { scope: sourceKey, name }), [sourceKey]);
  const screenName = (actor.mode === 'authenticated' || actor.mode === 'preview') && named.scope === sourceKey ? named.name : 'Channel';
  return (
    // Keep long thread names in the wrapping content header, clear of Back.
    <PinnedHeaderScreen title={t('Messages')} screenName={screenName}>
      <ChannelContent key={sourceKey} onScreenName={setScreenName} />
    </PinnedHeaderScreen>
  );
}

function ChannelContent({ onScreenName }: { onScreenName: (name: string) => void }) {
  const { id, post } = useLocalSearchParams<{ id: string; post?: string }>();
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const actor = useApp();
  const { mode, session, dashboard, previewHat, authorizedRoles, organizationID, memberLanguage } = actor;
  const settingsDraftKey = useResumeDraftKey(actor, 'channelSettings', id);
  const settingsSendKey = useResumeDraftKey(actor, 'channelSettingSend', id);
  // The saved member language (the profile choice first, as everywhere else on
  // native) drives this screen's own words; posts, names and the channel's
  // name and topic are shown as written.
  const { language, t, catalogLabel } = useNativeUi();
  const copy = messageInboxCopy[language];
  const sourceScope = JSON.stringify([session?.user.id, organizationID, dashboard?.member.chapterID, authorizedRoles, previewHat]);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'missing'>('loading');
  // The linked message this screen last confirmed (#8769): a later check that
  // fails or times out keeps it; only the server's answer that it is gone or
  // no longer readable, or a first check that fails, shows it unavailable.
  const confirmedSource = useRef<string | null>(null);
  const threadOffset = useRef(0);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyCheck, setReplyCheck] = useState<'ready' | 'loading' | 'failed'>('ready');
  const [replyParent, setReplyParent] = useState<string | null>(null);
  const [replyRevision, setReplyRevision] = useState(0);
  const routeVersion = useRef(0);
  useLayoutEffect(() => {
    routeVersion.current += 1;
    return () => { routeVersion.current += 1; };
    // Draft, reply and mentions share the held route's owner. A resume hides
    // them until the reset live store and any linked-post check load afresh.
  }, []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // REQ-UG-REMIND-HERE-20261001: the /remind command's confirmation or help.
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  // The staff tip shows only when the organization switch is on; the server
  // enforces the switch either way.
  const [remindHereOn, setRemindHereOn] = useState(false);
  const staffActor = mode === 'authenticated' && authorizedRoles.length > 0;
  useEffect(() => {
    const client = getSupabaseClient();
    if (!staffActor || !client) { setRemindHereOn(false); return undefined; }
    let current = true;
    void Promise.resolve(client.rpc('get_member_organization_configuration')).then((response: { data: unknown; error: unknown }) => {
      if (current) setRemindHereOn(!response.error && isFeatureEnabled(response.data as Parameters<typeof isFeatureEnabled>[0], REMIND_HERE_SWITCH, false));
    }).catch(() => { if (current) setRemindHereOn(false); });
    return () => { current = false; };
  }, [staffActor, sourceScope]);
  // REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001: this screen keeps the
  // worker's presence fresh while open (so @here reaches them), and offers the
  // channel's notification settings, mentions and the staff pin.
  const channelControlsState = useChannelControls({ heartbeat: true });
  const channelControls = channelControlsState.controls;
  const applyChannelSetting = channelControlsState.applySetting;
  const controlsLive = channelControlsState.live;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // BUG-UG-MESSAGE-REACTION-PARITY-20260904: which message currently has
  // its reaction picker open. Reactions used to be reachable only on a message
  // that already had one, so a fresh message could not be reacted to at all
  // from a phone.
  const [pickerMessageID, setPickerMessageID] = useState<string | null>(null);
  const retireAuthoring = useCallback(() => {
    routeVersion.current += 1;
    setDraft(''); setReplyTo(null); setReplyParent(null); setPicked([]); setMentionOpen(false);
    setSending(false); setSendError(null); setSendNotice(null); setReplyCheck('ready');
  }, []);
  const retireSettings = useCallback(() => {
    retireResumeDraft(settingsDraftKey); retireResumeDraft(settingsSendKey);
  }, [settingsDraftKey, settingsSendKey]);
  const channelScrollRef = useRef<ScrollView>(null);
  const anchoredChannel = useRef<string | null>(null);
  const store = useChannelStore();
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion);
  const channelReadRefused = mode === 'authenticated' && liveChannelStore.readRefused();
  useEffect(() => {
    if (mode === 'booting') { setReplyCheck('loading'); return; }
    if (mode !== 'authenticated' || !replyTo) { setReplyCheck('ready'); return; }
    if (replyCheck !== 'loading' || store.status() !== 'ready') return;
    const api = connectedWorkflowApi();
    if (!api) { setReplyCheck('failed'); return; }
    let current = true;
    // Confirm the held reply's source without hydrating/removing the whole
    // channel: other posts can remain readable when this one was removed.
    void withReadDeadline(api.context({ kind: 'channel_post', id: replyTo })).then((source) => {
      if (!current) return;
      if (!source.available || source.state === 'removed') {
        retireAuthoring();
      }
      setReplyCheck('ready');
    }).catch((error: unknown) => {
      if (!current) return;
      if (isReadRefusal(error)) retireAuthoring();
      else setReplyCheck('failed');
    });
    return () => { current = false; };
  }, [id, mode, replyTo, replyCheck, sourceScope, store, storeVersion, retireAuthoring]);
  useEffect(() => {
    if (mode === 'booting') { confirmedSource.current = null; setSourceState('loading'); }
    if (!post || mode !== 'authenticated' || store.status() === 'loading' || store.status() === 'idle') return;
    let current = true; setSourceState('loading');
    const source = JSON.stringify([id, post, sourceScope]);
    const check = () => { void liveChannelStore.hydrateSource(id, post).then((available) => {
      if (!current) return;
      if (!available) { retireAuthoring(); retireSettings(); }
      confirmedSource.current = available ? source : null;
      setSourceState(available ? 'ready' : 'missing');
    }).catch((error: unknown) => {
      if (!current) return;
      // A permission error or a refused session is the server's answer too (#8798 review P1-1).
      if (isReadRefusal(error)) {
        retireAuthoring();
        if (isAuthoritativeReadRefusal(error)) retireSettings();
        confirmedSource.current = null; setSourceState('missing'); return;
      }
      setSourceState(confirmedSource.current === source ? 'ready' : 'missing');
    }); };
    check(); const timer = setInterval(check, 30000);
    return () => { current = false; clearInterval(timer); };
  }, [id, post, mode, sourceScope, store, storeVersion, retireAuthoring, retireSettings]);
  // Scoped to this route: a reaction or vote that failed in another channel
  // must not surface its notice here.
  const actionDiagnosis = liveChannelStore.actionDiagnosis(id ?? '');
  const resolvedRouteState = resolveChannelRoute(store, id ?? '');
  const routeState: ChannelRouteState = resolvedRouteState.kind === 'ready'
    && mode === 'preview'
    && previewHat === 'member' && resolvedRouteState.channel.locked
    ? { kind: 'missing' }
    : resolvedRouteState;
  useEffect(() => {
    if (mode === 'authenticated' && (routeState.kind === 'missing' || channelReadRefused)) retireAuthoring();
  }, [mode, routeState.kind, channelReadRefused, retireAuthoring]);
  useEffect(() => {
    if (mode === 'authenticated' && (routeState.kind === 'missing' || liveChannelStore.authoritativeReadRefused())) retireSettings();
  }, [mode, routeState.kind, storeVersion, retireSettings]);
  const channel = routeState.kind === 'ready' ? routeState.channel : null;
  // BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the
  // store holds the chapter's newest posts; when that window is full, this
  // thread's earlier posts open above them, page by page, under the same
  // rules as a private conversation's earlier history (useConversationHistory).
  // There is no 30 s reconcile here, so the opened history is read again on
  // that timer instead.
  const live = mode === 'authenticated';
  const earlierCursor = live && channel ? liveChannelStore.earlierCursor(channel.id) : null;
  // The store updates a message in place (a reaction, a confirmed reply), so
  // its version, not the row's identity, says when the newest page changed.
  const newestPage = useMemo(() => {
    if (!channel || !earlierCursor) return null;
    return { messages: channel.messages.flatMap((row) => (row.createdAt ? [{ ...row, createdAt: row.createdAt }] : [])), earlierCursor };
  }, [channel, earlierCursor, storeVersion]);
  // The same language the newest posts are shown in (useChannelStore).
  const contentLanguage = channelReaderLanguage(memberLanguage, dashboard?.member.language, Intl.DateTimeFormat().resolvedOptions().locale);
  const historyChannelID = channel?.id ?? null;
  const history = useConversationHistory({
    scopeKey: JSON.stringify([historyChannelID, mode, session?.user.id ?? null]),
    thread: newestPage,
    load: async (before) => {
      if (!historyChannelID) throw new Error('Earlier messages did not load. Try again.');
      const page = await liveChannelStore.earlierPosts(historyChannelID, before);
      return { ...page, messages: page.messages.map((row) => channelMessageInReaderLanguage(row, contentLanguage)) };
    },
    revalidateMs: CONVERSATION_RECONCILE_MS,
  });
  // A post shown only from earlier history takes its reactions from the store's
  // latest read or confirmed reaction, so a reaction on it shows at once.
  const windowIDs = new Set((channel?.messages ?? []).map((row) => row.id));
  const shownMessages: ChannelMessage[] = history.started && newestPage
    ? withChannelDayLines(history.messages).map((row) => (windowIDs.has(row.id) ? row : { ...row, reactions: liveChannelStore.earlierReactions(row.id) ?? row.reactions }))
    : channel?.messages ?? [];
  const prepend = usePrependAnchor();
  const replyCounts = useMessageReplyCounts('channel', `${session?.user.id}:${id}`, shownMessages.map((row) => row.id), mode === 'authenticated');

  useEffect(() => {
    if (channel) store.markRead(channel.id);
  }, [channel]);

  // Notice's live region is Android-only, and this failure arrives after the
  // RPC settles, so iOS VoiceOver hears each new mark-read fault once here.
  const markReadDiagnosis = channel ? store.markReadFault(channel.id) : null;
  const announcedMarkReadFault = useRef<unknown>(null);
  useEffect(() => {
    if (markReadDiagnosis && markReadDiagnosis !== announcedMarkReadFault.current && Platform.OS === 'ios') {
      announceForAccessibility(copy.markReadError);
    }
    announcedMarkReadFault.current = markReadDiagnosis;
  }, [markReadDiagnosis, copy.markReadError]);

  // The action notice renders at the end of the channel's scroll content and
  // `anchorCurrentMessages` fires only once per channel, so a reaction or vote
  // that fails above the fold would otherwise append its notice out of sight.
  // Bring it into view, and announce it on iOS where Notice's live region does
  // not apply — the same treatment the mark-read fault above gets.
  const announcedActionFault = useRef<unknown>(null);
  useEffect(() => {
    const op = actionDiagnosis?.op;
    if (op !== 'reaction' && op !== 'vote') return;
    if (actionDiagnosis === announcedActionFault.current) return;
    announcedActionFault.current = actionDiagnosis;
    requestAnimationFrame(() => channelScrollRef.current?.scrollToEnd({ animated: true }));
    if (Platform.OS === 'ios') announceForAccessibility(channelActionNotice(copy, op));
  }, [actionDiagnosis, copy]);

  // The pinned bar names the channel before it offers the way back.
  const channelName = mode === 'authenticated' && !channelReadRefused && (!post || sourceState === 'ready') && (!replyTo || replyCheck === 'ready') ? channel?.name ?? null : null;
  useEffect(() => {
    onScreenName(channelName ?? 'Channel');
    return () => onScreenName('Channel');
  }, [channelName, onScreenName]);

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  if (mode === 'booting') return <Screen><StateMessage title={t('Channel is loading')} body={t('Checking your current campaign access.')} /></Screen>;
  if (channelReadRefused) return <Screen><StateMessage title={t('Channel not available')} body={t('This channel does not exist or your current role cannot access it.')} /></Screen>;
  if (replyTo && replyCheck !== 'ready') return <Screen><StateMessage title={t(replyCheck === 'failed' ? 'Selected message unavailable' : 'Loading selected message')} body={t(replyCheck === 'failed' ? 'This message was removed or your access changed.' : 'Checking the original message and current access.')} action={replyCheck === 'failed' ? <Button label={t('Try again')} onPress={() => setReplyCheck('loading')} /> : undefined} /></Screen>;
  if (post && mode === 'authenticated' && sourceState === 'missing') return <Screen><StateMessage title={t('Selected message unavailable')} body={t('This message was removed or your access changed.')} /></Screen>;
  if (post && mode === 'authenticated' && sourceState === 'loading') return <Screen><StateMessage title={t('Loading selected message')} body={t('Checking the original message and current access.')} /></Screen>;
  if (routeState.kind === 'loading') return <Screen><StateMessage title={t('Channel is loading')} body={t('Checking your current campaign access.')} /></Screen>;
  if (routeState.kind === 'error') {
    const body = channelLoadFailureNotice(copy, store.loadFault()) ?? routeState.message;
    return <Screen><StateMessage title={t('Channel could not load')} body={body} /></Screen>;
  }
  if (routeState.kind === 'missing') return <Screen><StateMessage title={t('Channel not available')} body={t('This channel does not exist or your current role cannot access it.')} /></Screen>;
  if (!channel) return null;

  const poll = store.poll();
  const actionNotice = actionDiagnosis && (actionDiagnosis.op === 'reaction' || actionDiagnosis.op === 'vote')
    ? channelActionNotice(copy, actionDiagnosis.op)
    : null;
  // b05-13: whole percentages that sum to 100, apportioned from the live vote
  // counts, instead of three independently rounded fractions.
  const meInitials = dashboard?.member.initials ?? 'ME';
  const meName = dashboard?.member.firstName ? `${dashboard.member.firstName} (you)` : 'You';

  // BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926:
  // the replies page was handed this row's id, which is a chapter_threads id,
  // while get_member_message_replies takes the chapter_spaces id, so every
  // replies page raised 42501 and rendered "Replies unavailable."; and a thread
  // the workspace has resolved still offered Reply and the composer, so the
  // refusal from reply_to_member_message / the chapter_thread_posts policy
  // surfaced as the generic secure-send notice with the draft left in place.
  // The live row now carries `spaceID` and `closed`; a closed thread shows the
  // closed notice instead of a composer, and a 42501 refusal of a reply send
  // names the closed thread only after the thread's status is re-read as not
  // open (the same code covers session, MFA and access refusals).
  const closed = channel?.closed === true;
  function startReply(messageID: string) {
    if (closed) { setSendError(channelActionNotice(copy, 'closed')); return; }
    setReplyTo(messageID); setDraft('');
  }

  // REQ-UG-REMIND-HERE-20261001: a draft that starts with /remind is a
  // command and is never posted. The server decides who may remind the
  // channel's staff (campaign staff who can post here, organization switch on).
  async function remindHere(parsed: NonNullable<ReturnType<typeof parseRemindCommand>>) {
    setSendError(null); setSendNotice(null);
    if (parsed.kind === 'help') { setSendNotice(`${t("Remind this channel's staff:")}\n${REMIND_USAGE_EN.replaceAll('<what>', t('<what>'))}`); return; }
    if (parsed.kind === 'error') { setSendError(remindErrorTextEn(parsed.code)); return; }
    if (parsed.target !== 'here') { setSendError(remindErrorTextEn('me_not_here')); return; }
    const client = getSupabaseClient();
    if (mode !== 'authenticated' || !client) { setSendError('Channel staff reminders need a signed-in staff account. Preview does not set one.'); return; }
    if (!channel?.spaceID) { setSendError(remindHereRefusalTextEn('unavailable')); return; }
    const version = routeVersion.current;
    setSending(true);
    try {
      await createChannelHereReminder(await captureSessionWriter(session).client(), { spaceId: channel.spaceID, remindAt: parsed.remindAt.toISOString(), note: parsed.note });
      if (version !== routeVersion.current) return;
      setDraft(''); setPicked([]);
      const confirmation = t("This channel's staff will be reminded {when}: {note}", { when: formatDateTime(parsed.remindAt.toISOString(), language), note: parsed.note });
      setSendNotice(confirmation);
      announceForAccessibility(confirmation);
    } catch (error) {
      if (version === routeVersion.current) setSendError(remindHereRefusalTextEn(remindHereRefusal(error)));
    } finally {
      if (version === routeVersion.current) setSending(false);
    }
  }

  async function send() {
    const clean = draft.trim();
    if (mode !== 'authenticated' || !clean || !channel || sending) return;
    const remindCommand = parseRemindCommand(clean, new Date());
    if (remindCommand) { await remindHere(remindCommand); return; }
    if (closed) { setSendError(channelActionNotice(copy, 'closed')); return; }
    setSendNotice(null);
    const version = routeVersion.current;
    void haptics.impact();
    setSending(true);
    setSendError(null);
    try {
      if (replyTo && mode === 'authenticated') {
        const row = await messageActionRequest(await captureSessionWriter(session).client(), 'channel', replyTo, 'reply', clean) as Parameters<typeof liveChannelStore.acceptConfirmedReply>[1];
        if (version !== routeVersion.current) return;
        liveChannelStore.acceptConfirmedReply(channel.id, row);
        setDraft(''); setReplyTo(null);
        setReplyRevision((revision) => revision + 1);
        return;
      }
      const mentionIDs = controlsLive && channelControls.switches.mentions ? mentionIdsForBody(clean, picked) : [];
      const sent = await store.send(channel.id, clean, meName, meInitials, mentionIDs);
      if (version !== routeVersion.current) return;
      if (sent) setDraft('');
      if (sent) setPicked([]);
      else setSendError(channelActionNotice(copy, 'send'));
    } catch (error) {
      // A 42501 also covers session, MFA and access refusals: only the thread's
      // fresh status may select the closed-thread copy.
      const closedNow = replyTo && isWriteRefusal(error) ? await liveChannelStore.threadClosed(channel.id) : false;
      if (version === routeVersion.current) setSendError(channelActionNotice(copy, closedNow ? 'closed' : 'send'));
    } finally {
      if (version === routeVersion.current) setSending(false);
    }
  }

  const channelID = channel.id;
  const messages = shownMessages;
  const showEarlier = () => {
    prepend.mark(messages[messages.length - 1]?.id ?? null);
    history.loadEarlier();
  };
  const spaceID = channel.spaceID ?? null;
  const switches = channelControls.switches;
  const highlightKeywords = controlsLive && switches.keywordAlerts && spaceID ? channelSettingFor(channelControls, spaceID).keywords : [];
  const highlightHere = controlsLive && switches.hereMentions;
  const muted = controlsLive && spaceID ? isMuteActive(channelSettingFor(channelControls, spaceID)) : false;
  // A thread-less space row has no thread to pin; staff pin real threads only.
  const pinnable = controlsLive && channelControls.canPin && spaceID != null && channelID !== spaceID;
  async function togglePin() {
    if (pinBusy || !pinnable) return;
    const next = !channel?.pinnedAt;
    const version = routeVersion.current;
    const writer = captureSessionWriter(session);
    let acknowledged = false;
    setPinBusy(true);
    setPinNotice(null);
    try {
      await channelControlsApi.setPinned(writer, channelID, next);
      acknowledged = true;
      const current = await writer.isCurrent();
      if (version !== routeVersion.current || !current) return;
      setPinNotice(next ? t('Thread pinned.') : t('Thread unpinned.'));
      await store.refresh();
    } catch {
      const proof = await writer.check();
      if (version === routeVersion.current && proof !== 'changed' && !acknowledged) setPinNotice(t('The pin did not change. Try again.'));
    } finally {
      if (version === routeVersion.current) setPinBusy(false);
    }
  }
  function anchorCurrentMessages() {
    if (post || anchoredChannel.current === channelID) return;
    anchoredChannel.current = channelID;
    requestAnimationFrame(() => channelScrollRef.current?.scrollToEnd({ animated: false }));
  }

  function messageRow(message: ChannelMessage) {
    const pickerOpen = pickerMessageID === message.id;
    const mineByKind = new Set((message.reactions ?? []).filter((entry) => entry.mine).map((entry) => entry.kind));
    // A11Y-UG-MOBILE-CHANNEL-AND-REPLY-ROW-NAMES-OMIT-SENDER-20260915: the
    // post itself was the only labelled control and it was named by its body,
    // while the author sat in a sibling line outside it — VoiceOver read a
    // channel post with no writer. The row now carries `sender: body`, the name
    // the conversation screen already composes, and the author text and the
    // initials avatar leave the accessibility tree so the name is announced
    // once. The role chip and the time stay audible: neither is in the name.
    //
    // The author is a leaf <Text>, and a <Text> *is* the iOS accessibility
    // element: `accessibilityElementsHidden` hides the elements contained
    // within one, so on its own it would have left the name readable on iPhone
    // and removed it only on Android. `accessible={false}` is what takes the
    // node itself out of the iOS tree; the other two props stay for Android's
    // NO_HIDE_DESCENDANTS. The avatar above is the wrapping-View form #2038
    // used, which is correct there because it wraps a component subtree —
    // wrapping this Text instead would put a View into a baseline-aligned row
    // for no gain.
    const rowName = `${message.author}: ${message.body}`;
    // One footer row per message: its reactions, the add-reaction chip, the
    // reply count and, for a signed-in reader, "⋯ Actions" at its end, all in
    // the reply count's quiet chip system (App Store capture review, Nov 7,
    // 2026). A poll's card sits between the text and this row.
    const reactionRow = <>
      {(message.reactions ?? []).filter((reaction) => reaction.count > 0).map((reaction) => (
        <MessageReactionButton key={reaction.kind} entry={reaction} showCount chip
          disabled={mode === 'authenticated' && liveChannelStore.reactionPending(message.id, reaction.kind)}
          onPress={() => { void haptics.select(); store.toggleReaction(channelID, message.id, reaction.kind); }} />
      ))}
      <AddReactionChip accessibilityLabel={t('React to the message from {name}', { name: message.author })} expanded={pickerOpen}
        onPress={() => { void haptics.select(); setPickerMessageID(pickerOpen ? null : message.id); }} />
      {(replyCounts[message.id] ?? 0) > 0 ? <ReplyCountControl count={replyCounts[message.id] ?? 0} onPress={() => setReplyParent(message.id)} /> : null}
    </>;
    const footerInActions = mode === 'authenticated';
    const pollBlock = message.poll && poll ? (
      <ChannelPollCard poll={poll} members={channel?.members} language={language} theme={theme}
        onVote={(index) => { void haptics.select(); store.vote(index); }} />
    ) : message.poll ? (
      <Notice>{copy.pollUnavailable}</Notice>
    ) : null;
    return (
      <View key={message.id} onLayout={(event) => { if (message.id === post) channelScrollRef.current?.scrollTo({ y: Math.max(0, threadOffset.current + event.nativeEvent.layout.y - 20), animated: false }); }}>
        {message.day ? (
          <View style={styles.dayRow}>
            <View style={[styles.dayChip, { borderColor: theme.border, backgroundColor: theme.card }]}>
              <Text style={[styles.dayText, { color: theme.foreground }]}>{message.day}</Text>
            </View>
          </View>
        ) : null}
        {message.newDivider ? (
          <View accessible style={styles.newDivider} accessibilityLabel={t('New messages')}>
            <View style={[styles.newLine, { backgroundColor: theme.destructive }]} />
            <Text style={[styles.newText, { color: theme.destructive }]}>{t('NEW')}</Text>
          </View>
        ) : null}
        <View style={styles.msgRow}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Avatar square initials={message.initials} size={38} />
          </View>
          <View style={styles.msgBody}>
            <View style={styles.nameLine}>
              <Text accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.author, { color: theme.foreground }]}>{message.author}</Text>
              {message.role ? (
                <View style={[styles.roleChip, { backgroundColor: theme.secondary }]}>
                  <Text style={[styles.roleText, { color: theme.secondaryForeground }]}>{message.role}</Text>
                </View>
              ) : null}
              <Text style={[styles.time, { color: theme.mutedForeground }]}>{message.time}</Text>
            </View>
            {message.mentionsMe ? <Text accessibilityLabel={t('Mentions you')} style={[styles.mentionChip, { color: theme.primary }]}>{t('@ Mentions you')}</Text> : null}
            {mode === 'authenticated' && message.parentMessageID ? <ParentMessageControl align="start" beforeBody author={messages.find((row) => row.id === message.parentMessageID)?.author} onPress={() => setReplyParent(message.parentMessageID ?? null)} /> : null}
            {mode === 'authenticated' ? <WorkflowMessageActions key={`${session?.user.id ?? mode}:${message.id}`} sourceKind="channel" messageID={message.id} footer={footerInActions ? reactionRow : undefined} aboveFooter={footerInActions ? pollBlock : undefined} reachAbove={message.parentMessageID ? undefined : bodyReachOverAuthor(fontScale)} accessibilityLabel={rowName} onConfirmed={(state) => liveChannelStore.acceptConfirmedActions(channelID, message.id, state.reactions)} onCompose={() => { startReply(message.id); }}>{chartReference(message.body) ? <LiveChartMessage body={message.body} /> : <ChannelHighlightedBody body={message.body} keywords={highlightKeywords} here={highlightHere} />}</WorkflowMessageActions> : <View accessible accessibilityLabel={rowName}><Body>{message.body}</Body></View>}
            {/* BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904: attachment
                cards exist only in the seeded PREVIEW fixtures — the live store
                never produces one — and the card is deliberately not a control,
                because there is nothing stored to open. The mode guard makes
                that structural rather than incidental. */}
            {mode === 'preview' && message.attachment ? (
              <View
                accessibilityRole="text"
                accessibilityLabel={t('Preview sample attachment {name}, {meta}. Not a stored file.', { name: message.attachment.name, meta: message.attachment.meta })}
                style={[styles.attachment, { borderColor: theme.border }]}
              >
                <View style={[styles.attachmentIcon, { backgroundColor: theme.secondary }]}>
                  <Ionicons name="document-text-outline" size={18} color={theme.secondaryForeground} />
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.attachmentName, { color: theme.foreground }]}>{message.attachment.name}</Text>
                  <Text style={[styles.attachmentMeta, { color: theme.mutedForeground }]}>{message.attachment.meta}</Text>
                </View>
              </View>
            ) : null}
            {footerInActions ? null : <>{pollBlock}<View style={styles.reactions}>{reactionRow}</View></>}
            {pickerOpen ? <MessageReactionPicker mine={[...mineByKind]}
              disabled={mode === 'authenticated' && liveChannelStore.reactionPending(message.id)}
              onReact={(kind) => { void haptics.select(); store.toggleReaction(channelID, message.id, kind); }} /> : null}
            {/* BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904: the reply
                count was rendered in the accent colour with no handler, so it
                read as a link to a thread that does not exist on this screen.
                It is status text now — muted, explicitly non-actionable — and
                it becomes a control again only when a thread route exists to
                open. */}
            {message.threadHint ? (
              <Text
                accessibilityRole="text"
                accessibilityLabel={t('{hint}. Replies are not openable from this screen yet.', { hint: message.threadHint })}
                style={[styles.threadHint, { color: theme.mutedForeground }]}
              >{message.threadHint}</Text>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  return (
    <Screen
      scrollRef={channelScrollRef}
      onScrollOffset={(y) => prepend.scrolled(y)}
      onContentHeight={(height) => {
        prepend.laidOut(height, {
          newest: messages[messages.length - 1]?.id ?? null,
          loading: history.status === 'loading',
          scrollTo: (y) => channelScrollRef.current?.scrollTo({ y, animated: false }),
        });
      }}
    >
      <View onLayout={anchorCurrentMessages} style={styles.channelContent}>
      <View style={styles.header}>
        <View style={styles.headerActions}>
          <View style={styles.headerTitle}><Heading2 name={channel.name} theme={theme} /></View>
          {(spaceID && channelHasAnyControl(channelControls)) || pinnable ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('Channel actions')}
              accessibilityState={{ expanded: actionsOpen }}
              onPress={() => setActionsOpen((open) => !open)}
              style={[styles.mentionButton, { backgroundColor: theme.secondary, borderColor: theme.border }]}>
              <Ionicons name="ellipsis-horizontal" size={22} color={theme.secondaryForeground} accessibilityElementsHidden />
            </Pressable>
          ) : null}
        </View>
        {/* A private channel says so on its own line, whether or not the
            name above moved to the title row beside Back, and once for a
            screen reader. */}
        {channel.locked ? <PrivateChannelStatus label={t('Private channel')} theme={theme} /> : null}
        <Body muted>{`${switches.channelPinning && channel.pinnedAt ? t('Pinned · ') : ''}${muted ? t('Muted · ') : ''}${channel.members ? t('{n} people · ', { n: channel.members }) : ''}${channel.topic}`}</Body>
        {actionsOpen ? (
          <View style={styles.channelMenu} onAccessibilityEscape={() => setActionsOpen(false)}>
            {spaceID && channelHasAnyControl(channelControls) ? (
              <Button label={settingsOpen ? t('Hide channel notifications') : t('Channel notifications')} variant="secondary"
                onPress={() => { setSettingsOpen((open) => !open); setActionsOpen(false); }} />
            ) : null}
            {pinnable ? <Button label={channel.pinnedAt ? t('Unpin thread') : t('Pin thread')} variant="secondary" busy={pinBusy} onPress={() => { void togglePin(); }} /> : null}
          </View>
        ) : null}
        {pinNotice ? <Body muted>{pinNotice}</Body> : null}
        {settingsOpen && spaceID ? <ChannelSettingsPanel spaceID={spaceID} controls={channelControls} onSaved={applyChannelSetting}
          resumeItemID={id} freshAccess={channelControlsState.status === 'ready'} /> : null}
      </View>
      {markReadDiagnosis ? <Notice>{copy.markReadError}</Notice> : null}
      {channel.pollUnavailable && !channel.messages.some((message) => message.poll) ? (
        <Notice>{copy.pollUnavailable}</Notice>
      ) : null}
      <View style={styles.thread} accessibilityLabel={t('Messages in {name}', { name: channel.name })} onLayout={(event) => { threadOffset.current = event.nativeEvent.layout.y; }}>
        {!replyParent && newestPage ? <EarlierChannelHistory status={history.status} hasEarlier={history.hasEarlier} started={history.started} lastLoaded={history.lastLoaded} onShowEarlier={showEarlier} /> : null}
        {replyParent ? <MessageReplies key={`${session?.user.id}:${id}:${replyParent}:${replyRevision}`} sourceKind="channel" targetID={channel.spaceID ?? channelID} parentID={replyParent}
          onClose={() => setReplyParent(null)} onOpenParent={setReplyParent} onCompose={(_kind, row) => { startReply(row.id); }} /> : messages.map(messageRow)}
      </View>
      {/* BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904: this composer used
          to open with a plus glyph inside a plain View — no role, no label, no
          handler — that looked exactly like an attach control. There is no
          authorized channel file workflow on this screen, so the honest fix is
          that the affordance is absent until one exists rather than present and
          dead. tests/mobile-message-controls-contract.test.js fails if any
          visible control here regains that shape. */}
      {closed ? <Notice>{channelActionNotice(copy, 'closed')}</Notice> : <>
      {replyTo ? <Button label={t('Cancel reply')} onPress={() => { setReplyTo(null); setDraft(''); }} /> : null}
      {!replyTo && controlsLive && switches.mentions && spaceID ? (
        <MentionPickerPanel spaceID={spaceID} disabled={sending} open={mentionOpen} onClose={() => setMentionOpen(false)} onPick={(person) => {
          setPicked((current) => current.some((item) => item.id === person.id) ? current : [...current, person]);
          setDraft((current) => appendMentionText(current, person));
        }} />
      ) : null}
      <View style={[styles.composer, { backgroundColor: theme.card, borderColor: theme.border }]}>
        {!replyTo && controlsLive && switches.mentions && spaceID ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('Mention someone')}
            accessibilityState={{ disabled: sending, expanded: mentionOpen }} disabled={sending}
            onPress={() => setMentionOpen((open) => !open)}
            style={[styles.mentionButton, { backgroundColor: sending ? theme.muted : theme.secondary, borderColor: theme.border }]}>
            <Ionicons name="at-outline" size={22} color={sending ? theme.mutedForeground : theme.secondaryForeground} accessibilityElementsHidden />
          </Pressable>
        ) : null}
        <TextInput
          accessibilityLabel={t('Message {name}', { name: channel.name })}
          value={draft}
          onChangeText={setDraft}
          placeholder={t('Reply')}
          placeholderTextColor={theme.quietForeground}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          style={[styles.input, { color: theme.foreground }]}
          onSubmitEditing={() => { void send(); }}
          returnKeyType="send"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Send message')}
          accessibilityState={{ busy: sending, disabled: sending || !draft.trim() }}
          disabled={sending || !draft.trim()}
          onPress={() => { void send(); }}
          style={[styles.send, { backgroundColor: !sending && draft.trim() ? theme.compass : theme.muted }]}
        >
          {/* One send affordance in every state, muted when it cannot fire. The
              disabled state used to swap in a microphone, which reads as the
              voice note this screen cannot record — the same broken promise as
              the inert add glyph above. */}
          <Ionicons name="arrow-up" size={20} color={!sending && draft.trim() ? theme.compassForeground : theme.mutedForeground} />
        </Pressable>
      </View>
      </>}
      {sendError ? <Notice>{catalogLabel(sendError)}</Notice> : null}
      {sendNotice ? <Notice>{sendNotice}</Notice> : null}
      {actionNotice ? <Notice>{actionNotice}</Notice> : null}
      {remindHereOn && !closed ? <Body muted>{t("To remind this channel's staff, type /remind here, a time like tomorrow 9am, then your note.")}</Body> : null}
      <Body muted>{mode === 'preview' ? t('PREVIEW campaign activity stays in this demo session.') : t('The channels you see depend on your current role and campaign.')}</Body>
      </View>
    </Screen>
  );
}

// The top of a thread whose newest window was full: earlier posts to open, the
// loading and failure states, or the start of the thread. The button keeps one
// place in the tree through its busy state, so focus stays on it.
function EarlierChannelHistory({ status, hasEarlier, started, lastLoaded, onShowEarlier }: {
  status: 'idle' | 'loading' | 'error';
  hasEarlier: boolean;
  started: boolean;
  lastLoaded: number;
  onShowEarlier: () => void;
}) {
  const theme = useTheme();
  const copy = conversationHistoryCopy;
  return (
    <View style={styles.history}>
      {status === 'error' ? <Notice>{copy.failed}</Notice> : null}
      {hasEarlier ? (
        <Button
          label={status === 'error' ? copy.tryAgain : status === 'loading' ? copy.loadingEarlier : copy.showEarlier}
          variant="secondary"
          busy={status === 'loading'}
          onPress={onShowEarlier}
        />
      ) : (
        <Text accessibilityRole="text" style={[styles.historyNote, { color: theme.mutedForeground }]}>{channelHistoryStart}</Text>
      )}
      {started && status === 'idle' && lastLoaded > 0 ? (
        <Text accessibilityLiveRegion="polite" style={[styles.historyNote, { color: theme.mutedForeground }]}>{copy.loaded(lastLoaded)}</Text>
      ) : null}
    </View>
  );
}

const channelHistoryStart = 'This is the start of this channel.';

// The title stops growing at twice its size, so a long word still fits a line
// at the largest text sizes; its icon grows with it and stays on line one.
const TITLE_TEXT_CAP = 2;

function Heading2({ name, theme }: { name: string; theme: ReturnType<typeof useTheme> }) {
  // The navigation row uses a short Messages label. The full thread name
  // belongs here, with room to wrap; preserve a member-written # as written.
  const echo = useScreenNameAlreadySpoken(name);
  const { fontScale } = useWindowDimensions();
  const titleScale = Math.min(fontScale, TITLE_TEXT_CAP);
  if (echo.duplicate) return null;
  return (
    <View style={styles.titleRow}>
      <Ionicons name="pricetag-outline" size={Math.round(22 * titleScale)} color={theme.mutedForeground} style={{ marginTop: Math.round(5 * titleScale) }} accessibilityElementsHidden />
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={TITLE_TEXT_CAP}
        style={[styles.title, { color: theme.foreground }]}
      >{name}</Text>
    </View>
  );
}

// The private-channel marker: the lock and its words, read as one element. It
// stays when the channel's name moves to the title row beside Back, so a
// private channel never loses the lock it showed beside `#name`.
function PrivateChannelStatus({ label, theme }: { label: string; theme: ReturnType<typeof useTheme> }) {
  const { fontScale } = useWindowDimensions();
  const glyphScale = Math.min(fontScale, TITLE_TEXT_CAP);
  return (
    <View style={styles.privateRow} accessible accessibilityRole="text" accessibilityLabel={label}>
      <Ionicons name="lock-closed" size={Math.round(16 * glyphScale)} color={theme.mutedForeground} accessibilityElementsHidden importantForAccessibility="no" />
      <Text maxFontSizeMultiplier={TITLE_TEXT_CAP} style={[styles.privateLabel, { color: theme.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  channelContent: { gap: spacing.lg },
  header: { gap: spacing.xs },
  // A long name wraps inside the screen beside its icon instead of running
  // past the right edge; the icon stays on the first line.
  headerActions: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headerTitle: { flex: 1, minWidth: 0 },
  channelMenu: { gap: spacing.xs },
  mentionButton: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: 26, lineHeight: 32, ...typeface.heading, letterSpacing: -0.4 },
  privateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  privateLabel: { flexShrink: 1, fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  thread: { gap: spacing.lg },
  history: { gap: spacing.sm },
  historyNote: { fontSize: 13, lineHeight: 18, ...typeface.control, textAlign: 'center' },
  dayRow: { alignItems: 'center', paddingVertical: spacing.xs },
  dayChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  dayText: { fontSize: 12, lineHeight: 17, ...typeface.controlStrong },
  newDivider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  newLine: { flex: 1, height: 1 },
  newText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 1.2 },
  msgRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  msgBody: { flex: 1, gap: spacing.xs },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  author: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  roleChip: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  roleText: { fontSize: 10, lineHeight: 14, ...typeface.controlStrong, letterSpacing: 0.4 },
  time: { fontSize: 12, lineHeight: 16 },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, padding: spacing.sm, maxWidth: 280 },
  attachmentIcon: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  attachmentName: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  attachmentMeta: { fontSize: 11, lineHeight: 15 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 0, columnGap: spacing.sm },
  reactionPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingTop: spacing.xs },
  reactionChoice: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: radii.pill, minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, paddingHorizontal: spacing.sm },
  threadHint: { fontSize: 12.5, lineHeight: 17, ...typeface.controlStrong },
  mentionChip: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  composer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  input: { flex: 1, minWidth: 0, minHeight: minimumTouchTarget, fontSize: 15, paddingVertical: spacing.sm },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
});
