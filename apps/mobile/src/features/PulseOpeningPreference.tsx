import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { Body, Button, Card, Heading, StateMessage } from '../components/ui';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { useNativeUi } from '../lib/useNativeUi';
import { loadPulseOpening, savePulseOpening, type PulseOpening, type PulseOpeningPreference } from '../services/pulseOpeningPreference';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function usePulseOpening() {
  const { mode, session, sessionRestricted } = useApp();
  const userID = session?.user.id;
  const [value, setValue] = useState<PulseOpeningPreference | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const writable = mode === 'authenticated' && Boolean(userID) && !sessionRestricted;
  useFocusEffect(useCallback(() => {
    const version = ++generation.current;
    setValue(null); setFailed(false); setBusy(false);
    if (writable && userID) {
      void loadPulseOpening(userID).then((next) => { if (generation.current === version) setValue(next); })
        .catch(() => { if (generation.current === version) setFailed(true); });
    }
    return () => { generation.current++; };
  }, [attempt, writable, userID]));
  const save = async (opening: PulseOpening, onSaved?: (userID: string) => void) => {
    if (!writable || !userID || busy) return;
    const version = generation.current;
    setBusy(true); setFailed(false);
    try {
      const next = await savePulseOpening(userID, opening);
      if (generation.current === version) {
        setValue(next);
        onSaved?.(userID);
      }
    } catch { if (generation.current === version) setFailed(true); }
    finally { if (generation.current === version) setBusy(false); }
  };
  return { value, failed, busy, writable, save, retry: () => setAttempt((version) => version + 1) };
}

// A collapsed Account row replaces the optional Home setup card. Opening it
// is deliberate; closing it never changes the account's saved Pulse choice.
export function PulseOpeningPreferenceCard() {
  const { session } = useApp();
  return <OpeningChoice key={session?.user.id ?? 'preview'} />;
}

export function OpeningChoice() {
  const { session } = useApp();
  const userID = session?.user.id;
  const preference = usePulseOpening();
  const theme = useTheme();
  const { t } = useNativeUi();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<PulseOpening | null>(null);
  const [savedAttempt, setSavedAttempt] = useState<{ userID: string; attempt: number } | null>(null);
  const attempt = useRef(0);
  const announce = useAccessibilityAnnouncementQueue(`${useId()}:${userID ?? 'preview'}`);
  const receipt = savedAttempt && savedAttempt.userID === userID && preference.value ? t('Pulse opening choice saved.') : '';
  const receiptAttempt = savedAttempt?.attempt;
  const opening = selected ?? preference.value?.opening ?? 'week';
  useEffect(() => {
    if (receipt) return announce(receipt);
  }, [announce, receipt, receiptAttempt]);
  useEffect(() => { setSavedAttempt(null); }, [userID]);
  useFocusEffect(useCallback(() => { setSavedAttempt(null); }, []));

  function toggleChoice() {
    attempt.current += 1;
    setExpanded(!expanded);
    setSelected(null);
    setSavedAttempt(null);
  }

  function saveChoice() {
    const current = ++attempt.current;
    setSavedAttempt(null);
    void preference.save(opening, (savingUserID) => {
      // Closing the card does not cancel the write, but retires its receipt.
      if (attempt.current === current) setSavedAttempt({ userID: savingUserID, attempt: current });
    });
  }

  const savedOpening = preference.value?.opening ?? 'week';
  const summary = preference.value
    ? t(savedOpening === 'week' ? 'This week first' : 'Charts first')
    : preference.writable && !preference.failed
      ? t('This week first · Checking saved choice…')
      : t('This week first · Saved choice unavailable');
  return <View style={styles.setting}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggleChoice} style={styles.row}>
      <Text style={[styles.label, { color: theme.foreground }]}>{t('Pulse opens with')}</Text>
      <Text style={{ color: theme.primary }}>{summary}</Text>
    </Pressable>
    {expanded ? <Card>
      <Heading level={3}>{t('How should Pulse open?')}</Heading>
      <Body muted>{t('Saved for this account on this phone.')}</Body>
      {!preference.writable ? <Body muted>{t('Sign in to save an opening choice.')}</Body> : null}
      {preference.failed ? <StateMessage title={t('Your Pulse choice could not be read or saved')} body={t('Your previous saved choice has not been replaced.')} action={<Button label={t('Retry Pulse choice')} variant="secondary" onPress={preference.retry} />} /> : null}
      {!preference.value && preference.writable && !preference.failed ? <Body muted>{t('Loading your choice…')}</Body> : null}
      <View accessibilityRole="radiogroup" accessibilityLabel={t('How should Pulse open?')} style={styles.choices}>
        {(['week', 'charts'] as const).map((choice) => <Pressable key={choice}
          accessibilityRole="radio" accessibilityLabel={t(choice === 'week' ? 'This week first' : 'Charts first')}
          accessibilityState={{ checked: opening === choice, disabled: !preference.value || preference.busy }}
          disabled={!preference.value || preference.busy}
          onPress={() => { setSelected(choice); setSavedAttempt(null); }}
          style={[styles.choice, { backgroundColor: opening === choice ? theme.secondary : theme.card, borderColor: opening === choice ? theme.primary : theme.border }]}>
          <Text style={{ color: theme.foreground, ...typeface.controlStrong }}>{t(choice === 'week' ? 'This week first' : 'Charts first')}</Text>
          <Body muted>{t(choice === 'week' ? 'Your next action, then the numbered charts.' : 'The numbered charts, with This week available from a button.')}</Body>
        </Pressable>)}
      </View>
      <View style={styles.actions}>
        <Button label={t(preference.busy ? 'Saving…' : 'Save Pulse choice')} disabled={!preference.value || preference.busy} onPress={saveChoice} />
        <Button label={t('Close Pulse choice')} variant="secondary" onPress={toggleChoice} />
      </View>
      {receipt ? <Body>{receipt}</Body> : null}
    </Card> : null}
  </View>;
}

const styles = StyleSheet.create({
  setting: { gap: spacing.sm },
  row: { minHeight: minimumTouchTarget, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  label: { ...typeface.controlStrong, fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choices: { gap: spacing.sm },
  choice: { minHeight: minimumTouchTarget, padding: spacing.md, borderWidth: 1, borderRadius: radii.md, gap: spacing.xs },
});
