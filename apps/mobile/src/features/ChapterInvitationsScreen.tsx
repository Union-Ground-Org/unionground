import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { TextInput } from '../components/Text';

import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import { SavedWorkCheckFailed } from '../components/SavedWorkCheckFailed';
import { useNativeUi } from '../lib/useNativeUi';
import {
  ChapterInvitationError,
  invitationDisplayStatus,
  invitationIsActionable,
  loadChapterInvitations,
  resendChapterInvitation,
  revokeChapterInvitation,
  sendChapterInvitation,
  type ChapterInvitation,
  type InvitationDesk,
  type InvitationSession,
} from '../services/chapterInvitations';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 4 of 4): working as Chapter Administrator or President, an
// officer invites a member and sees pending invitations, with Resend and
// Revoke, as the website's invitation desk does (PresidentInvitations.jsx).
// The phone sends a plain invitation with no starting access.
//
// The save rules #9099 parts 1-3 ended with: a send whose answer was lost, or
// whose email the server could not confirm, keeps the form locked and marked
// unconfirmed, with Check the list, Send again and Cancel; it is cleared only
// by a send that succeeds or by Cancel. Sending the same invitation again is
// safe: the route answers "accepted" and sends nothing when the address
// already has a pending invitation.
//
// Every change carries the session the officer held when they pressed the
// button (the Revoke confirmation included), and is dropped, unsent, when this
// screen has gone or another account is signed in by the time it would leave.
//
// #9240 PR A: the unsent form waits in memory through a session check for the
// same person in the same organization (src/lib/retainedDraft.ts). A send in
// flight keeps it locked; a send whose answer is lost keeps it locked and
// unconfirmed after the screen returns, with the same three buttons, through
// any later failed retry. The chapter is held once the officer picks one or
// sends; a held chapter that the fresh desk no longer lists is never replaced.

type Outcome = { tone: 'error' | 'status'; text: NativeUiKey } | null;
type Draft = { fullName: string; email: string; chapterId: string; locale: 'en' | 'es' };
const invitationSurface = defineRetainedSurface<Held<Draft>>('chapter-invitation');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LANGUAGES: readonly (readonly ['en' | 'es', string])[] = [['en', 'English'], ['es', 'Español']];

function failureText(error: unknown): NativeUiKey {
  const code = error instanceof ChapterInvitationError ? error.code : 'service-unavailable';
  if (code === 'email-domain-blocked') return "Use a personal email address. Government and employer email addresses can't be used for a Union Ground account.";
  if (code === 'rate-limited') return 'You have sent as many invitations as you can for now. Try again later.';
  if (code === 'not-permitted' || code === 'request-unavailable') return 'This account cannot invite workers to that campaign.';
  if (code === 'invalid-request') return 'Check the name and email address, then try again.';
  if (code === 'session-expired') return 'Your session ended. Sign in again, then try again.';
  return 'The invitation could not be sent. Try again.';
}

export function ChapterInvitationsScreen({ title }: { title: string }) {
  const { t, language, locale, catalogLabel } = useNativeUi();
  const { session } = useApp();
  const theme = useTheme();
  const currentSession = useRef(session);
  currentSession.current = session;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [desk, setDesk] = useState<InvitationDesk | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const retained = useRetainedDraft<Draft>({ surface: invitationSurface, item: 'invite-a-member', empty: { fullName: '', email: '', chapterId: '', locale: language }, fresh: desk !== null, scope: 'organization' });
  const busy = retained.pending === 'sending';
  // An invitation that may have gone out: the form is then locked.
  const unconfirmed = retained.pending === 'uncertain';
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<Outcome>(null);
  const frozen = busy || unconfirmed;
  const refuseHeld = useRef(retained.refused);
  refuseHeld.current = retained.refused;
  const chapters = desk?.chapters.length ? desk.chapters : desk?.chapter ? [desk.chapter] : [];
  const deskChapter = desk?.chapter?.id ?? desk?.chapters[0]?.id ?? '';
  // A chapter the officer chose, or that an attempt carries, is part of the
  // draft: a fresh desk never replaces it with its own (#9375 r1s2, r2s2). If
  // that chapter is no longer listed, nothing is sent until the officer picks
  // again (an unsent draft) or cancels (an unconfirmed one).
  const heldChapter = retained.value.chapterId;
  const chapterListed = chapters.some((chapter) => chapter.id === heldChapter);
  const lostChapter = desk !== null && heldChapter !== '' && !chapterListed;
  const draft: Draft = { ...retained.value, chapterId: heldChapter === '' ? deskChapter : chapterListed ? heldChapter : '' };

  useEffect(() => {
    let current = true;
    setLoadFailed(false);
    void loadChapterInvitations()
      .then((next) => { if (current) setDesk(next); })
      .catch((error: unknown) => {
        if (!current) return;
        setLoadFailed(true);
        // A refused desk read retires the held form; a lost one keeps it.
        refuseHeld.current(error);
      });
    return () => { current = false; };
  }, [reload]);

  // The session as the officer pressed the button, and whether it is still
  // this screen's and the app's account.
  function capture(): InvitationSession | null {
    const held = currentSession.current;
    return held?.access_token && held.user?.id ? { access_token: held.access_token, user: { id: held.user.id } } : null;
  }
  function stillCurrent(initiating: InvitationSession): boolean {
    return mounted.current && currentSession.current?.user?.id === initiating.user.id;
  }

  function change(patch: Partial<Draft>) {
    setOutcome(null);
    // The first edit binds the chapter shown beside it: no later desk reload
    // or default change moves typed text to another chapter (#9375 r3s1, r4s1).
    retained.set(heldChapter === '' && draft.chapterId !== '' ? { chapterId: draft.chapterId, ...patch } : patch);
  }

  // As Main's clear(), Cancel keeps the officer's chapter choice.
  function cancel() {
    const chapterId = draft.chapterId;
    retained.discard();
    if (chapterId !== deskChapter) retained.set({ chapterId });
    setOutcome(null);
  }

  async function send() {
    if (busy || lostChapter) return;
    if (draft.fullName.trim().length < 1 || draft.fullName.trim().length > 160) {
      setOutcome({ tone: 'error', text: 'Add the name of the person you are inviting.' });
      return;
    }
    if (!EMAIL.test(draft.email.trim())) {
      setOutcome({ tone: 'error', text: 'Check the name and email address, then try again.' });
      return;
    }
    if (!draft.chapterId) {
      setOutcome({ tone: 'error', text: 'This account cannot invite workers to that campaign.' });
      return;
    }
    const initiating = capture();
    if (!initiating || !stillCurrent(initiating)) {
      setOutcome({ tone: 'error', text: 'Your session ended. Sign in again, then try again.' });
      return;
    }
    // The attempt carries its chapter from the first press on.
    if (heldChapter !== draft.chapterId) retained.set({ chapterId: draft.chapterId });
    // One attempt at a time, held through an unmount; from an unconfirmed
    // send this is the officer's deliberate Send again, to the same chapter.
    const attempt = retained.begin();
    if (!attempt) return;
    const { chapterId } = attempt.value;
    setOutcome(null);
    try {
      await sendChapterInvitation(initiating, attempt.value);
      attempt.settle('done');
      if (!mounted.current) return;
      void haptics.success();
      // As before, the officer's chapter choice stays for the next invitation.
      if (chapterId !== deskChapter) retained.set({ chapterId });
      setOutcome({ tone: 'status', text: 'If that address can be invited, the invitation is on its way.' });
      setReload((value) => value + 1);
    } catch (error) {
      const uncertain = error instanceof ChapterInvitationError && error.code === 'unconfirmed';
      attempt.settle(uncertain ? 'uncertain' : { failed: failureText(error) });
    }
  }

  async function act(invitation: ChapterInvitation, action: 'resend' | 'revoke', initiating: InvitationSession | null) {
    if (rowBusy || !initiating || !stillCurrent(initiating)) return;
    setRowBusy(invitation.id);
    setRowNotice(null);
    try {
      if (action === 'resend') await resendChapterInvitation(initiating, invitation.id);
      else await revokeChapterInvitation(initiating, invitation.id);
      void haptics.success();
      setRowNotice({ tone: 'status', text: action === 'resend' ? 'Invitation sent again.' : 'Invitation revoked.' });
      setReload((value) => value + 1);
    } catch (error) {
      setRowNotice({
        tone: 'error',
        text: error instanceof ChapterInvitationError && error.code === 'unconfirmed'
          ? 'We could not confirm that change. Check the invitation below before trying again.'
          : 'That invitation could not be changed. Try again.',
      });
      setReload((value) => value + 1);
    } finally {
      setRowBusy(null);
    }
  }

  function confirmRevoke(invitation: ChapterInvitation) {
    // Captured when Revoke is pressed: a confirmation answered after another
    // account signed in, or after this screen closed, sends nothing.
    const initiating = capture();
    if (!initiating || !stillCurrent(initiating)) return;
    Alert.alert(t('Revoke this invitation?'), `${invitation.fullName || invitation.email}\n\n${t('The link stops working. You can invite the person again later.')}`, [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Revoke'), style: 'destructive', onPress: () => { void act(invitation, 'revoke', initiating); } },
    ]);
  }

  const when = (value: string | null) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
      : '';
  };
  const statusLine = (invitation: ChapterInvitation) => {
    const shown = invitationDisplayStatus(invitation, Date.now());
    if (shown === 'pending') return invitation.expiresAt ? t('Pending · link works until {when}', { when: when(invitation.expiresAt) }) : t('Pending');
    if (shown === 'accepted') return invitation.acceptedAt ? t('Accepted {when}', { when: when(invitation.acceptedAt) }) : t('Accepted');
    if (shown === 'revoked') return invitation.revokedAt ? t('Revoked {when}', { when: when(invitation.revokedAt) }) : t('Revoked');
    if (shown === 'delivery_failed') return t('Delivery failed');
    if (shown === 'accepting') return t('Being accepted');
    if (shown === 'superseded') return t('Reissued');
    if (shown === 'expired') return t('Expired');
    return '';
  };
  const inputStyle = [styles.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }];
  const outcomeView = (value: Outcome) => (value
    ? <Body accessibilityRole={value.tone === 'error' ? 'alert' : undefined} style={value.tone === 'error' ? { color: theme.destructive } : undefined}>{t(value.text)}</Body>
    : null);
  const formOutcome: Outcome = unconfirmed
    ? { tone: 'error', text: 'We could not confirm this invitation was sent. Check the invitations below first; sending it again does not send a second one while it is pending.' }
    : outcome ?? (retained.failed ? { tone: 'error', text: retained.failed as NativeUiKey } : null);

  return (
    <Screen>
      {/* The pinned title row shows this name translated (app/feature/[key].tsx); the
          same words here are hidden by Heading, in either language. */}
      <Heading>{catalogLabel(title)}</Heading>
      {loadFailed && !desk ? <Card>
        <Body style={{ color: theme.destructive }}>{t('Invitations could not be loaded. This account may not invite workers to this campaign.')}</Body>
        <Button label={t('Try again')} variant="secondary" onPress={() => setReload((value) => value + 1)} />
      </Card> : desk === null ? <StateMessage title={t('Loading invitations')} body={t('Getting the invitations for your campaign.')} /> : <>
        {/* Only the form waits on the holder; the list, Resend and Revoke stay. */}
        {!retained.shown ? <Card>
          <Heading level={3}>{t('Invite a worker')}</Heading>
          {retained.checkFailed ? <SavedWorkCheckFailed /> : <Body muted>{t('Loading your work')}</Body>}
        </Card> : <Card>
          <Heading level={3}>{t('Invite a worker')}</Heading>
          <Body muted>{t('They get an email with a link to set up their account.')}</Body>
          <TextInput accessibilityLabel={t('Full name')} value={draft.fullName} onChangeText={(fullName) => change({ fullName })} placeholder={t('Full name')}
            placeholderTextColor={theme.quietForeground} keyboardAppearance={theme.appearance} maxLength={160} editable={!frozen} style={inputStyle} />
          <TextInput accessibilityLabel={t('Email')} value={draft.email} onChangeText={(email) => change({ email })} placeholder={t('Email')}
            placeholderTextColor={theme.quietForeground} keyboardAppearance={theme.appearance} maxLength={254} editable={!frozen}
            autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={inputStyle} />
          {lostChapter ? outcomeView({ tone: 'error', text: 'This account cannot invite workers to that campaign.' }) : null}
          {chapters.length > 1 || (lostChapter && !unconfirmed) ? <View style={styles.actions} accessibilityRole="radiogroup" accessibilityLabel={t('Campaign')}>
            {chapters.map((chapter) => (
              <Button key={chapter.id} label={chapter.name} selected={draft.chapterId === chapter.id} variant={draft.chapterId === chapter.id ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ chapterId: chapter.id })} />
            ))}
          </View> : chapters[0] ? <Body muted>{chapters[0].name}</Body> : null}
          <Body>{t('Invitation language')}</Body>
          <View style={styles.actions} accessibilityRole="radiogroup" accessibilityLabel={t('Invitation language')}>
            {LANGUAGES.map(([value, label]) => (
              <Button key={value} label={label} selected={draft.locale === value} variant={draft.locale === value ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ locale: value })} />
            ))}
          </View>
          {outcomeView(formOutcome)}
          {unconfirmed && retained.failed ? outcomeView({ tone: 'error', text: retained.failed as NativeUiKey }) : null}
          <View style={styles.actions}>
            {unconfirmed ? <Button label={t('Check the invitations')} variant="secondary" disabled={busy} onPress={() => setReload((value) => value + 1)} /> : null}
            <Button label={unconfirmed ? t('Send again') : t('Send invitation')} busy={busy} disabled={lostChapter && unconfirmed} onPress={() => { void send(); }} />
            {unconfirmed ? <Button label={t('Cancel')} variant="secondary" disabled={busy} onPress={cancel} /> : null}
          </View>
        </Card>}
        <Heading level={2}>{t('Invitations')}</Heading>
        {outcomeView(rowNotice)}
        {loadFailed ? <Body style={{ color: theme.destructive }}>{t('Invitations could not be refreshed.')}</Body> : null}
        {desk.items.length === 0 ? <Body muted>{t('No invitations yet.')}</Body> : desk.items.map((invitation) => {
          const actionable = invitationIsActionable(invitationDisplayStatus(invitation, Date.now()));
          const name = invitation.fullName || invitation.email;
          const line = statusLine(invitation);
          return (
            <Card key={invitation.id}>
              <Heading level={3}>{name}</Heading>
              {invitation.fullName ? <Body muted>{invitation.email}</Body> : null}
              {line ? <Body muted>{line}</Body> : null}
              {actionable ? <View style={styles.actions}>
                <Button label={t('Resend')} accessibilityLabel={t('Resend the invitation to {name}', { name })} variant="secondary" busy={rowBusy === invitation.id} disabled={rowBusy !== null} onPress={() => { void act(invitation, 'resend', capture()); }} />
                <Button label={t('Revoke')} accessibilityLabel={t('Revoke the invitation to {name}', { name })} variant="secondary" disabled={rowBusy !== null} onPress={() => confirmRevoke(invitation)} />
              </View> : null}
            </Card>
          );
        })}
      </>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { minHeight: minimumTouchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16 },
});
