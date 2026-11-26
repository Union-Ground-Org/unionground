import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body } from '../components/ui';
import { nativeShortcutGuideCopy } from '../lib/nativeShortcutGuide';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
// REQ-UG-APP-SHORTCUTS-SIRI-PHRASES-20261029: the Account entry that
// tells a member which fixed shortcuts this phone offers. iOS lists the
// declared Siri phrases; Android lists the launcher shortcuts and offers no
// Siri controls. Static text only: nothing here reads the network.
export function NativeShortcutsGuideCard() {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const copy = nativeShortcutGuideCopy(Platform.OS);
  if (!copy) return null;

  return (
    <View style={[styles.container, { borderColor: theme.border }]}>
      <View style={styles.header}>
        <Ionicons name="flash-outline" size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <View style={styles.flex}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.foreground }]}>{copy.title}</Text>
          <Body muted>{copy.summary}</Body>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Hide ${copy.title.toLowerCase()} guide` : `Show ${copy.title.toLowerCase()} guide`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.toggle, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.toggleText, { color: theme.secondaryForeground }]}>{expanded ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {expanded ? (
        <View style={styles.details}>
          {copy.steps.map((step) => <Body key={step}>{step}</Body>)}
          {copy.rows.map((row) => (
            <View key={row.id} style={[styles.row, { borderColor: theme.border }]}>
              <Text accessibilityRole="header" style={[styles.rowTitle, { color: theme.foreground }]}>{row.title}</Text>
              {row.phrases.map((phrase) => <Body key={phrase}>{`“${phrase}”`}</Body>)}
            </View>
          ))}
          {copy.notes.map((note) => <Body key={note} muted>{note}</Body>)}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.md, gap: spacing.md },
  header: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  toggle: { minHeight: minimumTouchTarget, minWidth: 78, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  toggleText: { fontSize: 14, ...typeface.controlStrong },
  details: { gap: spacing.sm },
  row: { borderLeftWidth: 2, paddingLeft: spacing.md, gap: spacing.xs },
  rowTitle: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
});
