import { captureSessionWriter } from '../src/services/supabase';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../src/components/Text';

import { MessageWorkflowPicker } from '../src/components/MessageWorkflowPicker';
import { HighlightList, HighlightRow } from '../src/components/RowHighlight';
import { SupportLink } from '../src/components/SupportLink';
import { TaskDiscussionsSection } from '../src/components/TaskDiscussionsSection';
import { useResultCountAnnouncement } from '../src/features/useResultCountAnnouncement';
import { useTaskDiscussions } from '../src/features/useTaskDiscussions';
import { usePeerConversations } from '../src/features/usePeerConversations';
import { countWithTaskDiscussions, filterTaskDiscussions, taskDiscussionScope } from '../src/lib/taskDiscussions';
import { Avatar, Body, Button, Card, Heading, Notice, Screen, SearchField, StateMessage } from '../src/components/ui';
import { useChannelStore } from '../src/data/useChannels';
import { NativeAnnouncementToggle } from '../src/features/NativePlatformAnnouncements';
import { useChannelControls } from '../src/data/channelControls';
import { useWindowBottomInset } from '../src/lib/windowInsets';
import { explicitLiveStaffHat } from '../src/lib/hatFunctions';
import { screenBottomInset } from '../src/lib/chrome';
import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  MESSAGE_FILTERS,
  buildMessageInbox,
  countMessageFilters,
  filterMessageInbox,
  type MessageFilter,
  type MessageInboxItem,
} from '../src/lib/messageInbox';
import { inboxChannelLoadNotice, messageInboxCopy } from '../src/lib/messageInboxCopy';
import {
  findNativeStewardConversation,
  groupNativeMessageItems,
  messageWorkflowCopy,
  messageWorkflowDefault,
  type MessageWorkflow,
} from '../src/lib/messageWorkflow';
import { haptics } from '../src/services/haptics';
import {
  latestMessageWorkflowRequest,
  readMessageWorkflowOnboarded,
  readMessageWorkflowPreference,
  saveMessageWorkflowPreference,
  subscribeMessageWorkflowPreference,
} from '../src/services/messageWorkflowPreference';
import { startMemberConversation } from '../src/services/supabase';
import { nativeDirectAudience } from '../src/services/stewardDirectInbox';
import { stewardDirectPagesCopy, stewardDirectStaleAfterMs, useStewardDirectPages, type StewardDirectPages } from '../src/features/useStewardDirectPages';
import type { MemberConversation } from '../src/models/member';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';
import { NativeFeatureGuide } from '../src/features/guideLayers/GuideLayers';
import { useNativeUi } from '../src/lib/useNativeUi';

import { typeface } from '../src/theme/typeface';
import { useHeldScreenScope } from '../src/lib/heldScreenScope';
import { useRequestGeneration } from '../src/lib/useRequestGeneration';
const stewardDirectPagesSpanishCopy: typeof stewardDirectPagesCopy = {
  showOlder: 'Mostrar conversaciones anteriores',
  showMoreResults: 'Mostrar más conversaciones coincidentes',
  loadingOlder: 'Cargando conversaciones anteriores',
  searching: 'Buscando en todas las conversaciones de trabajadores',
  failed: 'No se cargaron las conversaciones anteriores. Las mostradas se conservan. Vuelva a intentarlo.',
  tryAgain: 'Reintentar',
  allShown: (count) => `Se muestran las ${count.toLocaleString('es-US')} conversaciones de trabajadores.`,
  allResults: 'Se muestran todas las coincidencias por nombre. El texto se busca solo en las conversaciones mostradas; cargue las anteriores para incluirlas.',
};

// Messages moved off the dock (Home, Work, Guide, Campaign, Account); it opens
// from All tools, Home, and notifications as a pushed screen.
export default function MessagesScreen() {
  return <PinnedHeaderScreen screenName="Messages"><MessagesScreenContent /></PinnedHeaderScreen>;
}

function MessagesScreenContent() {
  const actor = useApp();
  // Confirmed membership selection retires immediately, even without a dashboard or staff answer.
  const membership = useHeldScreenScope(actor.confirmedMembershipScope == null, [actor.session?.user.id], [actor.confirmedMembershipScope], true);
  const owner = useHeldScreenScope(actor.mode === 'booting' || (actor.mode === 'authenticated' && !actor.dashboard), [actor.session?.user.id, membership], [actor.mode, actor.dashboard?.member?.chapterID], true);
  const scope = useHeldScreenScope(actor.mode === 'booting' || (actor.mode === 'authenticated' && (!actor.dashboard || actor.staffScopeAvailable === false)), [owner], [actor.organizationID, actor.authorizedRoles, actor.organizationRoles, actor.chapterRoles, actor.sampleHat, actor.chosenStaffRole], true);
  return <MessagesContent key={scope} />;
}

function MessagesContent() {
  const { language, locale, t } = useNativeUi();
  const router = useRouter();
  const { setParams } = useNavigation<{ setParams: (params: { show: undefined }) => void }>();
  const theme = useTheme();
  const { dashboard, mode, session, previewHat, startPreviewConversation, authorizedRoles, organizationRoles, chapterRoles, error, refreshing, refresh, sampleHat, sharedDemoVisit, chosenStaffRole, organizationID, conversationPollIntervalMs, conversationPollConnected } = useApp();
  const insets = useSafeAreaInsets();
  const bottomInset = screenBottomInset(insets.bottom);
  const windowBottomInset = useWindowBottomInset();
  const focused = useIsFocused();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MessageFilter>('all');
  const [stewardLanding, setStewardLanding] = useState(false);
  // A task-message notification opens Messages with show=tasks: an old filter
  // or search could hide the task discussions, so both reset once and the
  // intent is cleared.
  const { show } = useLocalSearchParams<{ show?: string }>();
  useEffect(() => {
    if (show !== 'tasks') return;
    setFilter('all');
    setQuery('');
    router.setParams({ show: undefined });
    setStewardLanding(false);
  }, [router, show]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sends = useRequestGeneration('first-conversation');
  const sendingNow = useRef(false);
  const [workflow, setWorkflow] = useState<MessageWorkflow>(messageWorkflowDefault);
  const [onboardingChoice, setOnboardingChoice] = useState<MessageWorkflow>(messageWorkflowDefault);
  const [workflowOnboarded, setWorkflowOnboarded] = useState<boolean | null>(null);
  const [workflowSaveFailed, setWorkflowSaveFailed] = useState(false);
  const [workflowDismissed, setWorkflowDismissed] = useState(false);
  const [briefingExpanded, setBriefingExpanded] = useState(false);
  const [taskDiscussionsReload, setTaskDiscussionsReload] = useState(0);
  // The request number of the member's latest chooser press, and how many
  // chooser saves are still writing.
  const chooserRequest = useRef(0);
  const chooserPending = useRef(0);
  const store = useChannelStore();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const channelControls = useChannelControls().controls;
  const pinningOn = channelControls.switches.channelPinning;

  const directAudience = nativeDirectAudience({
    previewHat: mode === 'preview' ? previewHat : null,
    sampleHat: mode === 'authenticated' ? sampleHat : null,
    chosenStaffRole: mode === 'authenticated' ? chosenStaffRole : null,
    authorizedRoles: mode === 'authenticated' ? authorizedRoles : [],
  });
  const canKeepStewardLanding = focused && mode === 'authenticated';
  const dashboardReady = dashboard !== null;
  useEffect(() => {
    if (!canKeepStewardLanding) {
      setStewardLanding(false);
      // Use this route's navigation because the global router follows focus.
      if (show === 'steward') setParams({ show: undefined });
      return;
    }
    if (show !== 'steward' || !dashboardReady) return;
    const allowed = directAudience === 'steward';
    setStewardLanding(allowed);
    if (allowed && !stewardLanding) {
      setFilter('all');
      setQuery('');
    }
    setParams({ show: undefined });
  }, [canKeepStewardLanding, show, dashboardReady, directAudience, setParams, stewardLanding]);
  const stewardFirst = canKeepStewardLanding && stewardLanding && directAudience === 'steward';
  const userId = session?.user.id ?? null;
  const isStewardDirectRow = useCallback(
    (item: MessageInboxItem) => item.kind === 'direct' && !item.peer && item.ownerUserId !== userId,
    [userId],
  );
  // A worn steward hat reads Steward Direct in bounded pages; the dashboard
  // holds the first. A member keeps the owner-filtered dashboard rows.
  const stewardPages = useStewardDirectPages({
    enabled: mode === 'authenticated' && directAudience === 'steward',
    scopeKey: JSON.stringify([session?.user.id ?? null, organizationID ?? null, dashboard?.member?.chapterID ?? null, directAudience, sampleHat ?? null, chosenStaffRole ?? null, authorizedRoles ?? null, organizationRoles ?? null, chapterRoles ?? null]),
    firstPage: dashboard?.conversations ?? NO_CONVERSATIONS,
    query,
    // An older row not read again within two summary polls leaves the screen.
    staleAfterMs: stewardDirectStaleAfterMs(conversationPollIntervalMs),
  });
  const conversations = stewardPages.conversations;
  const stewardConversation = findNativeStewardConversation(conversations);
  const copy = messageInboxCopy[language];
  const workflowCopy = messageWorkflowCopy[language];
  // A fresh array each render: the live store updates a row's unread count in
  // place, and the inbox below must rebuild when it does.
  const channels = store.channels().filter((channel) => mode !== 'preview' || previewHat !== 'member' || !channel.locked);
  // Private two-person conversations (a member writing to an officer, and
  // every other pair), listed as the website lists them (#9162). They belong
  // to the account under every hat and to the selected chapter's scope.
  const peerConversations = usePeerConversations(
    mode === 'authenticated' ? taskDiscussionScope(session?.user.id, organizationID, dashboard?.member?.chapterID) : null,
    taskDiscussionsReload,
    conversationPollIntervalMs,
    conversationPollConnected !== false,
  );
  const inboxItems = useMemo(
    () => buildMessageInbox(conversations, channels, copy, locale, pinningOn, peerConversations.items),
    [channels, conversations, copy, locale, pinningOn, peerConversations.items],
  );
  // Task discussions are neither direct nor channel rows: they show under All,
  // count toward All and the search result, and keep the empty state away when
  // they match. Their list belongs to the selected chapter (taskDiscussionScope).
  const taskDiscussions = useTaskDiscussions(
    mode === 'authenticated' ? taskDiscussionScope(session?.user.id, organizationID, dashboard?.member?.chapterID) : null,
    taskDiscussionsReload,
    conversationPollIntervalMs,
    // The conversation poller's own network signal: no task-discussion poll
    // while the device is offline.
    conversationPollConnected !== false,
  );
  const filterCounts = useMemo(
    () => countWithTaskDiscussions(countMessageFilters(inboxItems), taskDiscussions.items.length),
    [inboxItems, taskDiscussions.items.length],
  );
  const visibleItems = useMemo(
    () => filterMessageInbox(inboxItems, filter, query, locale),
    [filter, inboxItems, locale, query],
  );
  const stewardRecentItems = stewardFirst ? inboxItems.filter(isStewardDirectRow) : [];
  const recentItems = stewardRecentItems.length > 0 ? stewardRecentItems : inboxItems;
  const workflowGroups = useMemo(() => {
    if (!stewardFirst) return groupNativeMessageItems(visibleItems, workflow);
    const direct = visibleItems.filter(isStewardDirectRow);
    const groups = groupNativeMessageItems(visibleItems.filter((item) => !isStewardDirectRow(item)), workflow);
    const stewardGroup: { key: 'steward-direct'; items: MessageInboxItem[] } = { key: 'steward-direct', items: direct };
    return direct.length > 0 ? [stewardGroup, ...groups] : groups;
  }, [stewardFirst, visibleItems, workflow, isStewardDirectRow]);
  const hasStewardDirectGroup = workflowGroups[0]?.key === 'steward-direct';
  const shownTaskDiscussions = useMemo(
    () => (filter === 'all' ? filterTaskDiscussions(taskDiscussions.items, query, locale) : []),
    [filter, locale, query, taskDiscussions.items],
  );
  const resultCount = visibleItems.length + shownTaskDiscussions.length;
  const unreadBriefingCount = inboxItems.filter((item) => item.unread > 0).length;
  const waitingBriefingCount = inboxItems.filter((item) => item.kind === 'direct' && item.unread === 0).length;
  const staffBriefingHat = mode === 'preview'
    ? previewHat && previewHat !== 'member' ? previewHat : null
    : directAudience === 'steward'
      ? 'steward'
      : mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;
  const channelsLoading = mode === 'authenticated' && (store.status() === 'idle' || store.status() === 'loading');
  const channelsError = mode === 'authenticated'
    ? inboxChannelLoadNotice(copy, store.loadFault(), store.status() === 'error')
    : null;

  useEffect(() => {
    let active = true;
    void Promise.all([readMessageWorkflowPreference(session?.user.id), readMessageWorkflowOnboarded(session?.user.id)])
      .then(([savedWorkflow, onboarded]) => {
        if (!active) return;
        setWorkflow(savedWorkflow);
        setOnboardingChoice(savedWorkflow);
        setWorkflowOnboarded(onboarded);
      })
      .catch(() => { if (active) setWorkflowOnboarded(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeMessageWorkflowPreference((savedWorkflow, request) => {
      applySavedWorkflow(savedWorkflow, request, () => active);
    }, session?.user.id);
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!staffBriefingHat) return;
    setComposerOpen(false);
    setDraft('');
    setSendError(null);
  }, [staffBriefingHat]);

  // The count is spoken after the member's own filter or search change, never
  // when a background refresh moves it.
  const resultCountLiveRegion = useResultCountAnnouncement(JSON.stringify([filter, query]), copy.resultCount(resultCount));

  // A saved workflow (from this chooser, Account or a retry) is shown unless
  // it is older than the member's latest chooser press. A preference can
  // persist while its onboarding marker write fails, so only a confirmed
  // marker may dismiss the chooser, only for the newest requested save, and
  // never while a chooser save is still writing.
  function applySavedWorkflow(savedWorkflow: MessageWorkflow, request: number, isActive: () => boolean) {
    if (request < chooserRequest.current) return;
    setWorkflow(savedWorkflow);
    setOnboardingChoice(savedWorkflow);
    void readMessageWorkflowOnboarded(session?.user.id)
      .then((onboarded) => {
        if (isActive() && onboarded && chooserPending.current === 0 && request === latestMessageWorkflowRequest(session?.user.id)) setWorkflowOnboarded(true);
      })
      .catch(() => undefined);
  }

  // Every Use or Skip press is queued at once, so presses and Account saves
  // are written in the order the member made them. The save rejects when the
  // onboarding marker write fails, so the chooser stays on screen until the
  // marker is durable; an explicitly unsaved dismissal remains available on failure.
  // A new save clears an earlier failure as it starts, so a Skip, Android
  // Back or accessibility escape during it is queued after it, never a local
  // dismissal the save then overturns.
  async function commitChooserChoice(value: MessageWorkflow) {
    setWorkflowSaveFailed(false);
    setWorkflow(value);
    setOnboardingChoice(value);
    const saving = saveMessageWorkflowPreference(value, session?.user.id);
    const request = latestMessageWorkflowRequest(session?.user.id);
    chooserRequest.current = request;
    chooserPending.current += 1;
    const saved = await saving.then(() => true, () => false);
    chooserPending.current -= 1;
    if (chooserRequest.current !== request) return;
    setWorkflowSaveFailed(!saved);
    if (saved) setWorkflowOnboarded(true);
  }

  async function chooseWorkflow(value: MessageWorkflow) {
    await commitChooserChoice(value);
  }

  async function skipWorkflowOnboarding() {
    // A failed phone store must never trap someone behind a modal. This is
    // only a local dismissal: the missing marker asks again next launch.
    if (workflowSaveFailed) {
      setWorkflow(messageWorkflowDefault);
      setOnboardingChoice(messageWorkflowDefault);
      setWorkflowDismissed(true);
      return;
    }
    await commitChooserChoice(messageWorkflowDefault);
  }

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  // D5-3: a restricted PIN session sees the step-up instead (the server already refuses it).
  if (!dashboard) {
    // BUG-UG-NATIVE-MESSAGES-ACTIVITY-LOADING-FOREVER-20261018: a
    // failed workspace load used to keep the loading copy on screen with no
    // way out. AppProvider records the failure in `error`; this mirrors Home
    // and WorkScreen: say it failed, offer Try again, and let pull-to-refresh
    // retry too. The recovery controls only work once bootstrap has finished
    // (refresh() needs an established session), so they stay hidden while
    // booting instead of rendering as dead controls.
    const canRecover = mode !== 'booting';
    const retry = () => { void refresh('user-refresh'); };
    return (
      <Screen bottomInset={bottomInset} refreshing={canRecover ? refreshing : undefined} onRefresh={canRecover ? retry : undefined}>
        <StateMessage
          title={error ? copy.loadFailedTitle : copy.loadingTitle}
          body={error ?? copy.loadingBody}
          action={error && canRecover
            ? <Button label={copy.tryAgain} variant="secondary" disabled={refreshing} busy={refreshing} onPress={retry} />
            : null}
        />
      </Screen>
    );
  }

  async function beginConversation() {
    if (staffBriefingHat) return;
    if ((mode !== 'authenticated' && mode !== 'preview') || (mode === 'authenticated' && !session) || sendingNow.current) return;
    const cleanDraft = draft.trim();
    if (!cleanDraft) {
      setSendError(copy.composerEmptyError);
      return;
    }
    setBusy(true);
    sendingNow.current = true;
    setSendError(null);
    const ticket = sends.begin();
    const writer = captureSessionWriter(session);
    try {
      const id = mode === 'preview' ? startPreviewConversation(cleanDraft) : await startMemberConversation(writer, cleanDraft);
      if (!id) throw new Error('unavailable');
      if (!ticket.isCurrent()) return;
      // Retire this owner's accepted draft even when the later Auth proof is
      // unavailable. That proof gates refresh/navigation, never acceptance.
      setDraft('');
      setComposerOpen(false);
      if (mode !== 'preview') {
        const current = await writer.isCurrent();
        if (!ticket.isCurrent() || !current) return;
        void haptics.success();
        // The start is already accepted. A failed inbox read cannot turn it
        // back into a retryable first message.
        await refresh().catch(() => undefined);
        const stillCurrent = await writer.isCurrent();
        if (!ticket.isCurrent() || !stillCurrent) return;
      }
      router.replace(`/conversation/${id}` as never);
    } catch {
      const proof = await writer.check();
      if (!ticket.isCurrent() || proof === 'changed') return;
      setSendError(copy.composerError);
      void haptics.warning();
    } finally {
      if (ticket.isCurrent()) { sendingNow.current = false; setBusy(false); }
    }
  }

  async function reloadMessages() {
    setTaskDiscussionsReload((value) => value + 1);
    await Promise.all([refresh(), store.refresh()]);
  }

  function openSteward() {
    // Keep the CTA's recipient promise exact. If the canonical steward thread
    // is absent, open the backed composer instead of falling through to an
    // unrelated first conversation.
    if (stewardConversation) {
      void haptics.select();
      router.push(`/conversation/${stewardConversation.id}` as never);
      return;
    }
    setSendError(null);
    setComposerOpen(true);
  }

  function openItem(item: MessageInboxItem) {
    void haptics.select();
    router.push(item.peer
      ? `/peer-conversation/${item.id}` as never
      : item.kind === 'direct'
        ? `/conversation/${item.id}` as never
        : `/channel/${item.id}` as never);
  }

  const hasActiveQuery = query.trim().length > 0;
  const taskSection = mode === 'authenticated' && filter === 'all'
    ? <TaskDiscussionsSection items={shownTaskDiscussions} failed={taskDiscussions.failed} /> : null;

  return (
    <Screen bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void reloadMessages(); }}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerCopy}>
            <Text
              accessibilityRole="header"
              adjustsFontSizeToFit
              minimumFontScale={0.5}
              numberOfLines={1}
              style={[styles.title, { color: theme.foreground }]}
            >
              {copy.title}
            </Text>
            <Text style={[styles.subtitle, { color: theme.mutedForeground }]}>{copy.subtitle}</Text>
          </View>
          {!staffBriefingHat ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={stewardConversation ? copy.messageSteward : copy.composerTitle}
              onPress={openSteward}
              style={({ pressed }) => [styles.composeButton, { backgroundColor: theme.primary, opacity: pressed ? 0.82 : 1 }]}
            >
              <Ionicons name="create-outline" size={22} color={theme.primaryForeground} />
            </Pressable>
          ) : null}
        </View>
        {mode === 'authenticated' ? (
          <View style={styles.shortcuts}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Reminders')}
              onPress={() => router.push('/reminders' as never)}
              style={[styles.shortcut, { backgroundColor: theme.secondary, borderColor: theme.border }]}>
              <Text style={[styles.shortcutLabel, { color: theme.secondaryForeground }]}>{t('Reminders')}</Text>
            </Pressable>
            {channelControls.switches.mentionSearch ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t('Your mentions')}
                onPress={() => router.push('/mentions' as never)}
                style={[styles.shortcut, { backgroundColor: theme.secondary, borderColor: theme.border }]}>
                <Text style={[styles.shortcutLabel, { color: theme.secondaryForeground }]}>{t('Your mentions')}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <SearchField value={query} onChangeText={setQuery} placeholder={copy.search} accessibilityLabel={Platform.OS === 'ios' ? undefined : copy.search} />
      </View>

      {!sharedDemoVisit && workflowOnboarded === false ? (
        <Modal transparent visible={focused && !workflowDismissed} animationType="slide" onRequestClose={() => { void skipWorkflowOnboarding(); }}>
          {/* BUG-UG-NATIVE-MESSAGES-ORGANIZE-SHEET-CUTS-OFF-BUTTONS-AND-HAS-NO-CLOSE-20261122:
              the two actions sit below the scrolling choices, so they are
              always whole and never scrolled past unseen; the sheet pads the
              window's live bottom safe area (src/lib/windowInsets.ts); and the
              close control and a tap outside the sheet both do what Skip does. */}
          <View style={styles.onboardingBackdrop}>
            <Pressable testID="messages-organize-scrim" accessibilityRole="button" accessibilityLabel={workflowCopy.close} onPress={() => { void skipWorkflowOnboarding(); }} style={styles.onboardingScrim} />
            <View testID="messages-organize-sheet" accessibilityViewIsModal onAccessibilityEscape={() => { void skipWorkflowOnboarding(); }} style={[styles.onboardingSheet, { backgroundColor: theme.card, paddingBottom: windowBottomInset + spacing.md }]}>
              <View style={styles.onboardingHead}>
                <Text style={[styles.onboardingEyebrow, styles.onboardingHeadText, { color: theme.primary }]}>{workflowCopy.onboardingEyebrow}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={workflowCopy.close} onPress={() => { void skipWorkflowOnboarding(); }} style={styles.onboardingClose}>
                  <Ionicons name="close" size={22} color={theme.foreground} />
                </Pressable>
              </View>
              <ScrollView style={styles.onboardingScroll} contentContainerStyle={styles.onboardingBody} showsVerticalScrollIndicator persistentScrollbar>
                <Heading level={2}>{workflowCopy.onboardingTitle}</Heading>
                <Body muted>{workflowCopy.onboardingBody}</Body>
                <MessageWorkflowPicker language={language} value={onboardingChoice} onChange={setOnboardingChoice} compact />
                <Body muted>{workflowCopy.proLabel}: {workflowCopy.workflow[onboardingChoice].pro}</Body>
                <Body muted>{workflowCopy.conLabel}: {workflowCopy.workflow[onboardingChoice].con}</Body>
                {workflowSaveFailed ? <View accessibilityLiveRegion="polite"><Body>{workflowCopy.saveFailed}</Body></View> : null}
              </ScrollView>
              <View style={styles.onboardingActions}>
                <Button label={workflowCopy.useChoice} maxFontSizeMultiplier={ONBOARDING_ACTION_TEXT_CAP} onPress={() => { void chooseWorkflow(onboardingChoice); }} />
                <Button label={workflowCopy.skip} variant="secondary" maxFontSizeMultiplier={ONBOARDING_ACTION_TEXT_CAP} onPress={() => { void skipWorkflowOnboarding(); }} />
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

      {recentItems.length > 0 ? (
        <View style={styles.recentSection}>
          <Text style={[styles.sectionEyebrow, { color: theme.mutedForeground }]}>{t('RECENT')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.recentRow}>
            {recentItems.slice(0, 5).map((item) => (
              <Pressable
                key={`recent-${item.key}`}
                accessibilityRole="button"
                accessibilityLabel={`${item.accessibilityTitle ?? item.title}, ${item.preview}${item.unread ? `, ${copy.unreadCount(item.unread)}` : ''}`}
                onPress={() => openItem(item)}
                style={({ pressed }) => [styles.recentPerson, { opacity: pressed ? 0.72 : 1 }]}
              >
                <View>
                  {item.kind === 'direct' ? <Avatar initials={item.initials ?? '·'} size={52} /> : (
                    <View style={[styles.recentChannel, { backgroundColor: theme.secondary }]}>
                      <Text style={[styles.hash, { color: theme.secondaryForeground }]}>#</Text>
                    </View>
                  )}
                  {item.unread > 0 ? <View style={[styles.recentUnread, { backgroundColor: theme.primary }]} /> : null}
                </View>
                <Text numberOfLines={1} style={[styles.recentName, { color: theme.foreground }]}>{item.title.replace(/^#\s*/, '')}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {!staffBriefingHat ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.messageSteward}
          onPress={openSteward}
          style={({ pressed }) => [styles.stewardAction, { borderColor: theme.border, backgroundColor: pressed ? theme.muted : theme.card }]}
        >
          <View style={[styles.stewardIcon, { backgroundColor: theme.secondary }]}>
            <Ionicons name="chatbubble-ellipses" size={18} color={theme.secondaryForeground} />
          </View>
          <View style={styles.stewardCopy}>
            <Text style={[styles.stewardActionText, { color: theme.foreground }]}>{copy.messageSteward}</Text>
            <Text style={[styles.stewardHint, { color: theme.mutedForeground }]}>{copy.privateConversation}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} />
        </Pressable>
      ) : null}

      {/* #9162 part 2: the website's Write to an officer. The server lists who
          this member may write to; the screen opens the private conversation. */}
      {mode === 'authenticated' && !staffBriefingHat ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Write to an officer')}
          accessibilityHint={t('Only you and the officer you choose can read it')}
          onPress={() => { void haptics.select(); router.push('/officer-contact' as never); }}
          style={({ pressed }) => [styles.stewardAction, { borderColor: theme.border, backgroundColor: pressed ? theme.muted : theme.card }]}
        >
          <View style={[styles.stewardIcon, { backgroundColor: theme.secondary }]}>
            <Ionicons name="person-circle-outline" size={20} color={theme.secondaryForeground} />
          </View>
          <View style={styles.stewardCopy}>
            <Text style={[styles.stewardActionText, { color: theme.foreground }]}>{t('Write to an officer')}</Text>
            <Text style={[styles.stewardHint, { color: theme.mutedForeground }]}>{t('Only you and the officer you choose can read it')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} />
        </Pressable>
      ) : null}

      {composerOpen && !staffBriefingHat ? (
        <Card>
          <View style={styles.composerHead}>
            <View style={styles.composerTitle}>
              <Heading level={2}>{copy.composerTitle}</Heading>
              <Body muted>{copy.composerBody}</Body>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.composerClose}
              onPress={() => { setComposerOpen(false); setSendError(null); }}
              style={styles.closeComposer}
            >
              <Ionicons name="close" size={20} color={theme.foreground} />
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel={copy.composerLabel}
            autoFocus
            multiline
            maxLength={4_000}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={draft}
            onChangeText={setDraft}
            placeholder={copy.composerPlaceholder}
            placeholderTextColor={theme.quietForeground}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <View style={styles.composerRow}>
            <Text style={[styles.counter, { color: theme.mutedForeground }]}>{draft.length}/4,000</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? copy.composerSending : copy.composerSend}
              accessibilityState={{ disabled: busy || !draft.trim() }}
              disabled={busy || !draft.trim()}
              onPress={() => { void beginConversation(); }}
              style={({ pressed }) => [styles.send, { backgroundColor: busy || !draft.trim() ? theme.muted : theme.primary, opacity: pressed && !busy ? 0.82 : 1 }]}
            >
              <Ionicons name="arrow-up" size={22} color={busy || !draft.trim() ? theme.mutedForeground : theme.primaryForeground} />
            </Pressable>
          </View>
          {sendError ? <Notice>{sendError}</Notice> : null}
        </Card>
      ) : null}

      <View style={styles.filterSection}>
        <Text style={[styles.filterLabel, { color: theme.mutedForeground }]}>{copy.filterInbox}</Text>
        {/* The four filters wrap instead of scrolling, so "Channels" is never
            cut off at a 390 px edge with no scroll cue (audit MOB-ADVISOR-01,
            MOB-VP-01, MOB-COORDINATOR-01). */}
        <View
          style={styles.filterRow}
          accessibilityRole="tablist"
          accessibilityLabel={copy.filterMessages}
        >
          {MESSAGE_FILTERS.map((key) => {
            const selected = filter === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={copy.filters[key]}
                accessibilityValue={{ text: copy.filterCount(key, copy.filters[key], filterCounts[key], selected) }}
                accessibilityState={{ selected }}
                onPress={() => setFilter(key)}
                style={({ pressed }) => [
                  styles.filter,
                  {
                    backgroundColor: selected ? theme.primary : theme.secondary,
                    borderColor: selected ? theme.primary : theme.border,
                    opacity: pressed ? 0.82 : 1,
                  },
                ]}
              >
                <Text style={[styles.filterText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{copy.filters[key]}</Text>
                <View style={[styles.filterCount, { backgroundColor: selected ? theme.primaryForeground : theme.card }]}>
                  <Text maxFontSizeMultiplier={1.4} style={[styles.filterCountText, { color: selected ? theme.primary : theme.foreground }]}>{filterCounts[key]}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      <NativeAnnouncementToggle query={query} />
      {!hasStewardDirectGroup ? taskSection : null}
      {mode === 'authenticated' && peerConversations.failed && peerConversations.items.length === 0 ? <Body muted>{t('Private worker conversations could not load. Pull down to try again.')}</Body> : null}
      {channelsLoading ? <Body muted>{copy.checkingChannels}</Body> : null}
      {channelsError ? <Notice>{channelsError}</Notice> : null}

      {staffBriefingHat ? (
        <View style={[styles.briefing, { borderColor: theme.border, backgroundColor: theme.card }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={briefingExpanded ? workflowCopy.briefing.collapse : workflowCopy.briefing.expand}
            accessibilityState={{ expanded: briefingExpanded }}
            onPress={() => setBriefingExpanded((value) => !value)}
            style={({ pressed }) => [styles.briefingToggle, { backgroundColor: pressed ? theme.muted : theme.card }]}
          >
            <View style={styles.briefingTitleCopy}>
              <Text style={[styles.briefingTitle, { color: theme.foreground }]}>{workflowCopy.briefing.title}</Text>
              <Text style={[styles.briefingHint, { color: theme.mutedForeground }]}>{workflowCopy.briefing.body}</Text>
            </View>
            <Ionicons name={briefingExpanded ? 'remove' : 'add'} size={24} color={theme.foreground} />
          </Pressable>
          {briefingExpanded ? <View style={[styles.briefingBody, { borderTopColor: theme.border }]}>
            <BriefingRow title={workflowCopy.briefing.changed} body={workflowCopy.briefing.changedValue(inboxItems.length)} />
            <BriefingRow title={workflowCopy.briefing.needsYou} body={workflowCopy.briefing.needsYouValue(unreadBriefingCount)} />
            <BriefingRow title={workflowCopy.briefing.waiting} body={workflowCopy.briefing.waitingValue(waitingBriefingCount)} />
            <BriefingRow title={workflowCopy.briefing.delivery} body={workflowCopy.briefing.deliveryValue} />
          </View> : null}
        </View>
      ) : null}

      <View style={styles.feedHead}>
        <View style={styles.feedTitleCopy}>
          <Heading level={2}>{copy.inbox}</Heading>
          <Body muted>{copy.newestFirst}</Body>
        </View>
        <Text accessibilityLiveRegion={resultCountLiveRegion} style={[styles.resultCount, { color: theme.mutedForeground }]}>{copy.resultCount(resultCount)}</Text>
      </View>

      {visibleItems.length > 0 ? (
        <View style={[styles.inboxList, { borderColor: theme.border }]}>
          {workflowGroups.map((group) => (
            <HighlightList key={group.key}>
              <Text accessibilityRole="header" style={[styles.groupTitle, { color: theme.mutedForeground }]}>
                {group.key === 'steward-direct' ? t('Committee messages') : workflowCopy.groups[group.key]}
              </Text>
              {group.items.map((item, index) => (
                <HighlightRow key={item.key}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${item.accessibilityTitle ?? item.title}, ${item.meta}, ${item.preview}${item.unread ? `, ${copy.unreadCount(item.unread)}` : ''}`}
                    onPress={() => openItem(item)}
                    style={[
                      styles.inboxPressable,
                      index > 0 ? { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth } : null,
                    ]}
                  >
                    <View style={styles.inboxRow}>
                      <View>
                        {item.kind === 'direct' ? <Avatar initials={item.initials ?? '·'} size={52} /> : (
                          <View style={[styles.channelMark, { backgroundColor: theme.secondary }]}><Text style={[styles.hash, { color: theme.secondaryForeground }]}>#</Text></View>
                        )}
                      </View>
                      <View style={styles.rowCopy}>
                        <View style={styles.rowTop}>
                          <Text numberOfLines={2} style={[styles.rowTitle, { color: theme.foreground, fontWeight: item.unread ? '800' : '700' }]}>{item.title}</Text>
                          <Text maxFontSizeMultiplier={1.4} style={[styles.time, { color: item.unread ? theme.primary : theme.mutedForeground }]}>{formatInboxTime(item, locale)}</Text>
                        </View>
                        <Text numberOfLines={1} style={[styles.preview, { color: item.unread ? theme.foreground : theme.mutedForeground, fontWeight: item.unread ? '600' : '400' }]}>{item.preview}</Text>
                        <View style={styles.rowMetaLine}>
                          <Text numberOfLines={1} style={[styles.meta, { color: theme.mutedForeground }]}>{item.meta}</Text>
                          {item.unread > 0 ? <View style={[styles.badge, { backgroundColor: theme.primary }]}><Text maxFontSizeMultiplier={1.4} style={[styles.badgeText, { color: theme.primaryForeground }]}>{item.unread}</Text></View> : null}
                        </View>
                      </View>
                    </View>
                  </Pressable>
                </HighlightRow>
              ))}
            </HighlightList>
          ))}
        </View>
      ) : shownTaskDiscussions.length > 0 ? null : (
        <Card style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.secondary }]}>
            <Ionicons accessible={false} name={filter === 'unread' ? 'checkmark' : 'search'} size={22} color={theme.secondaryForeground} />
          </View>
          <Heading level={2}>{hasActiveQuery ? copy.noSearchTitle : filter === 'unread' ? copy.caughtUpTitle : copy.noKindTitle(copy.filters[filter])}</Heading>
          <Body muted>{hasActiveQuery ? copy.noSearchBody : copy.noMessagesBody}</Body>
          {(filter !== 'all' || hasActiveQuery) ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => { setFilter('all'); setQuery(''); }}
              style={[styles.resetAction, { borderColor: theme.border, backgroundColor: theme.secondary }]}
            >
              <Text style={[styles.resetActionText, { color: theme.secondaryForeground }]}>{copy.showAll}</Text>
            </Pressable>
          ) : null}
        </Card>
      )}
      {mode === 'authenticated' && directAudience === 'steward' ? <StewardDirectPagesFooter pages={stewardPages} loadedCount={conversations.length} /> : null}
      {hasStewardDirectGroup ? taskSection : null}
      <NativeFeatureGuide feature="messages" />
    </Screen>
  );
}

const NO_CONVERSATIONS: readonly MemberConversation[] = [];

// The continuation, loading, failure and end states of the Steward Direct
// list. A failed page keeps every loaded row and offers the same request again.
function StewardDirectPagesFooter({ pages, loadedCount }: { pages: StewardDirectPages; loadedCount: number }) {
  const { language } = useNativeUi();
  const copy = language === 'es' ? stewardDirectPagesSpanishCopy : stewardDirectPagesCopy;
  if (pages.status === 'error') {
    return (
      <View style={styles.pagesFooter}>
        <Notice>{copy.failed}</Notice>
        <Button label={copy.tryAgain} variant="secondary" onPress={pages.loadMore} />
      </View>
    );
  }
  if (pages.status === 'loading') {
    return (
      <View style={styles.pagesFooter}>
        <Button label={pages.searching ? copy.searching : copy.loadingOlder} variant="secondary" busy onPress={pages.loadMore} />
      </View>
    );
  }
  if (pages.hasMore) {
    return (
      <View style={styles.pagesFooter}>
        <Button label={pages.searching ? copy.showMoreResults : copy.showOlder} variant="secondary" onPress={pages.loadMore} />
      </View>
    );
  }
  if (!pages.ended || (loadedCount === 0 && !pages.searching)) return null;
  return (
    <View style={styles.pagesFooter}>
      <Body muted>{pages.searching ? copy.allResults : copy.allShown(loadedCount)}</Body>
      {/* A name search cannot see message text in conversations not yet
          opened, so older pages stay one press away during a search. */}
      {pages.searching && pages.olderHasMore ? (
        <Button
          label={pages.olderStatus === 'loading' ? copy.loadingOlder : pages.olderStatus === 'error' ? copy.tryAgain : copy.showOlder}
          variant="secondary"
          busy={pages.olderStatus === 'loading'}
          onPress={pages.loadOlder}
        />
      ) : null}
    </View>
  );
}

function BriefingRow({ title, body }: { title: string; body: string }) {
  const theme = useTheme();
  return <View style={styles.briefingRow}><Text style={[styles.briefingRowTitle, { color: theme.foreground }]}>{title}</Text><Text style={[styles.briefingRowBody, { color: theme.mutedForeground }]}>{body}</Text></View>;
}

function formatInboxTime(item: MessageInboxItem, locale: string): string {
  if (!item.timestamp) return item.fallbackTime;
  const date = new Date(item.timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

// The organize sheet's two actions grow with the text size up to this, as
// most of the app's controls do, so the longest word still fits its line.
const ONBOARDING_ACTION_TEXT_CAP = 2;

const styles = StyleSheet.create({
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  shortcut: { minHeight: minimumTouchTarget, maxWidth: '100%', flexShrink: 1, justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth },
  shortcutLabel: { fontSize: 14, lineHeight: 20, ...typeface.controlStrong, flexShrink: 1 },
  header: { gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerCopy: { flex: 1, gap: 2 },
  title: { fontSize: 34, lineHeight: 40, ...typeface.heading, letterSpacing: -0.8 },
  subtitle: { fontSize: 14, lineHeight: 19, ...typeface.bodyMedium },
  composeButton: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  onboardingEyebrow: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 0.7, textTransform: 'uppercase' },
  onboardingBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,6,14,0.45)' },
  onboardingScrim: { flex: 1 },
  onboardingSheet: { maxHeight: '85%', borderTopLeftRadius: radii.sheetRadius, borderTopRightRadius: radii.sheetRadius, padding: spacing.md, gap: spacing.sm },
  onboardingHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  onboardingHeadText: { flex: 1 },
  onboardingClose: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
  // Shrinks first, so the sheet never pushes its actions off the screen.
  onboardingScroll: { flexGrow: 0, flexShrink: 1 },
  onboardingBody: { gap: spacing.sm },
  // Full-width and stacked: each label has the sheet's width, so a word never
  // breaks inside itself at the largest text size, in English or Spanish.
  onboardingActions: { gap: spacing.sm },
  recentSection: { gap: spacing.sm },
  sectionEyebrow: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 0.8 },
  recentRow: { gap: spacing.md, paddingRight: spacing.lg },
  recentPerson: { width: 62, minHeight: 82, alignItems: 'center', gap: spacing.xs },
  recentChannel: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  recentName: { width: 62, textAlign: 'center', fontSize: 12, lineHeight: 16, ...typeface.control },
  recentUnread: { position: 'absolute', top: -1, right: -1, width: 12, height: 12, borderRadius: 6 },
  stewardAction: { minHeight: 64, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stewardIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  stewardCopy: { flex: 1, gap: 1 },
  stewardActionText: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  stewardHint: { fontSize: 12, lineHeight: 16, ...typeface.bodyMedium },
  composerHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  composerTitle: { flex: 1, gap: spacing.xs },
  closeComposer: { width: minimumTouchTarget, height: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 132, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, fontSize: 16, lineHeight: 23, textAlignVertical: 'top' },
  composerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  counter: { fontSize: 12, lineHeight: 16 },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  filterSection: { gap: spacing.xs },
  filterLabel: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filter: { minHeight: minimumTouchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filterText: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong },
  filterCount: { minWidth: 24, minHeight: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs, paddingVertical: 2 },
  filterCountText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  briefing: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg },
  briefingToggle: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  briefingTitleCopy: { flex: 1, gap: 2 },
  briefingTitle: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  briefingHint: { fontSize: 12, lineHeight: 17 },
  briefingBody: { borderTopWidth: StyleSheet.hairlineWidth },
  briefingRow: { minHeight: 70, gap: 3, padding: spacing.md },
  briefingRowTitle: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  briefingRowBody: { fontSize: 13, lineHeight: 18 },
  feedHead: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md },
  feedTitleCopy: { flex: 1, gap: 1 },
  resultCount: { fontSize: 12, lineHeight: 16, paddingBottom: 2 },
  inboxList: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  groupTitle: { paddingTop: spacing.md, paddingBottom: spacing.sm, fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 0.8, textTransform: 'uppercase' },
  inboxPressable: { minHeight: 84, paddingVertical: spacing.md },
  inboxRow: { minHeight: 60, flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  channelMark: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  hash: { fontSize: 20, lineHeight: 24, ...typeface.controlStrong },
  rowCopy: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  rowTitle: { flex: 1, fontSize: 16.5, lineHeight: 22, ...typeface.controlStrong },
  time: { flexShrink: 0, fontSize: 12, lineHeight: 16 },
  preview: { fontSize: 14.5, lineHeight: 20 },
  rowMetaLine: { minHeight: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  meta: { flex: 1, fontSize: 12, lineHeight: 16, ...typeface.bodyMedium },
  badge: { minWidth: 22, minHeight: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  emptyState: { alignItems: 'flex-start' },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  resetAction: { minHeight: minimumTouchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  resetActionText: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong },
  pagesFooter: { gap: spacing.sm, paddingTop: spacing.sm },
});
