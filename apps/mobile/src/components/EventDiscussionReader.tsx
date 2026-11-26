// Event contact discussion reader: the organizer reads a chosen opted-in
// participant's thread, a participant reads the thread with the organizer.
// Read-only by design — replying goes through the sheet's explicit Message…
// composer, where the server rechecks consent, RSVP and organizer identity.

import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import type {
  ConnectedEventMessage,
  ConnectedPerson,
  ConnectedSourceRef,
  ConnectedWorkflowApi,
  ConnectedWorkflowContext,
} from '../lib/connectedWorkflows';
import { connectedDiscussionCopy, type ConnectedLanguage } from '../lib/connectedWorkflowsCopy';
import { deviceDateTime } from '../lib/evidenceTimestamp';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
type Props = {
  reference: ConnectedSourceRef;
  context: ConnectedWorkflowContext | null;
  api: ConnectedWorkflowApi;
  language: ConnectedLanguage;
};

function dedupePeople(rows: ConnectedPerson[], incoming: ConnectedPerson[]): ConnectedPerson[] {
  return [...new Map([...rows, ...incoming].map((person) => [person.id, person])).values()];
}

function dedupeMessages(rows: ConnectedEventMessage[], incoming: ConnectedEventMessage[]): ConnectedEventMessage[] {
  return [...new Map([...rows, ...incoming].map((message) => [message.id, message])).values()];
}

export function EventDiscussionReader({ reference, context, api, language }: Props) {
  const theme = useTheme();
  const copy = connectedDiscussionCopy[language];
  const [people, setPeople] = useState<ConnectedPerson[]>([]);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const [participant, setParticipant] = useState('');
  const [messages, setMessages] = useState<ConnectedEventMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const organizer = context?.contactRole === 'organizer';

  useEffect(() => {
    const ticket = ++generation.current;
    setError(false); setMessages([]); setCursor(null); setBusy(true);
    const request = organizer && !participant
      ? api.recipients(reference)
      : api.eventMessages(reference.id, organizer ? participant || null : null);
    Promise.resolve(request)
      .then((page) => {
        if (generation.current !== ticket) return;
        if ('status' in page) {
          if (page.status === 'unavailable') { setMessages([]); setError(true); return; }
          setPeople(page.items); setPeopleCursor(page.nextCursor);
        } else {
          if (!page.available) { setMessages([]); setError(true); return; }
          setMessages(page.items); setCursor(page.nextCursor);
        }
      })
      .catch(() => { if (generation.current === ticket) setError(true); })
      .finally(() => { if (generation.current === ticket) setBusy(false); });
    return () => { generation.current += 1; };
  }, [api, organizer, participant, reference]);

  async function more(kind: 'people' | 'messages') {
    if (busy) return;
    const ticket = generation.current;
    setBusy(true); setError(false);
    try {
      const page = kind === 'people'
        ? await api.recipients(reference, peopleCursor)
        : await api.eventMessages(reference.id, organizer ? participant || null : null, cursor);
      if (generation.current !== ticket) return;
      if ('status' in page) {
        if (page.status === 'unavailable') {
          setMessages([]); setPeople([]); setCursor(null); setPeopleCursor(null); setError(true); return;
        }
        setPeople((rows) => dedupePeople(rows, page.items)); setPeopleCursor(page.nextCursor);
      } else {
        if (!page.available) {
          setMessages([]); setPeople([]); setCursor(null); setPeopleCursor(null); setError(true); return;
        }
        setMessages((rows) => dedupeMessages(rows, page.items)); setCursor(page.nextCursor);
      }
    } catch {
      if (generation.current === ticket) { setMessages([]); setError(true); }
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }

  const rows = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return (
    <View accessibilityRole="none" accessibilityLabel={copy.participant} style={styles.block}>
      {organizer ? (
        <View style={styles.people}>
          <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.participant}</Text>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: participant === '' }}
            disabled={busy}
            onPress={() => setParticipant('')}
            style={styles.personRow}
          >
            <Text style={{ color: participant === '' ? theme.primary : theme.foreground }}>{copy.choose}</Text>
          </Pressable>
          {people.map((person) => (
            <Pressable
              key={person.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: participant === person.id }}
              disabled={busy}
              onPress={() => setParticipant(person.id)}
              style={styles.personRow}
            >
              <Text style={{ color: participant === person.id ? theme.primary : theme.foreground }}>{person.label}</Text>
            </Pressable>
          ))}
          {peopleCursor ? (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void more('people'); }} style={styles.moreRow}>
              <Text style={{ color: theme.primary }}>{copy.morePeople}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {busy ? <Text style={{ color: theme.mutedForeground }}>{copy.loading}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>{copy.failed}</Text> : null}
      {!busy && !error && !rows.length && (!organizer || participant) ? (
        <Text style={{ color: theme.mutedForeground }}>{copy.empty}</Text>
      ) : null}
      {rows.map((message) => (
        <View key={message.id} style={[styles.message, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.who, { color: theme.foreground }]}>
            {message.mine ? copy.you : message.senderRole === 'organizer' ? copy.organizer : copy.attendee}
          </Text>
          <Text style={{ color: message.redacted ? theme.mutedForeground : theme.foreground }}>
            {message.redacted ? copy.removed : message.body}
          </Text>
          <Text style={{ color: theme.mutedForeground }}>
            {deviceDateTime(message.createdAt, language === 'es' ? 'es-US' : 'en-US') ?? copy.timeUnavailable}
          </Text>
        </View>
      ))}
      {cursor ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void more('messages'); }} style={styles.moreRow}>
          <Text style={{ color: theme.primary }}>{copy.more}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  people: { gap: spacing.xs },
  label: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  personRow: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.xs },
  moreRow: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.xs },
  message: { gap: spacing.xs, padding: spacing.sm, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  who: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
});
