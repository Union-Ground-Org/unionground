import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { createOperationKeys } from '../../../src/lib/operationKey.js';
import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { useRevealAboveKeyboard } from '../src/components/ScreenKeyboardReveal';
import { Text, TextInput } from '../src/components/Text';
import { Avatar, Body, Button, Heading, Screen, StateMessage } from '../src/components/ui';
import { useHeldScreenScope } from '../src/lib/heldScreenScope';
import {
  OfficerConversationNotStarted,
  PEER_MESSAGE_LIMIT,
  officerRoleLine,
  peerInitials,
  peerReplyBody,
  type ContactableOfficer,
  type OfficerRoleWords,
  type OfficerStartRefusal,
} from '../src/lib/peerConversations';
import { useNativeUi } from '../src/lib/useNativeUi';
import { haptics } from '../src/services/haptics';
import { loadMyContactableOfficers, startMyOfficerConversation } from '../src/services/peerConversations';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';
import { typeface } from '../src/theme/typeface';

// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162),
// part 2: the website's "Write to an officer" (src/views/MessagesView.jsx
// OfficerContactSection and the first-message form). get_chapter_leadership()
// lists who the member may write to (canMessage, the set
// start_officer_conversation() accepts); picking one opens "First message to
// {name}", and the first send opens or reuses the pair's private conversation,
// which then opens on its own screen. Sends are online only: a refused first
// message keeps the draft and is never retried by itself.
// #9227 round 1 (r1s1): the person picked, the draft and a send in flight
// belong to the content, whose scope is held while a return to the app
// re-checks the session, so leaving the app and coming back keeps them.
export default function OfficerContactRoute() {
  const { mode, session, dashboard, organizationID, confirmedMembershipScope, sessionRestricted } = useApp();
  const { t } = useNativeUi();
  const scope = useHeldScreenScope(mode === 'booting', [session?.user.id], [organizationID, dashboard?.member.chapterID, confirmedMembershipScope]);
  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const heading = t('Write to an officer');
  return (
    <PinnedHeaderScreen title={heading} screenName={heading}>
      {<OfficerContactContent key={scope} live={mode === 'authenticated'} />}
    </PinnedHeaderScreen>
  );
}

type Directory = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; officers: ContactableOfficer[] };

function OfficerContactContent({ live }: { live: boolean }) {
  const { t } = useNativeUi();
  const [directory, setDirectory] = useState<Directory>({ phase: 'loading' });
  const [revision, setRevision] = useState(0);
  const [picked, setPicked] = useState<ContactableOfficer | null>(null);
  // The person picked was no longer on the fresh list (#9227 delta F1).
  const [pickGone, setPickGone] = useState(false);
  // One draft for the screen: a message refused for one officer carries over
  // to the next person picked.
  const [draft, setDraft] = useState('');
  const sendingNow = useRef(false);
  const alive = useRef(true);
  const [sending, setSending] = useState(false);
  const [operations] = useState(() => createOperationKeys(randomUUID, { maxAgeMs: Infinity }));
  const [refusal, setRefusal] = useState<OfficerStartRefusal | 'unconfirmed' | null>(null);
  // The session that pressed Send goes with the first message (#9203).
  const { session } = useApp();
  useEffect(() => () => { alive.current = false; }, []);
  // The send lives here, not in the form, so its answer still lands when the
  // form is off screen while the session is re-checked.
  const send = async (officer: ContactableOfficer) => {
    if (sendingNow.current || peerReplyBody(draft) === null) return;
    sendingNow.current = true; setSending(true); setRefusal(null);
    try {
      const conversation = await startMyOfficerConversation(session, officer.id, draft, operations.keyFor(officer.id));
      if (!alive.current) return;
      operations.clear();
      void haptics.success();
      setDraft('');
      router.replace(`/peer-conversation/${conversation.id}` as never);
    } catch (reason: unknown) {
      if (!alive.current) return;
      setRefusal(reason instanceof OfficerConversationNotStarted ? reason.reason : 'unconfirmed');
      void haptics.warning();
    } finally {
      sendingNow.current = false;
      if (alive.current) setSending(false);
    }
  };
  useEffect(() => {
    // While the session is re-checked the old list is not trusted: the form
    // and the list wait for the list read after it (#9227 delta F1).
    if (!live) { setDirectory({ phase: 'loading' }); return undefined; }
    let current = true;
    setDirectory({ phase: 'loading' });
    void loadMyContactableOfficers().then(
      (officers) => { if (current) setDirectory({ phase: 'ready', officers }); },
      () => { if (current) setDirectory({ phase: 'error' }); },
    );
    return () => { current = false; };
  }, [live, revision]);

  // The person picked, as the latest list read has them: the form shows only
  // for someone that read still allows. Someone it no longer lists is
  // dropped (the draft stays for the next person picked) once no send for
  // them is in flight.
  const allowed = picked && directory.phase === 'ready' ? directory.officers.find((officer) => officer.id === picked.id) ?? null : null;
  useEffect(() => {
    if (!picked || directory.phase !== 'ready' || allowed || sending) return;
    setPicked(null); setRefusal(null); setPickGone(true);
  }, [picked, directory, allowed, sending]);

  // While the session is re-checked nothing protected shows; what was picked
  // and typed waits here.
  if (allowed && live) {
    return <Screen>
      <FirstOfficerMessage
        key={allowed.id}
        officer={allowed}
        draft={draft}
        onDraft={(value) => {
          if (value.trim() !== draft.trim()) operations.clear();
          setDraft(value);
        }}
        sending={sending}
        refusal={refusal}
        onSend={() => { void send(allowed); }}
        onChooseAgain={() => { setPicked(null); setRefusal(null); setRevision((value) => value + 1); }}
      />
    </Screen>;
  }
  if (!live || directory.phase === 'loading') return <Screen><StateMessage title={t('Write to an officer')} body={t("Loading your campaign's officers…")} /></Screen>;
  if (directory.phase === 'error') {
    return <Screen>
      <StateMessage title={t('Write to an officer')} body={t("Your campaign's officers could not be loaded. Try again in a moment.")} />
      <Button label={t('Try again')} onPress={() => setRevision((value) => value + 1)} />
    </Screen>;
  }
  return <Screen>
    <Body muted>{t('Write privately to an officer or administrator of your campaign. No contact code or reward is needed.')}</Body>
    {pickGone ? <Body>{t("That officer can't be messaged here any more. Choose someone else from your campaign's officers.")}</Body> : null}
    {directory.officers.length === 0
      ? <Body muted>{t('No officer or administrator of your campaign can be messaged yet.')}</Body>
      : <OfficerList officers={directory.officers} onPick={(officer) => { void haptics.select(); setPickGone(false); setPicked(officer); }} />}
  </Screen>;
}

function OfficerList({ officers, onPick }: { officers: ContactableOfficer[]; onPick: (officer: ContactableOfficer) => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const words: OfficerRoleWords = {
    titleOnly: (title) => t('{title} · title only, no access', { title }),
    treasurer: t('Treasurer'),
    president: t('Campaign lead'),
    administrator: t('Campaign administrator'),
    organizationAdministrator: t('Organization administrator'),
  };
  return <View accessibilityLabel={t('Choose who to write to')} style={styles.list}>
    <Text style={[styles.listHeading, { color: theme.mutedForeground }]}>{t('Choose who to write to')}</Text>
    {officers.map((officer) => {
      const role = officerRoleLine(officer, words);
      return <Pressable
        key={officer.id}
        accessibilityRole="button"
        accessibilityLabel={t('Write to {name}', { name: officer.name })}
        accessibilityHint={role || undefined}
        onPress={() => onPick(officer)}
        style={({ pressed }) => [styles.row, { borderColor: theme.border, backgroundColor: pressed ? theme.muted : theme.card }]}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Avatar initials={peerInitials({ peerInitials: '', peerName: officer.name })} size={40} /></View>
        <View style={styles.rowCopy}>
          <Text style={[styles.rowName, { color: theme.foreground }]}>{officer.name}</Text>
          {role ? <Text style={[styles.rowRole, { color: theme.mutedForeground }]}>{role}</Text> : null}
        </View>
        <Ionicons accessible={false} name="chevron-forward" size={18} color={theme.mutedForeground} />
      </Pressable>;
    })}
  </View>;
}

function FirstOfficerMessage({ officer, draft, onDraft, sending, refusal, onSend, onChooseAgain }: {
  officer: ContactableOfficer;
  draft: string;
  onDraft: (value: string) => void;
  sending: boolean;
  refusal: OfficerStartRefusal | 'unconfirmed' | null;
  onSend: () => void;
  onChooseAgain: () => void;
}) {
  const theme = useTheme();
  const { t, locale } = useNativeUi();
  const keyboardReveal = useRevealAboveKeyboard();
  const block = useRef<View>(null);
  const ready = peerReplyBody(draft) !== null && !sending;
  // The website's refusal words (rpcError.officer_*, inbox.startConversationError).
  const refusalText = refusal === 'officer_unavailable'
    ? t("That officer can't be messaged here any more. Choose someone else from your campaign's officers.")
    : refusal === 'officer_contact_limit'
      ? t('You have started three new conversations in the last 24 hours. Try again tomorrow, or continue a conversation you already have.')
      : refusal === 'not_started' ? t("The conversation couldn't be started. Your message is still here; try again.")
        : refusal === 'unconfirmed' ? t('We could not confirm that your message was sent. Check the conversation before sending again.') : null;
  return <View style={styles.form}>
    <Heading level={2}>{t('First message to {name}', { name: officer.name })}</Heading>
    <View ref={block} style={styles.dock}>
      <View style={[styles.composer, { backgroundColor: theme.input, borderColor: theme.border }]}>
        <TextInput
          accessibilityLabel={t('Write to {name}', { name: officer.name })}
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
      </View>
      <Text style={[styles.counter, { color: theme.mutedForeground }]}>{draft.length.toLocaleString(locale)}/{PEER_MESSAGE_LIMIT.toLocaleString(locale)}</Text>
      <Text style={[styles.visibility, { color: theme.mutedForeground }]}>{t('A conversation with one officer or worker: only you and {name} can read it. Committee members, other officers and your employer cannot.', { name: officer.name })}</Text>
      <Button label={sending ? t('Sending message') : t('Send message')} busy={sending} disabled={!ready} onPress={onSend} />
      {refusalText ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{refusalText}</Text> : null}
      <Button label={t('Choose someone else')} variant="secondary" disabled={sending} onPress={onChooseAgain} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm, paddingTop: spacing.sm },
  listHeading: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  row: { minHeight: 64, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowCopy: { flex: 1, gap: 1 },
  rowName: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  rowRole: { fontSize: 12, lineHeight: 16, ...typeface.bodyMedium },
  form: { gap: spacing.md },
  dock: { gap: spacing.sm },
  composer: { minHeight: minimumTouchTarget * 2, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: 2 },
  input: { flex: 1, minHeight: minimumTouchTarget * 2 - 4, maxHeight: 200, paddingVertical: 10, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', fontSize: 11, lineHeight: 15, ...typeface.control },
  visibility: { fontSize: 12, lineHeight: 17, ...typeface.bodyMedium },
});
