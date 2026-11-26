import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discardOwnHeldText, useOwnHeldText } from '../lib/resumeDraftHolder';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { Body, Button, Heading } from './ui';

// #9369: one shell panel, outside every protected screen and route. After a
// read that got no answer at all it shows the signed-in person only the words
// they typed, read-only, with Discard and no Send. It reads nothing from the
// server and restores no access fact, so the screens behind it stay exactly
// as concealed as the failed read left them.
export function HeldWorkKeptPanel() {
  const { session, locked, privacyCovered } = useApp();
  const { t } = useNativeUi();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const held = useOwnHeldText(session?.user.id ?? null);
  if (locked || privacyCovered || held.length === 0) return null;
  return (
    <View
      testID="held-work-panel"
      accessibilityLabel={t('Your unsent words')}
      style={[styles.panel, elevation.level3, { backgroundColor: theme.card, borderColor: theme.border, bottom: insets.bottom + spacing.xl }]}
    >
      <Heading level={2}>{t('Your unsent words')}</Heading>
      <Body muted>{t('We could not reach the server, so this shows only what you typed on this phone. You can read it or discard it here. Sending returns when the connection does.')}</Body>
      <ScrollView style={styles.list}>
        {held.map((row) => (
          <View key={row.entry.key.id} style={styles.item}>
            <Body muted>{t(row.label)}</Body>
            {row.lines.map((line, index) => <Body key={index}>{line}</Body>)}
            {row.uncertain ? <Body muted>{t('This may already have been sent.')}</Body> : null}
            <Button
              label={t('Discard')}
              variant="secondary"
              testID="held-work-discard"
              disabled={!row.canDiscard}
              disabledReason={t('Still sending. You can discard this once the send finishes or fails.')}
              onPress={() => { discardOwnHeldText(row.entry); }}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute', left: spacing.md, right: spacing.md, maxHeight: '55%',
    borderWidth: 1, borderRadius: radii.cardRadius, padding: spacing.lg, gap: spacing.sm,
  },
  list: { flexGrow: 0 },
  item: { gap: spacing.xs, paddingVertical: spacing.sm },
});
