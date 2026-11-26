import { captureSessionWriter } from '../../src/services/supabase';
import { Ionicons } from '@expo/vector-icons';
import { LiveChartMessage } from '../../src/features/SavedPulseCharts';
import { chartReference } from '../../src/lib/savedPulseCharts';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../../src/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PinnedHeaderScreen, usePinnedHeaderChrome, useScreenNameAlreadySpoken } from '../../src/components/PinnedHeader';
import { Avatar, Body, Button, Notice, Screen, StateMessage } from '../../src/components/ui';
import { WorkflowMessageActions } from '../../src/components/WorkflowActions';
import { contentStartInset } from '../../src/lib/chrome';
import { connectedStaffAccess } from '../../src/lib/connectedWorkflows';
import { AddReactionChip, MessageReactionButton, MessageReactionPicker } from '../../src/components/MessageReactions';
import { NativeMessageActions } from '../../src/components/NativeMessageActions';
import { MessageReplies, ParentMessageControl, ReplyCountControl, useMessageReplyCounts } from '../../src/components/MessageReplies';
import { messageActionRequest } from '../../../../src/features/messaging/actions.js';
import { reconcileOwnReactions } from '../../../../src/features/messaging/reactions.js';
import { haptics } from '../../src/services/haptics';
import { keyboardDismissModeFor } from '../../src/components/keyboardDismissGesture';
import type { MemberConversationThread } from '../../src/models/member';
import { loadConversationThread, loadEarlierConversationMessages, markConversationRead, reactToConversationMessage, sendMemberMessage, sendStewardReply } from '../../src/services/supabase';
import { conversationHistoryCopy, useConversationHistory, type ConversationHistory } from '../../src/features/useConversationHistory';
import { usePrependAnchor } from '../../src/features/prependAnchor';
import { nativeDirectAudience } from '../../src/services/stewardDirectInbox';
import { announceForAccessibility } from '../../src/lib/announce';
import { reconcileThreadResult } from '../../src/lib/conversationUnread';
import { isRedactedMessage, redactionReasonOf } from '../../src/lib/messagingShared';
import { useApp } from '../../src/state/AppProvider';
import { nativeCatalogLabel, type NativeUiText } from '../../src/lib/nativeUiCopy';
import { useNativeUi } from '../../src/lib/useNativeUi';
import { withReadDeadline } from '../../src/lib/readDeadline';
import { isReadRefusal } from '../../src/lib/readRefusal';
import { useHeldScreenScope } from '../../src/lib/heldScreenScope';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';
import { finishStaffGuide, liveStaffGuideHat } from '../../src/features/guideLayers/staffGuidesData';

import { typeface } from '../../src/theme/typeface';
export default function ConversationScreen() {
  const route = useLocalSearchParams<{ id?: string; message?: string; post?: string }>();
  const actor = useApp();
  const sourceKey = useHeldScreenScope(actor.mode === 'booting', [actor.session?.user.id, route.id, route.message, route.post], [actor.mode, actor.organizationID, actor.dashboard?.member.chapterID, actor.authorizedRoles, actor.previewHat, actor.confirmedMembershipScope]);
  const [titled, setTitled] = useState({ scope: sourceKey, title: 'Messages' });
  const setTitle = useCallback((title: string) => setTitled((previous) => previous.scope === sourceKey && previous.title === title ? previous : { scope: sourceKey, title }), [sourceKey]);
  const title = (actor.mode === 'authenticated' || actor.mode === 'preview') && titled.scope === sourceKey ? titled.title : 'Messages';
  const { mode } = useApp();
  return (
    <PinnedHeaderScreen title={mode === 'preview' ? undefined : title} screenName={title}>
      <ConversationContent key={sourceKey} onTitleChange={setTitle} />
    </PinnedHeaderScreen>
  );
}

function ConversationContent({ onTitleChange }: { onTitleChange: (title: string) => void }) {
  const { id, message } = useLocalSearchParams<{ id: string; message?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pinned = usePinnedHeaderChrome();
  const { mode, session, refresh, previewHat, previewThread, sendPreviewMessage, authorizedRoles, organizationRoles, chapterRoles, organizationID, dashboard, chosenStaffRole, sampleHat } = useApp();
  const writer = captureSessionWriter(session);
  // App-owned words follow the saved member language; message bodies, names
  // and the conversation title are shown as written.
  const { language, t, catalogLabel } = useNativeUi();
  const selectedMessageID = message;
  const userID = session?.user.id;
  const staffAccess = connectedStaffAccess({ mode, authorizedRoles, previewHat });
  const directAudience = nativeDirectAudience({
    previewHat: mode === 'preview' ? previewHat : null,
    sampleHat: mode === 'authenticated' ? sampleHat : null,
    chosenStaffRole: mode === 'authenticated' ? chosenStaffRole : null,
    authorizedRoles: mode === 'authenticated' ? authorizedRoles : [],
  });
  // The worn steward hat may open a member conversation with no record-link
  // message id. A cold record link still uses the existing staff check.
  const staffThreadRead = directAudience === 'steward' || (staffAccess && Boolean(selectedMessageID));
  const actorScope = JSON.stringify([userID, organizationID, dashboard?.member.chapterID, authorizedRoles, previewHat]);
  const messageOffset = useRef<number | null>(null);
  const messagesOffset = useRef(0);
  const [thread, setThread] = useState<MemberConversationThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A background refresh that failed or timed out after the thread loaded:
  // the loaded thread stays and a small notice says it was not updated.
  const [refreshStale, setRefreshStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [composeAction, setComposeAction] = useState<{ kind: 'reply' | 'edit'; id: string } | null>(null);
  const heldCompose = useRef(composeAction);
  heldCompose.current = composeAction;
  const [replyParent, setReplyParent] = useState<string | null>(null);
  const [replyRevision, setReplyRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [reacting, setReacting] = useState<string | null>(null);
  const [reactionError, setReactionError] = useState(false);
  const [reactionPicker, setReactionPicker] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const threadScrollRef = useRef<ScrollView>(null);
  const scope = useRef(0);
  useLayoutEffect(() => () => { scope.current += 1; }, []);
  const retireAuthoring = useCallback(() => {
    scope.current += 1;
    heldCompose.current = null;
    setDraft(''); setComposeAction(null); setReplyParent(null);
    setSending(false); setSendError(null);
    setReacting(null); setReactionError(false); setReactionPicker(null);
  }, []);
  const readVersion = useRef(0);
  // REQ-UG-NATIVE-MESSAGE-ACTIONS-20260904 (ANDROID5 findings 1 and 2,
  // 2026-09-26): the dashboard `refresh` callback takes a new identity on
  // every dashboard change, and this screen asks for one after each read
  // acknowledgement. Listing it as a dependency of the load effect made the
  // effect re-run, clear the thread and unmount every row in the ~4 s after a
  // reaction or a read; NativeMessageActions rows remounted with a fresh
  // generation, so a menu choice made in that window (save, remind, reply,
  // edit) was discarded without feedback and the "· Saved" footer reverted.
  // The latest callback is read through a ref instead, so a dashboard refresh
  // never restarts the conversation load.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // Earlier pages stay through every refresh of the newest page; the reader
  // scope and the staff read flag are part of the key, so a role or account
  // change keeps nothing from the previous reader.
  const history = useConversationHistory({
    scopeKey: JSON.stringify([id, message, mode, userID, actorScope, staffThreadRead, chosenStaffRole ?? null, sampleHat ?? null, organizationRoles ?? null, chapterRoles ?? null]),
    thread,
    load: (before) => (userID && id
      ? withReadDeadline(loadEarlierConversationMessages(userID, id, before, { staff: staffThreadRead }))
      : Promise.reject(new Error('Conversation unavailable'))),
  });
  const threadMessages = history.messages;
  // Opening earlier history keeps the message on screen in place (prependAnchor).
  const prepend = usePrependAnchor();
  const newestMessageID = useRef<string | null>(null);
  const showEarlier = () => {
    prepend.mark(threadMessages[threadMessages.length - 1]?.id ?? null);
    history.loadEarlier();
  };
  const replyCounts = useMessageReplyCounts('private', `${userID}:${id}`, threadMessages.filter((row) => !row.redactedAt).map((row) => row.id), mode === 'authenticated');
  useEffect(() => {
    scope.current += 1;
    return () => { scope.current += 1; };
    // The held route key owns draft, reply/edit choice and pending work. A
    // workspace check hides them; only a real scope change retires the owner.
  }, []);

  useEffect(() => {
    onTitleChange(mode === 'authenticated' && !loading ? thread?.conversation.title ?? 'Messages' : 'Messages');
    return () => onTitleChange('Messages');
  }, [loading, mode, onTitleChange, thread?.conversation.title]);

  // The bar carries the thread's name; the contact card keeps the words without
  // a second announcement.
  const contactEcho = useScreenNameAlreadySpoken(thread?.conversation.title);

  useEffect(() => {
    if (sendError && Platform.OS === 'ios') announceForAccessibility(nativeCatalogLabel(language, sendError));
  }, [sendError, language]);

  useEffect(() => {
    let active = true;
    setThread(null);
    setLoading(true);
    setLoadError(null);
    setRefreshStale(false);
    if (!id) {
      setLoading(false);
      return () => { active = false; };
    }
    if (mode === 'preview') {
      setThread(previewThread(id));
      setLoading(false);
      return () => { active = false; };
    }
    if (mode === 'booting') return () => { active = false; };
    if (mode !== 'authenticated' || !userID) {
      return () => { active = false; };
    }
    const initialVersion = ++readVersion.current;
    void withReadDeadline(loadConversationThread(userID, id, { messageID: message, staff: staffThreadRead })).then(async (nextThread) => {
      if (!active || initialVersion !== readVersion.current) return;
      // The conversation may still be readable after the particular message
      // being edited/replied to was removed. Reuse its exact-source loader so
      // an older target is checked too, even outside the newest message page.
      const choice = heldCompose.current;
      if (nextThread && choice && choice.id !== message) {
        const source = await withReadDeadline(loadConversationThread(userID, id, { messageID: choice.id, staff: staffThreadRead }));
        if (!active || initialVersion !== readVersion.current) return;
        if (!source && heldCompose.current?.id === choice.id) retireAuthoring();
      }
      setThread(nextThread);
      if (!nextThread) retireAuthoring();
      // A read acknowledgement is a write; it must not hold the loaded thread
      // behind the spinner or be automatically retried by the read deadline.
      setLoading(false);
      if (nextThread?.conversation.unreadCount && !nextThread.readerIsStaff) {
        await markConversationRead(writer, userID, id);
        if (active && initialVersion === readVersion.current) {
          setThread({ ...nextThread, conversation: { ...nextThread.conversation, unreadCount: 0 } });
          void refreshRef.current();
        }
      }
    }).catch((error: unknown) => {
      if (active && initialVersion === readVersion.current) {
        setLoadError('This conversation could not be loaded securely. Your access has not been assumed.');
        if (isReadRefusal(error)) retireAuthoring();
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    const reconcile = () => {
      if (AppState.currentState !== 'active') return;
      const version = ++readVersion.current;
      void withReadDeadline(loadConversationThread(userID, id, { messageID: message, staff: staffThreadRead })).then(async (next) => {
        if (!active || version !== readVersion.current) return;
        // A refusal (the conversation was removed or access changed) still
        // clears the thread; any answer clears an earlier refresh failure.
        setRefreshStale(false);
        if (reconcileThreadResult(next) === 'clear' || !next) { retireAuthoring(); setThread(null); return; }
        setLoadError(null);
        setThread(next);
        // The committee replied while this thread was already open: the worker
        // is reading it, so acknowledge the read exactly like the initial-load
        // branch. Without this the view keeps a positive unread_count, the
        // conversation poll merges it, and the Messages badge marks a message
        // unread while it is visibly on screen until the worker leaves and
        // re-enters the thread.
        if (next.conversation.unreadCount && !next.readerIsStaff) {
          // A failed acknowledgement must not hide a thread that loaded fine;
          // keep `next` on screen and let the next reconcile retry the read.
          try {
            await markConversationRead(writer, userID, id);
          } catch {
            return;
          }
          if (active && version === readVersion.current) {
            setThread({ ...next, conversation: { ...next.conversation, unreadCount: 0 } });
            void refreshRef.current();
          }
        }
      }).catch((error: unknown) => {
        // BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
        // (#8769): a failed or timed-out background read keeps the loaded
        // thread with a not-updated notice; only a failed first load shows the
        // unavailable state (set by the initial read). A server refusal (a
        // permission error or a refused session) still clears the thread.
        if (!active || version !== readVersion.current) return;
        if (isReadRefusal(error)) {
          retireAuthoring();
          setRefreshStale(false);
          setThread(null);
          setLoadError('This conversation could not be loaded securely. Your access has not been assumed.');
        } else setRefreshStale(true);
      });
    };
    const timer = setInterval(reconcile, 30000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') reconcile(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
    // `refresh` is deliberately not a dependency (see refreshRef above).
  }, [attempt, id, message, mode, previewThread, userID, staffThreadRead, actorScope, retireAuthoring]);

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;

  async function send() {
    if ((mode !== 'authenticated' && mode !== 'preview') || loading) return;
    const cleanDraft = draft.trim();
    if (!cleanDraft) {
      setSendError('Write a message before sending.');
      return;
    }
    if (!thread || !id || sending) return;
    const currentScope = scope.current;
    setSending(true);
    setSendError(null);
    try {
      if (mode === 'preview') {
        setThread(sendPreviewMessage(id, cleanDraft));
      } else if (userID) {
        if (composeAction) {
          const row = await messageActionRequest(await writer.client(), 'private', composeAction.id, composeAction.kind, cleanDraft) as {
            id: string; conversation_id: string; sender_kind: 'member' | 'steward'; sender_name: string;
            body: string; edited_at: string | null; created_at: string; read_at: string | null; parent_message_id: string | null;
          };
          if (currentScope !== scope.current) return;
          const version = ++readVersion.current;
          setThread((current) => {
            if (!current) return current;
            if (composeAction.kind === 'edit') return { ...current, messages: current.messages.map((message) => message.id === row.id ? { ...message, body: row.body, editedAt: row.edited_at } : message) };
            return { ...current, messages: [...current.messages, { id: row.id, conversationID: row.conversation_id, senderKind: row.sender_kind, senderName: row.sender_name, body: row.body, createdAt: row.created_at, readAt: row.read_at, parentMessageID: row.parent_message_id }] };
          });
          setDraft(''); setComposeAction(null); setReplyRevision((value) => value + 1);
          void haptics.success();
          try {
            const next = await loadConversationThread(userID, id, { messageID: message, staff: staffThreadRead });
            if (currentScope === scope.current && version === readVersion.current) { setThread(next); setRefreshStale(false); }
          } catch { if (currentScope === scope.current) setSendError('Message saved. Refresh is unavailable.'); }
          return;
        }
        if (thread.readerIsStaff) await sendStewardReply(writer, id, cleanDraft);
        else await sendMemberMessage(writer, id, cleanDraft);
        if (currentScope !== scope.current) return;
        setDraft('');
        void haptics.success();
        // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: a staff
        // hat's sent message finishes its Messages feature guide.
        if (staffAccess) void finishStaffGuide(writer, liveStaffGuideHat({ mode, chosenStaffRole, authorizedRoles }), 'messages');
        const version = ++readVersion.current;
        try {
          const nextThread = await loadConversationThread(userID, id, { messageID: message, staff: staffThreadRead });
          if (currentScope !== scope.current || version !== readVersion.current) return;
          if (!nextThread) throw new Error('Conversation unavailable');
          setThread(nextThread);
          setRefreshStale(false);
        } catch {
          if (currentScope === scope.current) setSendError('Message saved. Refresh is unavailable.');
        }
        if (currentScope !== scope.current) return;
        await refresh();
      }
      if (currentScope === scope.current) setDraft('');
    } catch {
      if (currentScope === scope.current) {
        setSendError('Your message was not confirmed. It remains in the composer so you can try again.');
        void haptics.warning();
      }
    } finally {
      if (currentScope === scope.current) setSending(false);
    }
  }

  async function react(messageID: string, kind: string) {
    if (reacting || !userID || !id || mode !== 'authenticated') return;
    setReacting(messageID); setReactionError(false); setReactionPicker(null);
    const currentScope = scope.current;
    const version = ++readVersion.current;
    try {
      const result = await reactToConversationMessage(writer, userID, id, messageID, kind, { messageID: message, staff: staffThreadRead });
      if (currentScope !== scope.current) return;
      setReactionError(result.failed);
      if (version === readVersion.current) setThread(result.thread);
    } catch {
      if (currentScope === scope.current) setReactionError(true);
    } finally {
      if (currentScope === scope.current) setReacting(null);
    }
  }

  if (loading || mode === 'booting') return <Screen><StateMessage title={t('Loading conversation')} body={t('Opening your conversation.')} /></Screen>;
  if (!thread) return <Screen><StateMessage title={t('Conversation not available')} body={loadError ? catalogLabel(loadError) : t('This conversation may have moved, or your access may have changed.')} action={loadError ? <Button label={t('Try again')} onPress={() => setAttempt((value) => value + 1)} /> : null} /></Screen>;

  return (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: theme.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={threadScrollRef}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode={keyboardDismissModeFor(Platform.OS)}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={(_width, height) => {
          const newest = threadMessages[threadMessages.length - 1]?.id ?? null;
          const layout = prepend.laidOut(height, {
            newest,
            loading: history.status === 'loading',
            scrollTo: (y) => threadScrollRef.current?.scrollTo({ y, animated: false }),
          });
          if (layout !== 'changed') return;
          const newestChanged = newest !== newestMessageID.current;
          newestMessageID.current = newest;
          if (message && messageOffset.current !== null) threadScrollRef.current?.scrollTo({ y: Math.max(0, messagesOffset.current + messageOffset.current - 20), animated: false });
          // Once earlier history is open, only a new latest message moves the
          // reader to the end.
          else if (!message && (!history.started || newestChanged)) threadScrollRef.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(event) => {
          prepend.scrolled(event.nativeEvent.contentOffset.y);
        }}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.thread, { paddingTop: pinned?.contentInset ?? contentStartInset(insets.top), paddingBottom: spacing.xl }]}
      >
        <View style={styles.contactHeader}>
          <Avatar initials={thread.conversation.initials} size={62} />
          {/* The title row beside Back paints and announces the name. */}
          {contactEcho.duplicate ? null : (
            <Text accessibilityRole="header" style={[styles.contactName, { color: theme.foreground }]}>{thread.conversation.title}</Text>
          )}
          <Text style={[styles.contactMeta, { color: theme.mutedForeground }]}>{t('Private conversation · active {time}', { time: formatDateTime(thread.conversation.updatedAt) })}</Text>
        </View>
        {refreshStale ? <Notice>{t('Not updated. Showing the messages that loaded earlier; this tries again shortly.')}</Notice> : null}
        <View style={styles.messages} accessibilityLabel={t('Conversation messages')} onLayout={(event) => { messagesOffset.current = event.nativeEvent.layout.y; }}>
          {replyParent ? <MessageReplies key={`${userID}:${id}:${replyParent}:${replyRevision}`} sourceKind="private" targetID={id} parentID={replyParent}
            onClose={() => setReplyParent(null)} onOpenParent={setReplyParent} onCompose={(kind, row) => { setComposeAction({ kind, id: row.id }); setDraft(kind === 'edit' ? row.body : ''); }} /> : null}
          {!replyParent && threadMessages.length > 0 ? <EarlierHistoryControl history={history} onShowEarlier={showEarlier} /> : null}
          {!replyParent && (threadMessages.length === 0 ? <StateMessage title={t('No messages yet')} body={t('Write below to start the conversation.')} /> : threadMessages.filter((message) => !replyParent || message.id === replyParent || message.parentMessageID === replyParent).map((message, index) => {
            const mine = message.senderKind === (thread.readerIsStaff ? 'steward' : 'member');
            const previous = index > 0 ? threadMessages[index - 1] : null;
            const dayLabel = formatDay(message.createdAt);
            const newDay = !previous || formatDay(previous.createdAt) !== dayLabel;
            const sameSender = previous?.senderKind === message.senderKind
              && previous.senderName === message.senderName
              && !newDay;
            const bodyText = isRedactedMessage({ redacted_at: message.redactedAt, redaction_reason: message.redactionReason })
              ? redactedNotice(message.redactionReason, t)
              : message.body;
            const rowName = `${message.senderName}: ${bodyText}`;
            return (
              <View key={message.id} onLayout={(event) => { if (message.id === selectedMessageID) { messageOffset.current = event.nativeEvent.layout.y; threadScrollRef.current?.scrollTo({ y: Math.max(0, messagesOffset.current + messageOffset.current - 20), animated: false }); } }} style={[styles.messageBlock, sameSender ? styles.messageBlockGrouped : null]}>
                {newDay ? (
                  <View style={styles.dayRow}>
                    <Text style={[styles.dayDivider, { color: theme.mutedForeground }]}>{dayLabel}</Text>
                  </View>
                ) : null}
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
                  {!mine && !sameSender ? (
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      <Avatar initials={initialsFor(message.senderName)} size={28} />
                    </View>
                  ) : !mine ? <View style={styles.avatarSpacer} /> : null}
                  <View style={[styles.bubbleStack, mine ? styles.bubbleStackMine : null]}>
                    {!mine && !sameSender ? (
                      <View style={styles.senderRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Text style={[styles.sender, { color: theme.foreground }]}>{message.senderName}</Text>
                        {message.senderKind === 'steward' && (previewHat == null || previewHat === 'member') ? (
                          <Text style={[styles.roleLabel, { color: theme.primary }]}>{t("COMMITTEE")}</Text>
                        ) : null}
                      </View>
                    ) : null}
                    <WorkflowMessageActions key={`${userID ?? mode}:${message.id}`} sourceKind="private" messageID={message.id}
                      accessibilityLabel={rowName}
                      enabled={mode === 'authenticated' && !message.redactedAt}
                      onConfirmed={(state) => {
                        readVersion.current += 1;
                        setThread((current) => current ? { ...current, messages: current.messages.map((row) => row.id === message.id ? { ...row, reactions: reconcileOwnReactions(row.reactions ?? [], state.reactions) } : row) } : null);
                      }}
                      onCompose={(kind) => { setComposeAction({ kind, id: message.id }); setDraft(kind === 'edit' ? message.body : ''); }}>
                    <View style={[
                      styles.bubble,
                      mine ? styles.bubbleMine : styles.bubbleTheirs,
                      { backgroundColor: mine ? theme.primary : theme.card, borderColor: mine ? theme.primary : theme.border },
                    ]}>
                      {/* SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904: a removed
                          body no longer exists in the database, so the bubble
                          shows why the text is gone rather than an empty
                          bubble a reader would take for a rendering fault. */}
                      {isRedactedMessage({ redacted_at: message.redactedAt, redaction_reason: message.redactionReason })
                        ? <Text
                            accessibilityLabel={redactedNotice(message.redactionReason, t)}
                            style={[styles.bubbleText, styles.bubbleRedacted, { color: mine ? theme.primaryForeground : theme.mutedForeground }]}
                          >{redactedNotice(message.redactionReason, t)}</Text>
                        : mode === 'authenticated' && chartReference(message.body) ? <LiveChartMessage body={message.body} /> : <Text style={[styles.bubbleText, { color: mine ? theme.primaryForeground : theme.foreground }]}>{message.body}</Text>}
                    </View>
                    </WorkflowMessageActions>
                    {mode === 'authenticated' && !message.redactedAt ? <View style={styles.reactions}>
                      {(message.reactions || []).filter((entry) => entry.count > 0).map((entry) => <MessageReactionButton
                        key={entry.kind} entry={entry} showCount chip disabled={Boolean(reacting)}
                        onPress={() => { void react(message.id, entry.kind); }} />)}
                      <AddReactionChip accessibilityLabel={t('Add reaction')} expanded={reactionPicker === message.id} disabled={Boolean(reacting)}
                        onPress={() => setReactionPicker((current) => current === message.id ? null : message.id)} />
                      {reactionPicker === message.id ? <MessageReactionPicker
                        mine={(message.reactions ?? []).filter((entry) => entry.mine).map((entry) => entry.kind)}
                        disabled={Boolean(reacting)} onReact={(kind) => { void react(message.id, kind); }} /> : null}
                    </View> : null}
                    <Text style={[styles.time, { color: theme.mutedForeground, textAlign: mine ? 'right' : 'left' }]}>{message.editedAt ? t('Edited · ') : ''}{message.parentMessageID ? t('Reply · ') : ''}{formatTime(message.createdAt)}</Text>
                    {(replyCounts[message.id] ?? 0) > 0 ? <ReplyCountControl count={replyCounts[message.id] ?? 0} align={mine ? 'end' : 'start'} onPress={() => setReplyParent(message.id)} /> : null}
                    {mode === 'authenticated' && message.parentMessageID ? <ParentMessageControl align={mine ? 'end' : 'start'} author={threadMessages.find((row) => row.id === message.parentMessageID)?.senderName} onPress={() => setReplyParent(message.parentMessageID ?? null)} /> : null}
                  </View>
                </View>
              </View>
            );
          }))}
        </View>
      </ScrollView>
      {!thread.readerIsStaff || composeAction || directAudience === 'steward' ? <View style={[styles.composerDock, { backgroundColor: theme.background, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {composeAction ? <Button label={composeAction.kind === 'edit' ? t('Cancel editing') : t('Cancel reply')} onPress={() => { setComposeAction(null); setDraft(''); }} /> : null}
        <View style={[styles.composer, { backgroundColor: theme.input, borderColor: theme.border }]}>
          <TextInput
            accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Conversation reply')}
            multiline
            maxLength={4_000}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={draft}
            onChangeText={setDraft}
            placeholder={t('Conversation reply')}
            placeholderTextColor={theme.quietForeground}
            style={[styles.input, { color: theme.foreground }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? t('Sending message') : t('Send message')}
            accessibilityState={{ disabled: sending || !draft.trim() }}
            disabled={sending || !draft.trim()}
            onPress={() => { void send(); }}
            style={({ pressed }) => [styles.send, { backgroundColor: sending || !draft.trim() ? theme.muted : theme.primary, opacity: pressed && !sending ? 0.82 : 1 }]}
          >
            <Ionicons name="arrow-up" size={22} color={sending || !draft.trim() ? theme.mutedForeground : theme.primaryForeground} />
          </Pressable>
        </View>
        <Text style={[styles.counter, { color: theme.mutedForeground }]}>{draft.length}/4,000</Text>
        {reactionError ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Reaction not confirmed. Conversation refreshed.')}</Text> : null}
        {sendError ? <View accessibilityLiveRegion="polite"><Body accessibilityRole="alert" style={{ color: theme.destructive }}>{catalogLabel(sendError)}</Body></View> : null}
      </View> : <Body muted>{t('Select a message to reply to it.')}</Body>}
    </KeyboardAvoidingView>
  );
}

function initialsFor(name: string) {
  return name.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

// Copy per redaction reason. The database never sends prose — only the reason
// code — so the phone renders its own sentence, the same way responsive web
// resolves an i18n key.
const REDACTION_NOTICES: Record<string, string> = {
  sender_removed: 'The sender removed this message.',
  staff_removed: 'A committee member removed this message.',
  retention_expired: 'This message passed the retention window and its text was removed.',
  account_closed: 'This message was removed when the account closed.',
};

function redactedNotice(reason: string | null | undefined, t: NativeUiText) {
  const known = redactionReasonOf({ redacted_at: 'set', redaction_reason: reason });
  return t(((known && REDACTION_NOTICES[known]) || 'Message removed.') as Parameters<NativeUiText>[0]);
}

// The top of the loaded history: earlier messages to open, the loading and
// failure states, or the explicit start of the conversation. The button keeps
// one place in the tree through its busy state, so focus stays on it.
function EarlierHistoryControl({ history, onShowEarlier }: { history: ConversationHistory; onShowEarlier: () => void }) {
  const theme = useTheme();
  const copy = conversationHistoryCopy;
  return (
    <View style={styles.history}>
      {history.status === 'error' ? <Notice>{copy.failed}</Notice> : null}
      {history.hasEarlier ? (
        <Button
          label={history.status === 'error' ? copy.tryAgain : history.status === 'loading' ? copy.loadingEarlier : copy.showEarlier}
          variant="secondary"
          busy={history.status === 'loading'}
          onPress={onShowEarlier}
        />
      ) : (
        <Text accessibilityRole="text" style={[styles.historyStart, { color: theme.mutedForeground }]}>{copy.start}</Text>
      )}
      {history.started && history.status === 'idle' && history.lastLoaded > 0 ? (
        <Text accessibilityLiveRegion="polite" style={[styles.historyStart, { color: theme.mutedForeground }]}>{copy.loaded(history.lastLoaded)}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  history: { gap: spacing.sm, paddingBottom: spacing.md },
  historyStart: { fontSize: 13, lineHeight: 18, ...typeface.control, textAlign: 'center' },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 0, columnGap: spacing.sm },
  flex: { flex: 1 },
  thread: { paddingHorizontal: spacing.lg },
  contactHeader: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.xl },
  contactName: { fontSize: 20, lineHeight: 26, ...typeface.controlStrong },
  contactMeta: { fontSize: 12, lineHeight: 17, ...typeface.bodyMedium, textAlign: 'center' },
  messages: { gap: spacing.sm },
  messageBlock: { gap: spacing.sm },
  messageBlockGrouped: { marginTop: -spacing.xs },
  dayRow: { alignItems: 'center', paddingVertical: spacing.md },
  dayDivider: { textAlign: 'center', fontSize: 12, lineHeight: 17, ...typeface.controlStrong },
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  bubbleRowMine: { justifyContent: 'flex-end' },
  avatarSpacer: { width: 28 },
  bubbleStack: { maxWidth: '82%', gap: 3 },
  bubbleStackMine: { alignItems: 'flex-end' },
  senderRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, paddingLeft: spacing.sm },
  sender: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  roleLabel: { fontSize: 9, lineHeight: 13, ...typeface.controlStrong, letterSpacing: 0.6 },
  bubble: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine: { borderRadius: 20, borderBottomRightRadius: 6 },
  bubbleTheirs: { borderRadius: 20, borderBottomLeftRadius: 6 },
  bubbleRedacted: { fontStyle: 'italic' },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  time: { fontSize: 11, lineHeight: 15, paddingHorizontal: spacing.sm },
  composerDock: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.xs },
  composer: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 24, paddingLeft: spacing.md, paddingRight: 2, paddingVertical: 2 },
  counter: { alignSelf: 'flex-end', fontSize: 11, lineHeight: 15, ...typeface.control },
  input: { flex: 1, minHeight: minimumTouchTarget - 4, maxHeight: 120, paddingVertical: 10, fontSize: 16, lineHeight: 22, textAlignVertical: 'center' },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
});
