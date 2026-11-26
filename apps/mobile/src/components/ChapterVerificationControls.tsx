import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import { Body, Button, Heading } from './ui';
import {
  canVerifyChapterLifecycle,
  connectionVerificationRequest,
  MOBILE_CONNECTION_OUTCOMES,
  VERIFICATION_NOTE_LIMIT,
  type MobileConnectionVerification,
} from '../lib/chapterAdministration';
import { chapterVerificationCopy } from '../lib/chapterAdministrationCopy';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { ChapterVerificationError, postChapterVerification } from '../services/chapterVerification';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
function useVerification(surface: string) {
  const { dashboard, session, organizationRoles } = useApp();
  const copy = chapterVerificationCopy[dashboard?.member.language === 'es' ? 'es' : 'en'];
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'notice' | 'error'; text: string } | null>(null);
  // The outcome of an audited decision arrives below a button that still
  // holds focus. `accessibilityLiveRegion` is Android-only, so without the
  // shared queue an operator using VoiceOver would never hear whether their
  // decision landed.
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`chapter-verification:${surface}`);

  function report(next: { tone: 'notice' | 'error'; text: string }) {
    setMessage(next);
    queueAnnouncement(next.text);
  }

  async function record(
    key: string,
    request: MobileConnectionVerification | null,
    success: string,
    onRecorded: () => void,
  ) {
    if (busy || !request) return;
    setBusy(key);
    setMessage(null);
    try {
      await postChapterVerification(request, session?.access_token ?? null);
      setNote('');
      report({ tone: 'notice', text: success });
      onRecorded();
      void haptics.success();
    } catch (error) {
      const reason = error instanceof ChapterVerificationError ? error.reason : 'outcome-unconfirmed';
      report({ tone: 'error', text: copy.failure[reason] });
      // An unconfirmed outcome may have been recorded server-side. The only
      // honest next step is to re-read the request so the operator decides
      // against its current state, never against the one they last saw.
      if (reason === 'outcome-unconfirmed') onRecorded();
    } finally {
      setBusy(null);
    }
  }

  return {
    allowed: canVerifyChapterLifecycle(organizationRoles),
    busy,
    copy,
    message,
    note,
    record,
    setNote,
  };
}

function NoteField({ label, placeholder, value, onChangeText }: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (next: string) => void;
}) {
  const theme = useTheme();
  return (
    <>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardAppearance={theme.appearance}
        maxLength={VERIFICATION_NOTE_LIMIT}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
      />
    </>
  );
}

// Android reads the region; iOS is served by the announcement queue above.
function Outcome({ message }: { message: { tone: 'notice' | 'error'; text: string } | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <View accessibilityLiveRegion="polite" accessibilityRole={message.tone === 'error' ? 'alert' : 'text'}>
      {message.tone === 'error'
        ? <Body style={{ color: theme.destructive }}>{message.text}</Body>
        : <Body>{message.text}</Body>}
    </View>
  );
}

// The connection decision an organization-wide administrator records: what
// the chapter-owned provider actually does. Requesting setup stays with the
// chapter administrator on the card above this one. A chapter's union office
// binding has no control here: only a platform operator decides it
// (SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101).
export function ChapterConnectionVerification({ chapterID, capability, onRecorded }: {
  chapterID: string;
  capability: string;
  onRecorded: () => void;
}) {
  const { allowed, busy, copy, message, note, record, setNote } = useVerification(`connection:${chapterID}:${capability}`);
  if (!allowed) return null;
  return (
    <View style={styles.block}>
      <Heading level={3}>{copy.connectionTitle}</Heading>
      <Body muted>{copy.connectionBody}</Body>
      <NoteField label={copy.noteLabel} placeholder={copy.notePlaceholder} value={note} onChangeText={setNote} />
      <Outcome message={message} />
      <View style={styles.actions}>
        {MOBILE_CONNECTION_OUTCOMES.map((status) => (
          <Button
            key={status}
            label={busy === status ? copy.verifying : copy.mark[status]}
            variant={status === 'active' ? 'primary' : 'secondary'}
            disabled={busy !== null}
            onPress={() => {
              void record(
                status,
                connectionVerificationRequest({ chapterID, capability, status, publicMessage: note }),
                copy.connectionVerified,
                onRecorded,
              );
            }}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  actions: { gap: spacing.sm },
});
