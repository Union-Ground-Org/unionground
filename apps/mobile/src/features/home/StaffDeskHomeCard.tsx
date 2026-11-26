// REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the Batch C
// role Home opens with the desk of the role the person is working as ("STEWARD
// DESK · Casework"), so a staff member reaches their desk from Home without
// the drawer. Live Home had no route to the desk at all. The card shows the
// role, the desk's work noun and what the desk holds; it shows no counts,
// because the live desk supplies none here and the card never invents them.
// A person holding several staff roles sees it once they choose one, and only
// when their assignment has the scope that desk needs.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { FEATURE_TITLES, canOpenFeature } from '../../lib/featureCatalog';
import { LIVE_STAFF_DESK_LINES, LIVE_STAFF_ROLE_LABELS, liveStaffDeskEyebrow, staffDeskHomeRole } from '../../lib/hatFunctions';
import { useNativeUi } from '../../lib/useNativeUi';
import { haptics } from '../../services/haptics';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import { elevation } from '../../theme/elevation';

import { typeface } from '../../theme/typeface';
export function StaffDeskHomeCard() {
  const router = useRouter();
  const theme = useTheme();
  const { t, language, locale, catalogLabel } = useNativeUi();
  const { mode, sessionRestricted, chosenStaffRole, authorizedRoles, chapterRoles, organizationRoles } = useApp();
  const role = staffDeskHomeRole({ mode, sessionRestricted, chosenStaffRole, authorizedRoles });
  // The card offers only a desk its destination will open: the same scope
  // check FeatureScreen runs, so an organization-only Steward or Coordinator
  // grant (those desks need chapter scope) gets no card that would refuse.
  if (!role || !canOpenFeature(mode, role, null, chapterRoles, organizationRoles)) return null;
  // The saved member language (#8302); role, desk and line are app-owned copy.
  const eyebrow = language === 'en' ? liveStaffDeskEyebrow(role)
    : t('{role} desk', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[role]) }).toLocaleUpperCase(locale);
  const title = catalogLabel(FEATURE_TITLES[role]);
  const line = catalogLabel(LIVE_STAFF_DESK_LINES[role]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${eyebrow}. ${title}. ${line}`}
      accessibilityHint={t('Opens your desk.')}
      onPress={() => { void haptics.select(); router.push(`/feature/${role}` as never); }}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? theme.secondary : theme.card, borderColor: pressed ? theme.primary : theme.border },
      ]}
    >
      <View style={styles.copy}>
        <Text style={[styles.eyebrow, { color: theme.primary }]}>{eyebrow}</Text>
        <Text style={[styles.title, { color: theme.cardForeground }]}>{title}</Text>
        <Text style={[styles.line, { color: theme.mutedForeground }]}>{line}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: minimumTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.cardRadius,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...elevation.level1,
  },
  copy: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 1.2 },
  title: { fontSize: 18, lineHeight: 24, ...typeface.heading },
  line: { fontSize: 14, lineHeight: 20, ...typeface.bodyMedium },
});
