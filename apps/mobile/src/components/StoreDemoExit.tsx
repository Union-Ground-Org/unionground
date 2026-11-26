import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { storeDemoText } from '../lib/storeDemoCopy';
import { useApp } from '../state/AppProvider';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { Body } from './ui';

import { typeface } from '../theme/typeface';
// Exit demo where the DEMO pill is not drawn (an owner decision
// item 3; gate stage 122 on #8680): session recovery, an unavailable or
// locked session, the session check cover. It needs no role, no session and
// no SAMPLE server: Exit demo bounds the sign-out, removes the demo session
// from this phone and restarts on the Production sign-in
// (lib/storeDemo endStoreDemo). `floating` sits over the screen where the
// pill would; `inline` sits in a cover's own column of actions.
export function StoreDemoExit({ placement }: { placement: 'floating' | 'inline' }) {
  const { storeDemo, exitStoreDemo, storeDemoExitBusy, memberLanguage } = useApp();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [failed, setFailed] = useState(false);
  if (!storeDemo) return null;
  const t = storeDemoText(memberLanguage);
  const label = t(storeDemoExitBusy ? 'Closing the demo…' : 'Exit demo');
  const control = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Exit demo')}
      accessibilityHint={t('Returns to the Union Ground sign-in.')}
      accessibilityState={{ disabled: storeDemoExitBusy, busy: storeDemoExitBusy }}
      disabled={storeDemoExitBusy}
      testID="store-demo-exit"
      onPress={() => {
        setFailed(false);
        void exitStoreDemo().catch(() => setFailed(true));
      }}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.82 : 1 },
        placement === 'floating' ? styles.lifted : null,
      ]}
    >
      <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={[styles.label, { color: theme.foreground }]}>
        DEMO · <Text style={{ color: theme.destructive }}>{label}</Text>
      </Text>
    </Pressable>
  );
  const notice = failed ? (
    <View accessibilityLiveRegion="polite">
      <Body accessibilityRole="alert" style={{ color: theme.destructive, textAlign: 'center' }}>{t('The demo could not close. Try again.')}</Body>
    </View>
  ) : null;
  // Inline in a cover, it closes the cover's column above the home indicator.
  if (placement === 'inline') return <View style={[styles.inline, { marginBottom: insets.bottom + spacing.md }]}>{control}{notice}</View>;
  return (
    <View pointerEvents="box-none" style={[styles.floating, { top: insets.top + spacing.xs }]}>
      {control}
      {notice}
    </View>
  );
}

const styles = StyleSheet.create({
  floating: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: spacing.xs, zIndex: 20 },
  inline: { alignItems: 'center', gap: spacing.xs, marginTop: spacing.md },
  pill: {
    minHeight: minimumTouchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lifted: { ...elevation.level2 },
  label: { fontSize: 15, lineHeight: 20, ...typeface.control },
});
