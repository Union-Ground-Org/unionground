import { useRef, useState } from 'react';
import { BUSINESS_SAVED_STALE } from '../lib/businessWriteContinuation';
import { StyleSheet, View } from 'react-native';
import { useApp } from '../state/AppProvider';
import { useNativeUi } from '../lib/useNativeUi';
import { type NativeLanguage } from '../lib/nativeUiCopy';
import { spacing } from '../theme/tokens';
import { Body, Button, Card, Heading, Notice } from './ui';

/** One explicit, immediately saved preference, above the device settings. */
export function LanguageSettingsCard({ disabled = false, onBusyChange }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { dashboard, saveProfile, captureAccountSessionGuard, sampleHat } = useApp();
  const { language, t } = useNativeUi();
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'saved' | 'stale' | 'failed' | null>(null);
  async function choose(next: NativeLanguage) {
    if (!dashboard || disabled || working.current || next === language) return;
    working.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setResult(null);
    const current = captureAccountSessionGuard(dashboard.member.id);
    try {
      // Use the saved names, never unsaved profile-edit fields.
      const proof = await saveProfile({ firstName: dashboard.member.firstName, fullName: dashboard.member.fullName, language: next });
      if (current()) setResult(proof === 'current' ? 'saved' : 'stale');
    } catch {
      if (current()) setResult('failed');
    } finally {
      working.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return <Card>
    <Heading level={2}>{t('Language / Idioma')}</Heading>
    {/* #9776: a demo person is a shared account, so the choice stays in this app. */}
    <Body muted>{t(sampleHat ? 'Choose your app language here. In the demo, your choice follows you between roles and resets when you leave the demo or close the app.' : 'Choose your app language here. It is saved to your worker profile.')}</Body>
    <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={t('App language')}>
      {(['en', 'es'] as const).map((value) => <Button key={value}
        testID={value === 'es' ? 'account-language-es' : 'account-language-en'}
        label={value === 'es' ? 'Español' : 'English'}
        selected={language === value}
        variant={language === value ? 'primary' : 'secondary'}
        disabled={disabled || busy || !dashboard} onPress={() => { void choose(value); }} />)}
    </View>
    {busy ? <Body>{t('Saving…')}</Body> : result === 'failed'
      ? <Notice>{t('Your language could not be saved. Try again.')}</Notice>
      : result === 'stale' ? <View accessibilityLiveRegion="polite"><Body>{t(BUSINESS_SAVED_STALE)}</Body></View>
        : result === 'saved' ? <View accessibilityLiveRegion="polite"><Body testID={language === 'es' ? 'account-language-saved-es' : 'account-language-saved-en'}>{t('Language saved.')}</Body></View> : null}
  </Card>;
}

const styles = StyleSheet.create({ choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm } });
