import { Ionicons } from '@expo/vector-icons';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { useRevealAboveKeyboard } from '../../src/components/ScreenKeyboardReveal';
import { Text, TextInput } from '../../src/components/Text';
import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../../src/components/ui';
import { WorkflowActions } from '../../src/components/WorkflowActions';
import { connectedWorkflowApi } from '../../src/lib/connectedWorkflows';
import { deviceDateTime } from '../../src/lib/evidenceTimestamp';
import { useHeldScreenScope } from '../../src/lib/heldScreenScope';
import { useRequestGeneration } from '../../src/lib/useRequestGeneration';
import { isTaskConversationRefusal, loadTaskConversation, type TaskConversationSource, type TaskMessage } from '../../src/lib/taskConversationLoad';
import { sendTaskReply, taskReplyBody, TASK_REPLY_LIMIT, type TaskReplyRpc } from '../../src/lib/taskConversationReply';
import { useNativeUi } from '../../src/lib/useNativeUi';
import { captureSessionWriter, getSupabaseClient, type MobileSessionWriter } from '../../src/services/supabase';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';
import { typeface } from '../../src/theme/typeface';

const projection = 'id,body,created_at,sender_id,recipient_id';

function taskConversationSource(): TaskConversationSource | null {
  const client = getSupabaseClient();
  const api = connectedWorkflowApi();
  if (!client || !api) return null;
  const participants = (userID: string) => `sender_id.eq.${userID},recipient_id.eq.${userID}`;
  return {
    context: (reference) => api.context(reference),
    messages: async ({ taskID, userID, limit }) => client.from('chapter_task_messages').select(projection).eq('task_id', taskID).or(participants(userID)).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
    message: async ({ taskID, userID, messageID }) => client.from('chapter_task_messages').select(projection).eq('task_id', taskID).eq('id', messageID).or(participants(userID)).maybeSingle(),
    task: async ({ taskID }) => client.from('chapter_tasks').select('id,created_by,assignee_id').eq('id', taskID).maybeSingle(),
  };
}

function taskReplyRpc(writer: MobileSessionWriter): TaskReplyRpc | null {
  return async (name, args) => (await writer.client()).rpc(name, args);
}

export default function TaskConversationRoute() {
  const { catalogLabel } = useNativeUi();
  const { id, message } = useLocalSearchParams<{ id: string; message?: string }>();
  const { mode, session, dashboard, authorizedRoles, organizationID, confirmedMembershipScope } = useApp();
  const scope = useHeldScreenScope(mode === 'booting', [session?.user.id, id, message], [mode, organizationID, dashboard?.member.chapterID, authorizedRoles, confirmedMembershipScope]);
  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  return <PinnedHeaderScreen screenName={catalogLabel("Task conversation")}><TaskConversation key={scope} taskID={id} messageID={message} userID={session?.user.id} live={mode === 'authenticated'} /></PinnedHeaderScreen>;
}

function TaskConversation({ taskID, messageID, userID, live }: { taskID: string; messageID?: string; userID?: string; live: boolean }) {
  const { catalogLabel } = useNativeUi();
  const { session } = useApp();
  const [messages, setMessages] = useState<TaskMessage[] | null>(null);
  const [limit, setLimit] = useState(50);
  const [more, setMore] = useState(false);
  const [canReply, setCanReply] = useState(false);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const [fresh, setFresh] = useState(false);
  // Keep the draft and its send owner above the loading/access branches. The
  // held key survives only this person's foreground check, not a real change.
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<'sent' | 'failed' | null>(null);
  const sendingNow = useRef(false);
  const sends = useRequestGeneration(taskID);
  const retireAuthoring = useCallback(() => {
    sends.invalidate(); sendingNow.current = false;
    setDraft(''); setStatus(null); setSending(false);
  }, [sends]);
  const send = async () => {
    if (!live || !fresh || !canReply || sendingNow.current || taskReplyBody(draft) === null) return;
    const ticket = sends.begin();
    sendingNow.current = true; setSending(true); setStatus(null);
    try {
      const saved = await sendTaskReply(taskReplyRpc(captureSessionWriter(session)), taskID, draft);
      if (!ticket.isCurrent()) return;
      setDraft(''); setStatus('sent');
      setMessages((rows) => rows ? [...rows.filter((row) => row.id !== saved.id), saved] : rows);
    } catch {
      if (ticket.isCurrent()) setStatus('failed');
    } finally {
      if (ticket.isCurrent()) { sendingNow.current = false; setSending(false); }
    }
  };
  useEffect(() => {
    let current = true, loaded = false; setError(false); setStale(false);
    if (!live) { setFresh(false); return () => { current = false; }; }
    const load = async () => {
      const next = await loadTaskConversation(taskConversationSource(), { taskID, messageID, userID, limit });
      if (current) {
        loaded = true; setMessages(next.messages); setMore(next.more); setCanReply(next.canReply); setError(false); setStale(false); setFresh(true);
        if (!next.canReply) retireAuthoring();
      }
    };
    // BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
    //: a refusal clears the conversation; any other failed refresh
    // keeps the loaded messages with a not-updated notice. Only a failed first
    // load shows the unavailable state, and a later success clears either.
    const refresh = () => { void load().catch((reason: unknown) => {
      if (!current) return;
      if (isTaskConversationRefusal(reason)) retireAuthoring();
      if (isTaskConversationRefusal(reason) || !loaded) { loaded = false; setMessages(null); setCanReply(false); setStale(false); setError(true); } else setStale(true);
    }); };
    refresh(); const timer = setInterval(refresh, 30000);
    return () => { current = false; clearInterval(timer); };
  }, [taskID, messageID, userID, live, limit, revision, retireAuthoring]);
  return <Screen><Heading>{catalogLabel("Task conversation")}</Heading>
    {!live ? <StateMessage title="Loading conversation" body="Checking task and participant access." /> : error ? <><StateMessage title="Conversation unavailable" body="The source was removed, access changed, or the request could not complete." /><Button label="Try again" onPress={() => setRevision((value) => value + 1)} /></> : !fresh || messages === null ? <StateMessage title="Loading conversation" body="Checking task and participant access." /> : <>
      {stale ? <Notice>Not updated. Showing the messages that loaded earlier; this tries again shortly.</Notice> : null}
      <WorkflowActions kind="task" id={taskID} />
      {messageID ? <Card><Heading level={2}>Selected message</Heading><Body>{messages.find((row) => row.id === messageID)?.body}</Body></Card> : null}
      {more && limit < 1000 ? <Button label="Load earlier messages" onPress={() => setLimit((value) => Math.min(1000, value + 50))} /> : null}
      {more && limit >= 1000 ? <Body muted>Showing the newest 1,000 messages and the selected message.</Body> : null}
      {!messages.length ? <Body>No messages in this task conversation.</Body> : messages.map((row) => <Card key={row.id}><Body muted>{row.sender_id === userID ? 'You' : 'Task participant'} · {deviceDateTime(row.created_at) ?? 'time unavailable'}</Body><Body>{row.body}</Body><WorkflowActions kind="task_message" id={row.id} /></Card>)}
      {canReply ? <TaskReplyComposer draft={draft} sending={sending} status={status} onDraft={(value) => { setDraft(value); if (status === 'sent') setStatus(null); }} onSend={() => { void send(); }} /> : null}
    </>}
  </Screen>;
}

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
//: the task's creator and its assignee answer each other here, after
// the newest message, as the website's task conversation does. The field and
// Send button are one block that the page lifts above the keyboard while the
// field has focus (ScreenKeyboardReveal, as  required). A failed send
// keeps the draft. Every word of it follows the member's language (Sol's
function TaskReplyComposer({ draft, sending, status, onDraft, onSend }: { draft: string; sending: boolean; status: 'sent' | 'failed' | null; onDraft: (value: string) => void; onSend: () => void }) {
  const theme = useTheme();
  const { t, locale } = useNativeUi();
  const keyboardReveal = useRevealAboveKeyboard();
  const block = useRef<View>(null);
  const ready = taskReplyBody(draft) !== null && !sending;
  return <View ref={block} style={styles.dock}>
    <View style={[styles.composer, { backgroundColor: theme.input, borderColor: theme.border }]}>
      <TextInput
        accessibilityLabel={t('Reply in this task')}
        multiline
        maxLength={TASK_REPLY_LIMIT}
        editable={!sending}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={draft}
        onChangeText={onDraft}
        onFocus={() => keyboardReveal.reveal(block.current)}
        onBlur={() => keyboardReveal.release(block.current)}
        placeholder={t('Write a private update about this task…')}
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
    <Text style={[styles.counter, { color: theme.mutedForeground }]}>{draft.length.toLocaleString(locale)}/{TASK_REPLY_LIMIT.toLocaleString(locale)}</Text>
    {status === 'sent' ? <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>{t('Reply sent.')}</Text> : null}
    {status === 'failed' ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{t('That message could not be sent. Your draft is still here.')}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  dock: { gap: spacing.xs },
  composer: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 24, paddingLeft: spacing.md, paddingRight: 2, paddingVertical: 2 },
  input: { flex: 1, minHeight: minimumTouchTarget - 4, maxHeight: 120, paddingVertical: 10, fontSize: 16, lineHeight: 22, textAlignVertical: 'center' },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  counter: { alignSelf: 'flex-end', fontSize: 11, lineHeight: 15, ...typeface.control },
});
