import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '../components/Text';
import { Body, Button } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';
import { recordFeatureMark } from './guideLayers/guideLayersData';

// Optional reference, deliberately opened from Account. The closed state is
// the default on every launch and never carries across an account switch.
export function HomeGuidePreference() {
  const { session } = useApp();
  return <HomeGuideRow key={session?.user.id ?? 'preview'} />;
}

function HomeGuideRow() {
  const { session } = useApp();
  const { t } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const close = (acted = false) => {
    setExpanded(false);
    if (session) {
      if (acted) void recordFeatureMark(session.user.id, 'acted', 'home', Date.now());
      void recordFeatureMark(session.user.id, 'got', 'home', Date.now());
    }
  };
  return <View style={styles.setting}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${t('About Home')}, ${t(expanded ? 'Hide Home guide' : 'Show Home guide')}`} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.row}>
      <Text style={[styles.label, { color: theme.foreground }]}>{t('About Home')}</Text>
      <Text style={{ color: theme.primary }}>{t(expanded ? 'Hide Home guide' : 'Show Home guide')}</Text>
    </Pressable>
    {expanded ? <View style={styles.details}>
      <Body>{t("See your next step and what's new.")}</Body>
      <Body>{t('Ask the committee for help with a problem at work.')}</Body>
      <Body>{t("Never post a coworker's health, discipline or personal details.")}</Body>
      <View style={styles.actions}>
        <Button label={t("See what's next")} onPress={() => { close(true); router.push('/(tabs)/home'); }} />
        <Button label={t('Got it')} variant="secondary" onPress={() => close()} />
      </View>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  setting: { gap: spacing.sm },
  row: { minHeight: minimumTouchTarget, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  label: { ...typeface.controlStrong, fontSize: 16 },
  details: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
