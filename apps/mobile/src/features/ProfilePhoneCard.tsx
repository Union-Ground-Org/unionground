import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { useBusinessWriter, useBusinessState, useBusinessRequests } from '../lib/useBusinessWriter';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import { Body, Button, Card, Heading } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import {
  PROFILE_PHONE_MAX_LENGTH,
  PROFILE_PHONE_MIN_LENGTH,
  ProfileDetailsError,
  loadMyProfileDetails,
  saveMyProfilePhone,
  type MyProfileDetails,
  type ProfileDetailVisibility,
} from '../services/profileDetails';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

type Status = 'loading' | 'loadError' | 'ready' | 'saved' | 'saveError' | 'phoneError';

// BUG-UG-NATIVE-IOS-ACCOUNT-HAS-NO-PHONE-NUMBER-FIELD-20261117 (#9084):
// Account's phone number and who sees it, the same profile row the website's
// Settings edits (Phone number, Who sees your phone number). A PIN session
// cannot read or save profile details, so it is told to sign in with the
// password, which the step-up card under Privacy and security offers.
export function ProfilePhoneCard() {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const reads = useRef(0);
  const [refreshing, setRefreshing] = useBusinessState(false);
  const { t } = useNativeUi();
  const theme = useTheme();
  const { mode, session, sessionRestricted } = useApp();
  const userId = session?.user.id ?? null;
  const live = mode === 'authenticated' && userId !== null;
  const [details, setDetails] = useBusinessDraftState<MyProfileDetails | null>(null);
  const [phone, setPhone] = useBusinessDraftState('');
  const [phoneVisibility, setPhoneVisibility] = useBusinessDraftState<ProfileDetailVisibility>('only_me');
  const [status, setStatus] = useBusinessDraftState<Status>('loading');
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [attempt, setAttempt] = useBusinessDraftState(0);

  const refresh = useCallback(async () => {
    const at = ++reads.current; const ticket = requests.capture();
    setDetails(null); if (!live || sessionRestricted) return;
    setStatus('loading');
    try {
      const loaded = await loadMyProfileDetails();
      if (at !== reads.current || !ticket.isCurrent()) return;
      setDetails(loaded); setPhone(loaded.phone ?? ''); setPhoneVisibility(loaded.phoneVisibility); setStatus('ready');
    } catch { if (at === reads.current && ticket.isCurrent()) setStatus('loadError'); }
  }, [live, sessionRestricted, requests, setDetails, setStatus, setPhone, setPhoneVisibility]);
  useEffect(() => { void refresh(); return () => { reads.current += 1; }; }, [refresh, attempt]);

  if (!live) return null;

  async function save() {
    await operate(true, async () => {
    if (!details || busy) return;
    const ticket = requests.capture();

    try {
      const saved = await saveMyProfilePhone(writer, details, phone, phoneVisibility);
      if (ticket.isCurrent()) reads.current += 1;
      setDetails(saved);
      setPhone(saved.phone ?? '');
      setPhoneVisibility(saved.phoneVisibility);
      setStatus('saved');
    } catch (error) {
      setStatus(error instanceof ProfileDetailsError && error.reason === 'phone' ? 'phoneError' : 'saveError');
    }

    });
  }

  function edit(next: () => void) {
    next();
    if (status === 'saved' || status === 'saveError' || status === 'phoneError') setStatus('ready');
  }

  const message = status === 'saved' ? t('Phone number saved.')
    : status === 'saveError' ? t('Your phone number was not saved. Try again in a moment.')
      : status === 'phoneError' ? t('Your phone number was not saved. Check it: 7 to 40 characters, using digits, spaces and + ( ) - only.')
        : null;
  // #9467 M2-5: the save's phone rule, said under the field and read with it.
  const phoneRule = t('Digits, spaces and + ( ) . - only, {min} to {max} characters.', { min: PROFILE_PHONE_MIN_LENGTH, max: PROFILE_PHONE_MAX_LENGTH });
  const option = (value: ProfileDetailVisibility, label: string) => (
    <Button
      key={value}
      label={label}
      variant={phoneVisibility === value ? 'primary' : 'secondary'}
      selected={phoneVisibility === value}
      disabled={busy}
      icon={phoneVisibility === value ? <Body accessibilityElementsHidden style={{ color: busy ? theme.mutedForeground : theme.primaryForeground }}>✓</Body> : undefined}
      onPress={() => edit(() => setPhoneVisibility(value))}
    />
  );

  return (
    <Card>
      <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void operate(true, async () => {
        const ticket = requests.capture();
        setRefreshing(true); try { if (await checkBusinessContinuation(writer, ticket.isCurrent) === 'current') await refresh(); } finally { setRefreshing(false); }
      })} />
      <Heading level={2}>{t('Phone number')}</Heading>
      {sessionRestricted ? (
        <Body muted>{t('Sign in with your password to change your phone number.')}</Body>
      ) : status === 'loading' ? (
        <Body muted>{t('Loading your phone number…')}</Body>
      ) : status === 'loadError' || !details ? (
        <>
          <View accessibilityLiveRegion="polite"><Body style={{ color: theme.destructive }}>{t('Your phone number could not be loaded.')}</Body></View>
          <Button label={t('Retry')} variant="secondary" onPress={() => setAttempt((value) => value + 1)} />
        </>
      ) : (
        <>
          <Body muted>{t('Saved to your worker profile, the same number the website shows. Choose who can see it.')}</Body>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Phone number')}</Text>
            <TextInput
              accessibilityLabel={t('Phone number')}
              autoComplete="tel"
              textContentType="telephoneNumber"
              keyboardType="phone-pad"
              autoCorrect={false}
              accessibilityHint={phoneRule}
              maxLength={PROFILE_PHONE_MAX_LENGTH}
              editable={!busy}
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={phone}
              onChangeText={(value) => edit(() => setPhone(value))}
              style={[styles.textInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
            {/* #9467 M2-5: the format is said before a save, not only after a refusal. */}
            <Body muted>{phoneRule}</Body>
          </View>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Who sees your phone number')}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('Who sees your phone number')} style={styles.options}>
            {option('only_me', t('Only me'))}
            {option('admins', t('Me and administrators, in the worker directory'))}
          </View>
          <Button label={busy && !refreshing ? t('Saving…') : t('Save phone number')} busy={busy && !refreshing} onPress={() => { void save(); }} disabled={Boolean(busy)} />
          {message ? (
            <View accessibilityLiveRegion="polite">
              <Body style={status === 'saved' ? undefined : { color: theme.destructive }}>{message}</Body>
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  textInput: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
  options: { gap: spacing.sm },
});
