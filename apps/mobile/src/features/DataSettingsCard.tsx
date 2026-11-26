import { useNativeUi } from "../lib/useNativeUi";
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body, Button, Card, Heading, Notice } from '../components/ui';
import type { LowDataMode } from '../lib/lowDataPolicy';
import { setLowDataMode } from '../services/lowData';
import { useLowData } from '../state/useLowData';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function DataSettingsCard() {
  const { t, catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const policy = useLowData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(mode: LowDataMode) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await setLowDataMode(mode); }
    catch { setError(t("Your data preference could not be saved. Try again.")); }
    finally { setBusy(false); }
  }

  return <>
    <Heading level={2}>{t("Data and downloads")}</Heading>
    <Card>
      <Heading level={3}>{t("Low data")}</Heading>
      <Body muted>{t("Fewer background updates and photos on request. Refresh and file opening stay available.")}</Body>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("Low data")} style={styles.options}>
        {(['auto', 'on', 'off'] as const).map((mode) => <Pressable
          testID={mode === 'on' ? 'account-low-data-on' : mode === 'off' ? 'account-low-data-off' : 'account-low-data-auto'}
          key={mode} accessibilityRole="radio" accessibilityLabel={`${t('Low data')}, ${mode === 'auto' ? t('Automatic') : mode === 'on' ? t('On') : t('Off')}`}
          accessibilityState={{ checked: policy.mode === mode, disabled: busy }} disabled={busy}
          onPress={() => { void choose(mode); }}
          style={({ pressed }) => [styles.option, {
            backgroundColor: policy.mode === mode ? theme.primary : theme.secondary,
            borderColor: policy.mode === mode ? theme.primary : theme.border,
            opacity: pressed ? 0.85 : 1,
          }]}
        ><Text style={{ color: policy.mode === mode ? theme.primaryForeground : theme.secondaryForeground, ...typeface.controlStrong }}>{mode === 'auto' ? t('Automatic') : mode === 'on' ? t("On") : t("Off")}</Text></Pressable>)}
      </View>
      <Body testID={busy || error ? undefined : policy.mode === 'on' ? 'account-low-data-saved-on' : policy.mode === 'off' ? 'account-low-data-saved-off' : 'account-low-data-saved-auto'}>{policy.enabled ? t("Low data is active.") : t("Normal data use.")}</Body>
      <Body muted>{catalogLabel(policy.reason)}</Body>
      {error ? <Notice>{error}</Notice> : null}
    </Card>
    <Card>
      <Heading level={3}>{t("Saved guides and notes")}</Heading>
      <Body muted>{t("Choose public guides to download and manage personal learning notes on this phone.")}</Body>
      <Button label={t("Manage saved guides and notes")} variant="secondary" onPress={() => router.push('/offline' as never)} />
    </Card>
  </>;
}

const styles = StyleSheet.create({
  options: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  option: { minHeight: minimumTouchTarget, minWidth: minimumTouchTarget, flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderRadius: radii.md },
});
