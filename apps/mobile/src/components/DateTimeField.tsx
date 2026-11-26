import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Body, Button } from './ui';
import { useNativeUi } from '../lib/useNativeUi';
import { easternDateTime } from '../lib/evidenceTimestamp';
import { loadNativeDateTimePicker, type NativePickerEvent } from '../lib/nativeDateTimePicker';
import { useTheme } from '../theme/ThemeProvider';
import { spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

// A date and time chosen with the system dialog (#9091 part 3, deadline and
// extension dates). iOS takes both in one dialog; Android has no combined
// dialog, so it asks for the date and then the time. mode 'date' (#9091 part
// 4, a case's own deadline, a calendar date) asks for the date only.
export function DateTimeField({ label, value, onChange, minimumDate, disabled = false, mode = 'datetime' }: {
  label: string;
  value: Date | null;
  onChange: (value: Date) => void;
  minimumDate?: Date;
  disabled?: boolean;
  mode?: 'datetime' | 'date';
}) {
  const { t, locale } = useNativeUi();
  const theme = useTheme();
  const [step, setStep] = useState<null | 'date' | 'time' | 'datetime'>(null);
  const [draft, setDraft] = useState<Date | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const Picker = step ? loadNativeDateTimePicker() : null;

  function open() {
    if (disabled) return;
    if (!loadNativeDateTimePicker()) {
      setUnavailable(true);
      return;
    }
    setDraft(value ?? minimumDate ?? new Date());
    setStep(mode === 'date' || Platform.OS === 'android' ? 'date' : 'datetime');
  }

  function picked(event: NativePickerEvent) {
    const timestamp = event.nativeEvent?.timestamp;
    if (event.type === 'dismissed' || !timestamp) {
      setStep(null);
      return;
    }
    const chosen = new Date(timestamp);
    if (step === 'date' && mode === 'datetime') {
      const merged = new Date(draft ?? chosen);
      merged.setFullYear(chosen.getFullYear(), chosen.getMonth(), chosen.getDate());
      setDraft(merged);
      setStep('time');
      return;
    }
    setStep(null);
    onChange(chosen);
  }

  // Shown in Eastern time with the zone named, as the deadlines it sets are.
  const shown = !value ? (mode === 'date' ? t('Choose a date') : t('Choose date and time'))
    // A calendar date reads as the day the person picked, with no time.
    : mode === 'date' ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(value)
      : easternDateTime(value.toISOString(), locale === 'es-US' ? 'es-US' : 'en-US') ?? t('Time unavailable');
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.foreground }]}>{label}</Text>
      <Button label={shown} accessibilityLabel={`${label}: ${shown}`} variant="secondary" disabled={disabled} onPress={open} />
      {unavailable ? <Body style={{ color: theme.destructive }}>{t('This build cannot open the system date picker. Try again after reinstalling the app.')}</Body> : null}
      {step && Picker ? (
        <Picker value={draft ?? new Date()} mode={step} minimumDate={minimumDate} display="default" onChange={picked} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
});
