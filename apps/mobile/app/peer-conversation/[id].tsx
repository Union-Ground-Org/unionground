import { Ionicons } from '@expo/vector-icons';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { useRevealAboveKeyboard } from '../../src/components/ScreenKeyboardReveal';
import { Text, TextInput } from '../../src/components/Text';
import { Avatar, Body, Button, Notice, Screen, StateMessage } from '../../src/components/ui';
import { deviceDateTime } from '../../src/lib/evidenceTimestamp';
import { useHeldScreenScope } from '../../src/lib/heldScreenScope';
import { randomUUID } from 'expo-crypto';
import { createOperationKeys } from '../../../../src/lib/operationKey.js';
import { PEER_MESSAGE_LIMIT, PEER_THREAD_WINDOW, PeerConversationClosed, PeerMessageNotSent, peerInitials, peerReplyBody, type PeerConversation, type PeerConversationState, type PeerMessage } from '../../src/lib/peerConversations';
import { useNativeUi } from '../../src/lib/useNativeUi';
import { haptics } from '../../src/services/haptics';
import { loadMyPeerConversations, sendMyPeerMessage, setMyPeerConversationBlock } from '../../src/services/peerConversations';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';
import { typeface } from '../../src/theme/typeface';

// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162):
// one private two-person conversation, as the website's Messages thread shows
// it: the other person's name, who can read it, the messages oldest to newest
// and a reply field. Only its two participants can read it; the server checks
// that on every read and send. Sends are online only: a failed send keeps the
// draft and is never retried by itself.
// #9189 (PR #9201): the server says whether this person may still write. Open
// shows the reply field; closed (a person left, or the other person blocked:
// it never says which) and blocked-by-you show a line instead, and either
// person can block or unblock from here. An older server sends no state,
// which means open.
// #9227 round 1: the draft and a send in flight belong to the content, not the
// reply field, so a conversation that closes keeps what the person wrote
// (shown for copying, and back in the field if it reopens), and the content's
// scope is held while a return to the app re-checks the session (r1s1).
export default function PeerConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { mode, session, dashboard, organizationID, sessionRestricted } = useApp();
  const { t } = useNativeUi();
  const scope = useHeldScreenScope(mode === 'booting', [session?.user.id, id], [organizationID, dashboard?.member.chapterID]);
  // The other person's name belongs to the conversation it was read for: it
  // is kept with that scope and shown only for it, and never beside the
  // step-up prompt, so a reused route or a restricted session never shows the
  // previous person's name. A callback from an old scope's content is ignored.
  const [titled, setTitled] = useState<{ scope: string; title: string | null }>({ scope, title: null });
  const onTitle = useCallback((title: string | null) => setTitled({ scope, title }), [scope]);
  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const heading = (!sessionRestricted && titled.scope === scope ? titled.title : null) ?? t('Private conversation');
  return (
    <PinnedHeaderScreen title={heading} screenName={heading}>
      {<PeerConversationContent key={scope} conversationID={typeof id === 'string' ? id : ''} live={mode === 'authenticated'} onTitle={onTitle} />}
    </PinnedHeaderScreen>
  );
}

function PeerConversationContent({ conversationID, live, onTitle }: { conversationID: string; live: boolean; onTitle: (title: string | null) => void }) {
  const theme = useTheme();
  const { t, locale } = useNativeUi();
  // The session that pressed Send goes with the message (#9203).
  const { conversationPollConnected, session } = useApp();
  const connected = useRef(conversationPollConnected !== false);
  connected.current = conversationPollConnected !== false;
  const [conversation, setConversation] = useState<PeerConversation | null>(null);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  // Whether a list read in this signed-in stretch has listed the conversation
  // (#9227 delta F2). The kept conversation, its title, its messages and the
  // reply field show only once it has: across a return to the app they wait
  // for the read after the session check, and a missing or failed read keeps
  // them hidden. The draft and a send in flight stay with this content.
  const [fresh, setFresh] = useState(false);
  // Bumped by every state this screen learns first (a block, an unblock, a
  // send refused as closed): a read that started before it is dropped, so a
  // stale answer never puts the old state back.
  const localChange = useRef(0);
  const showState = (state: PeerConversationState) => {
    localChange.current += 1;
    setConversation((previous) => (previous && previous.id === conversationID ? { ...previous, state } : previous));
  };
  const sendingNow = useRef(false);
  const alive = useRef(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<'sent' | 'failed' | 'unconfirmed' | null>(null);
  const [operations] = useState(() => createOperationKeys(randomUUID, { maxAgeMs: Infinity }));
  useEffect(() => () => { alive.current = false; }, []);
  const send = async () => {
    const body = peerReplyBody(draft);
    if (sendingNow.current || body === null) return;
    sendingNow.current = true; setSending(true); setStatus(null);
    try {
      const saved = await sendMyPeerMessage(session, conversationID, draft, operations.keyFor(body));
      if (!alive.current) return;
      operations.clear();
      setDraft(''); setStatus('sent');
      setConversation((previous) => (previous && previous.id === conversationID ? withMessage(previous, saved) : previous));
      void haptics.success();
    } catch (reason: unknown) {
      if (!alive.current) return;
      // Closed while the screen was open: show it closed, not a failed send.
      // A block this person made meanwhile stays their own (#9201 round 1).
      if (reason instanceof PeerConversationClosed) {
        localChange.current += 1;
        setConversation((previous) => (previous && previous.id === conversationID && previous.state === 'open' ? { ...previous, state: 'closed' } : previous));
      } else { setStatus(reason instanceof PeerMessageNotSent ? 'failed' : 'unconfirmed'); void haptics.warning(); }
    } finally {
      sendingNow.current = false;
      if (alive.current) setSending(false);
    }
  };
  useEffect(() => {
    if (!live) { setFresh(false); return undefined; }
    let current = true, loaded = false;
    setError(false); setStale(false);
    const load = async () => {
      const startedAt = localChange.current;
      const found = (await loadMyPeerConversations()).find((item) => item.id === conversationID) ?? null;
      if (!current) return;
      // A stale answer still says the conversation is listed for this person.
      if (startedAt !== localChange.current) { if (found) setFresh(true); return; }
      // A conversation that is no longer listed is gone for this person, not
      // a passing failure: the screen stops showing it.
      if (!found) throw new Error('missing');
      loaded = true;
      setConversation((previous) => keepSent(previous, found));
      setFresh(true); setError(false); setStale(false);
    };
    // The #8769 rule: a failed first read shows the unavailable state; a
    // failed later read keeps the loaded messages with a not-updated notice.
    const refresh = (first = false) => {
      if (!first && !connected.current) return;
      void load().catch((reason: unknown) => {
        if (!current) return;
        if (!loaded || (reason instanceof Error && reason.message === 'missing')) { loaded = false; setConversation(null); setStale(false); setError(true); } else setStale(true);
      });
    };
    refresh(true);
    const timer = setInterval(refresh, 30000);
    return () => { current = false; clearInterval(timer); };
  }, [conversationID, live, revision]);
  useEffect(() => { onTitle(fresh ? conversation?.peerName || null : null); }, [fresh, conversation?.peerName, onTitle]);

  const name = conversation?.peerName || t('the other person');
  if (error) {
    return <Screen>
      <StateMessage title={t('Conversation unavailable')} body={t('This conversation is not available to you any more, or it could not be read.')} />
      <Button label={t('Try again')} onPress={() => setRevision((value) => value + 1)} />
    </Screen>;
  }
  // `live` is false only while the app is still restoring the session.
  if (!conversation || !live || !fresh) return <Screen><StateMessage title={t('Loading conversation')} body={t('Getting your private messages.')} /></Screen>;
  return <Screen>
    <View style={styles.contact}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Avatar initials={peerInitials(conversation)} size={52} /></View>
      <View style={styles.audience}>
        <Ionicons accessible={false} name="lock-closed" size={13} color={theme.mutedForeground} />
        <Text style={[styles.audienceText, { color: theme.mutedForeground }]}>{t('Only you and {name} can read it', { name })}</Text>
      </View>
    </View>
    {stale ? <Notice>{t('Not updated. Showing the messages that loaded earlier; this tries again shortly.')}</Notice> : null}
    {conversation.messages.length >= PEER_THREAD_WINDOW ? <Body muted>{t('Showing the newest {count} messages.', { count: PEER_THREAD_WINDOW.toLocaleString(locale) })}</Body> : null}
    {conversation.messages.length === 0 ? (conversation.state === 'open' ? <Body muted>{t('No messages yet. Write the first one below.')}</Body> : null) : (
      <View style={styles.messages}>
        {conversation.messages.map((message) => <PeerBubble key={message.id} message={message} name={name} />)}
      </View>
    )}
    {conversation.state === 'open' ? (
      <PeerReplyComposer
        name={name}
        draft={draft}
        sending={sending}
        status={status}
        onDraft={(value) => {
          if (value.trim() !== draft.trim()) operations.clear();
          setDraft(value);
          if (status === 'sent') setStatus(null);
        }}
        onSend={() => { void send(); }}
      />
    ) : null}
    {conversation.state === 'closed' ? <Notice>{t('This conversation is closed. You can still read it.')}</Notice> : null}
    {conversation.state !== 'open' && !sending && peerReplyBody(draft) !== null ? <View style={styles.unsent}>
      <Text style={[styles.unsentLabel, { color: theme.mutedForeground }]}>{t('Your message was not sent. You can copy it from here:')}</Text>
      <Text selectable accessibilityLabel={t('Your unsent message: {text}', { text: draft })} style={[styles.unsentText, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }]}>{draft}</Text>
    </View> : null}
    {conversation.blockable ? <PeerBlockControl
      key={conversation.state}
      conversationID={conversation.id}
      state={conversation.state}
      name={name}
      onState={showState}
    /> : null}
  </Screen>;
}

// Block from inside the conversation, behind a confirm step; the person who
// blocked sees their own block and can lift it. The server answers with this
// person's new state.
function PeerBlockControl({ conversationID, state, name, onState }: { conversationID: string; state: PeerConversationState; name: string; onState: (state: PeerConversationState) => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  // The session that pressed Block or Unblock goes with the call (#9203).
  const { session } = useApp();
  const alive = useRef(true);
  const busyNow = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { alive.current = false; }, []);
  const change = async (blocked: boolean) => {
    if (busyNow.current) return;
    busyNow.current = true; setBusy(true); setFailed(false);
    try {
      const next = await setMyPeerConversationBlock(session, conversationID, blocked);
      if (!alive.current) return;
      setConfirming(false);
      void haptics.success();
      onState(next);
    } catch {
      if (alive.current) { setFailed(true); void haptics.warning(); }
    } finally {
      busyNow.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const failure = failed ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{t('That did not go through. Try again.')}</Text> : null;
  if (state === 'blocked_by_viewer') {
    return <View style={styles.safety}>
      <Notice>{t('You blocked {name}. Neither of you can send messages here.', { name })}</Notice>
      <Button label={t('Unblock')} variant="secondary" busy={busy} onPress={() => { void change(false); }} />
      {failure}
    </View>;
  }
  if (confirming) {
    return <View accessibilityRole="none" accessibilityLabel={t('Block {name}', { name })} style={styles.safety}>
      <Body>{t('Block {name}? Neither of you will be able to send messages here, and they will see the conversation as closed.', { name })}</Body>
      <Button label={t('Block')} variant="danger" busy={busy} onPress={() => { void change(true); }} />
      <Button label={t('Cancel')} variant="secondary" disabled={busy} onPress={() => { setConfirming(false); setFailed(false); }} />
      {failure}
    </View>;
  }
  return <View style={styles.safety}>
    <Button label={t('Block {name}', { name })} variant="secondary" onPress={() => setConfirming(true)} />
    {failure}
  </View>;
}

function withMessage(conversation: PeerConversation, message: PeerMessage): PeerConversation {
  if (conversation.messages.some((item) => item.id === message.id)) return conversation;
  const messages = [...conversation.messages, message].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return { ...conversation, updatedAt: messages.at(-1)?.createdAt || conversation.updatedAt, messages };
}

// A re-read that raced a send may not list the message just sent yet; keep it
// until the server's list does.
function keepSent(previous: PeerConversation | null, next: PeerConversation): PeerConversation {
  if (!previous || previous.id !== next.id) return next;
  const known = new Set(next.messages.map((item) => item.id));
  const newest = Date.parse(next.messages.at(-1)?.createdAt ?? '') || 0;
  const pending = previous.messages.filter((item) => item.sentByMe && !known.has(item.id) && (Date.parse(item.createdAt) || 0) > newest);
  return pending.length ? { ...next, messages: [...next.messages, ...pending] } : next;
}

function PeerBubble({ message, name }: { message: PeerMessage; name: string }) {
  const theme = useTheme();
  const { t, language } = useNativeUi();
  const mine = message.sentByMe;
  const author = mine ? t('You') : name;
  const when = deviceDateTime(message.createdAt, language === 'es' ? 'es-US' : 'en-US') ?? t('time unavailable');
  return (
    <View accessible accessibilityLabel={`${author}, ${when}: ${message.body}`} style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
      <View style={[styles.bubbleStack, mine ? styles.bubbleStackMine : null]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs, { backgroundColor: mine ? theme.primary : theme.card, borderColor: mine ? theme.primary : theme.border }]}>
          <Text style={[styles.bubbleText, { color: mine ? theme.primaryForeground : theme.foreground }]}>{message.body}</Text>
        </View>
        <Text style={[styles.time, { color: theme.mutedForeground, textAlign: mine ? 'right' : 'left' }]}>{author} · {when}</Text>
      </View>
    </View>
  );
}

// The reply field and Send button are one block the page lifts above the
// keyboard while the field has focus (ScreenKeyboardReveal), as the task
// conversation's reply does. The full who-can-read sentence sits under it.
function PeerReplyComposer({ name, draft, sending, status, onDraft, onSend }: { name: string; draft: string; sending: boolean; status: 'sent' | 'failed' | 'unconfirmed' | null; onDraft: (value: string) => void; onSend: () => void }) {
  const theme = useTheme();
  const { t, locale } = useNativeUi();
  const keyboardReveal = useRevealAboveKeyboard();
  const block = useRef<View>(null);
  const ready = peerReplyBody(draft) !== null && !sending;
  return <View ref={block} style={styles.dock}>
    <View style={[styles.composer, { backgroundColor: theme.input, borderColor: theme.border }]}>
      <TextInput
        accessibilityLabel={t('Write to {name}', { name })}
        multiline
        maxLength={PEER_MESSAGE_LIMIT}
        editable={!sending}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={draft}
        onChangeText={onDraft}
        onFocus={() => keyboardReveal.reveal(block.current)}
        onBlur={() => keyboardReveal.release(block.current)}
        placeholder={t('Write a private message…')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { color: theme.foreground }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sending ? t('Sending message') : t('Send message')}
        accessibilityState={{ disabled: !ready, busy: sending }}
        disabled={!ready}
        onPress={onSend}
        style={({ pressed }) => [styles.send, { backgroundColor: ready ? theme.primary : theme.muted, opacity: pressed && ready ? 0.82 : 1 }]}
      >
        <Ionicons name="arrow-up" size={22} color={ready ? theme.primaryForeground : theme.mutedForeground} />
      </Pressable>
    </View>
    <Text style={[styles.counter, { color: theme.mutedForeground }]}>{draft.length.toLocaleString(locale)}/{PEER_MESSAGE_LIMIT.toLocaleString(locale)}</Text>
    <Text style={[styles.visibility, { color: theme.mutedForeground }]}>{t('A conversation with one officer or worker: only you and {name} can read it. Committee members, other officers and your employer cannot.', { name })}</Text>
    {status === 'sent' ? <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>{t('Message sent.')}</Text> : null}
    {status === 'failed' ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{t('That message could not be sent. Your draft is still here.')}</Text> : null}
    {status === 'unconfirmed' ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{t('We could not confirm that your message was sent. Check the conversation before sending again.')}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  contact: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.md },
  audience: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  audienceText: { fontSize: 12, lineHeight: 17, ...typeface.bodyMedium, textAlign: 'center' },
  messages: { gap: spacing.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleStack: { maxWidth: '82%', gap: 3 },
  bubbleStackMine: { alignItems: 'flex-end' },
  bubble: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine: { borderRadius: 20, borderBottomRightRadius: 6 },
  bubbleTheirs: { borderRadius: 20, borderBottomLeftRadius: 6 },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  time: { fontSize: 11, lineHeight: 15, paddingHorizontal: spacing.sm },
  dock: { gap: spacing.xs, paddingTop: spacing.md },
  composer: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 24, paddingLeft: spacing.md, paddingRight: 2, paddingVertical: 2 },
  input: { flex: 1, minHeight: minimumTouchTarget - 4, maxHeight: 120, paddingVertical: 10, fontSize: 16, lineHeight: 22, textAlignVertical: 'center' },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  counter: { alignSelf: 'flex-end', fontSize: 11, lineHeight: 15, ...typeface.control },
  visibility: { fontSize: 12, lineHeight: 17, ...typeface.bodyMedium },
  safety: { gap: spacing.sm, paddingTop: spacing.md },
  unsent: { gap: spacing.xs, paddingTop: spacing.md },
  unsentLabel: { fontSize: 13, lineHeight: 18, ...typeface.bodyMedium },
  unsentText: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
});
