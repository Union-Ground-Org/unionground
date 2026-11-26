import { useIsFocused } from 'expo-router';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextInput } from './Text';

import { Body, Button, Card, Heading, Notice } from './ui';
import { useRevealAboveKeyboard } from './ScreenKeyboardReveal';
import { mobileConfig } from '../lib/config';
import { isUnionGroundBackend } from '../lib/configPolicy';
import { useRequestGeneration } from '../lib/useRequestGeneration';
import { readResumeDraft, resumeDraftReadsConfirmed, retireResumeDraft, settleResumeDraft, useResumeDraft, useResumeDraftKey, writeResumeDraft, type InvitationResumeDraft, type ResumeDraftKey } from '../lib/resumeDraftHolder';
import { useNativeUi } from '../lib/useNativeUi';
import { loadMemberInvitationAccess, MemberInvitationError, memberInvitationNotice, sendMemberInvitation } from '../services/memberInvitations';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

export function MemberInvitationCard() {
  const app = useApp();
  const { mode, session, organizationID, dashboard } = app;
  const resumeKey = useResumeDraftKey(app, 'invitation', 'member-invitation');
  const chapterID = dashboard?.member.chapterID;
  if (mode !== 'authenticated' || !session?.access_token || !organizationID || !chapterID || !resumeKey || !resumeDraftReadsConfirmed(app) || !isUnionGroundBackend(mobileConfig)) return null;
  return <ScopedInvitationCard key={resumeKey.id} session={session} resumeKey={resumeKey} />;
}

const emptyDraft: InvitationResumeDraft = { fullName: '', email: '', locale: 'en', notice: null };

function ScopedInvitationCard({ session, resumeKey }: { session: Session; resumeKey: ResumeDraftKey<'invitation'> }) {
  const { t, language } = useNativeUi();
  const theme = useTheme();
  const keyboardReveal = useRevealAboveKeyboard();
  const nameRow = useRef<View>(null);
  const emailRow = useRef<View>(null);
  const focused = useIsFocused();
  const requests = useRequestGeneration(session.access_token);
  const [permissionToken, setPermissionToken] = useState<string | null>(null);
  const retained = useResumeDraft(resumeKey, focused && permissionToken === session.access_token);
  const draft = retained?.value ?? emptyDraft;
  const { fullName, email, locale } = draft;
  const [notice, setNotice] = useState(false);
  const busy = retained?.pending === true;
  const sending = useRef(false);

  useEffect(() => {
    const ticket = requests.begin();
    setPermissionToken(null);
    setNotice(false);
    sending.current = false;
    if (focused) {
      void loadMemberInvitationAccess(session).then((access) => {
        if (!ticket.isCurrent()) return;
        if (access === 'enabled') setPermissionToken(session.access_token);
        else if (access === 'disabled' && !readResumeDraft(resumeKey)?.pending) retireResumeDraft(resumeKey);
      });
    }
    return requests.invalidate;
  }, [focused, requests, session, resumeKey]);

  // A refreshed bearer must complete its own switch read before any old
  // permission or draft can be painted, including the render before effects.
  if (!focused || permissionToken !== session.access_token) return null;

  function change(fields: Partial<InvitationResumeDraft>) {
    setNotice(false);
    writeResumeDraft(resumeKey, { ...draft, ...fields, notice: null });
  }

  async function send() {
    const current = readResumeDraft(resumeKey);
    if (sending.current || !current || current.pending || !current.value.fullName.trim() || !current.value.email.trim()) return;
    const pending = writeResumeDraft(resumeKey, { ...current.value, notice: null }, true);
    if (!pending) return;
    sending.current = true;
    const ticket = requests.begin();
    setNotice(false);
    try {
      await sendMemberInvitation(session, pending.value);
      // Settle even after unmount: a confirmed send must never become a
      // fresh sendable draft when its same-person owner returns.
      if (settleResumeDraft(pending, null) && ticket.isCurrent()) setNotice(true);
    } catch (error) {
      settleResumeDraft(pending, { ...pending.value, notice: error instanceof MemberInvitationError
        ? { code: error.code, retryAt: error.retryAt } : { code: 'failed', retryAt: null } });
    } finally {
      sending.current = false;
    }
  }

  const inputStyle = [styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }];
  const visibleNotice = notice ? memberInvitationNotice(undefined, language) : draft.notice
    ? memberInvitationNotice(new MemberInvitationError(draft.notice.code, draft.notice.retryAt), language) : null;
  return <Card>
    <Heading level={2}>{t('Invite someone to your campaign')}</Heading>
    <Body muted>{t('Your organization lets workers send invitations. The invitation goes straight to this address and brings them into your own campaign as a worker. When they accept and first check in at a meeting, the referral counts for you.')}</Body>
    <View ref={nameRow} style={styles.field}>
      <Body>{t('Their name')}</Body>
      <TextInput accessibilityLabel={t('Their name')} value={fullName} onChangeText={(value) => change({ fullName: value })} editable={!busy} autoComplete="name" maxLength={200} keyboardAppearance={theme.appearance} onFocus={() => keyboardReveal.reveal(nameRow.current)} onBlur={() => keyboardReveal.release(nameRow.current)} style={inputStyle} />
    </View>
    <View ref={emailRow} style={styles.field}>
      <Body>{t('Their email address')}</Body>
      <TextInput accessibilityLabel={t('Their email address')} value={email} onChangeText={(value) => change({ email: value })} editable={!busy} autoComplete="email" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={320} keyboardAppearance={theme.appearance} onFocus={() => keyboardReveal.reveal(emailRow.current)} onBlur={() => keyboardReveal.release(emailRow.current)} style={inputStyle} />
    </View>
    <Body>{t('Their language')}</Body>
    <View accessibilityRole="radiogroup" accessibilityLabel={t('Their language')} style={styles.languages}>
      <Button label="English" variant={locale === 'en' ? 'primary' : 'secondary'} selected={locale === 'en'} disabled={busy} icon={locale === 'en' ? <Body accessibilityElementsHidden style={{ color: busy ? theme.mutedForeground : theme.primaryForeground }}>✓</Body> : undefined} onPress={() => change({ locale: 'en' })} />
      <Button label="Español" variant={locale === 'es' ? 'primary' : 'secondary'} selected={locale === 'es'} disabled={busy} icon={locale === 'es' ? <Body accessibilityElementsHidden style={{ color: busy ? theme.mutedForeground : theme.primaryForeground }}>✓</Body> : undefined} onPress={() => change({ locale: 'es' })} />
    </View>
    <Button label={t('Send invitation')} busy={busy} disabled={!fullName.trim() || !email.trim()} onPress={() => { void send(); }} />
    {visibleNotice ? <Notice>{visibleNotice}</Notice> : null}
  </Card>;
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  input: { minHeight: minimumTouchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  languages: { gap: spacing.sm },
});
