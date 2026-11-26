import { useNativeUi } from "../lib/useNativeUi";
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body, Card, Heading } from '../components/ui';
import { getHapticPreferenceState, initializeHapticPreference, saveHapticPreference, subscribeHapticPreference, type HapticPreference } from '../services/hapticPreference';
import { haptics } from '../services/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
const choices: { value: HapticPreference; label: string; body: string }[] = [
  { value: 'system', label: 'System / default', body: 'Standard feedback, subject to your phone’s settings.' },
  { value: 'subtle', label: 'Subtle', body: 'Gentle selection feedback for actions and confirmations.' },
  { value: 'off', label: 'Off', body: 'No app haptic feedback.' },
];

export function HapticPreferencesCard() {
  const { t, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const state = useSyncExternalStore(subscribeHapticPreference, getHapticPreferenceState, getHapticPreferenceState);
  const [tested, setTested] = useState(false);
  const [saved, setSaved] = useState(false);
  const testDisabled = !state.ready || state.saving || state.preference === 'off';
  useEffect(() => { void initializeHapticPreference(); }, []);

  async function choose(value: HapticPreference) {
    if (state.saving || (state.ready && value === state.preference && !state.error)) return;
    setTested(false);
    setSaved(false);
    const changed = !state.ready || value !== state.preference;
    try {
      await saveHapticPreference(value);
      setSaved(true);
      if (changed) void haptics.select();
    } catch { /* The shared state exposes the persistence failure. */ }
  }

  return (
    <Card>
      <Heading level={2}>{t("Haptic feedback")}</Heading>
      <Body muted>{t("Choose how this app feels on this phone. Your choice applies to every account on this phone.")}</Body>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("Haptic feedback")} style={styles.choices}>
        {choices.map(({ value, label, body }) => {
          const selected = state.ready && state.preference === value;
          const disabled = state.loading || state.saving;
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={catalogLabel(label)}
              accessibilityHint={catalogLabel(body)}
              accessibilityState={{ checked: selected, selected, disabled, busy: state.saving }}
              disabled={disabled}
              onPress={() => { void choose(value); }}
              style={({ pressed }) => [styles.choice, { backgroundColor: selected || pressed ? theme.secondary : theme.card, borderColor: selected ? theme.ring : theme.border }]}
            >
              <Text style={[styles.label, { color: selected ? theme.secondaryForeground : theme.cardForeground }]}>{selected ? '✓ ' : ''}{catalogLabel(label)}</Text>
              <Text style={{ color: selected ? theme.secondaryForeground : theme.mutedForeground }}>{catalogLabel(body)}</Text>
            </Pressable>
          );
        })}
      </View>
      {state.loading ? <Body muted>{t("Loading your saved choice…")}</Body> : null}
      <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>
        {state.saving ? t("Saving…") : saved && !state.error ? t("Choice saved on this phone.") : ''}
      </Text>
      {state.error ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>
        {state.error === 'load'
          ? t("Your saved choice could not be read. Feedback is paused. Choose a setting to try saving it again.")
          : t("This choice is active for this session but could not be saved. Select it again to retry before closing the app.")}
      </Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Test haptic feedback")}
        accessibilityHint={t("Try the confirmation feedback for your selected setting.")}
        accessibilityState={{ disabled: testDisabled }}
        disabled={testDisabled}
        onPress={() => { void haptics.success(); setTested(true); }}
        style={[styles.choice, { backgroundColor: testDisabled ? theme.muted : theme.secondary, borderColor: theme.border }]}
      >
        <Text style={[styles.label, { color: testDisabled ? theme.mutedForeground : theme.secondaryForeground }]}>{t("Test haptic feedback")}</Text>
      </Pressable>
      {tested ? <Body muted>{t("Feedback requested. Only you can confirm whether you felt it.")}</Body> : null}
      <Body muted>{t("Feedback depends on your phone’s hardware and system settings. On iPhone, Low Power Mode, camera use or dictation may suppress it.")}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  choices: { gap: spacing.sm },
  choice: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, justifyContent: 'center', gap: spacing.xs },
  label: { fontSize: 16, ...typeface.control },
});
