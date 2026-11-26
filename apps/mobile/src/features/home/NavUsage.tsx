// REQ-UG-USAGE-BASED-NAVIGATION-20261001, native half. The phone counts
// which worker destinations its signed-in account opens, ranks them with the
// shared model (4x / 2x / 1x over 30 days), and shows the top four as a
// "Most used" row on Home and first in Quick actions. Counts stay in this
// phone's secure storage; the organization switch turns it off and the worker
// resets it from Account. Pinned system tabs never move.

import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading } from '../../components/ui';
import { useWordFit } from '../../components/useWordFit';
import {
  NAV_USAGE_SWITCH,
  computeNavWeights,
  destinationForPath,
  primaryNavKeys,
  rankedDestinations,
  type NativeDestination,
  type NavWeight,
} from '../../lib/navUsageShared';
import { useNativeUi } from '../../lib/useNativeUi';
import { wordFitMultiplier } from '../../lib/wordFit';
import { haptics } from '../../services/haptics';
import { useMemberSwitch } from '../../services/memberSwitches';
import { readNativeNavUsage, recordNativeNavVisit, resetNativeNavUsage, subscribeNavUsage } from '../../services/navUsageStore';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';

const CHIP_ICON_SIZE = 20;
const CHIP_WIDTH = '47%';
const CHIP_WIDTH_RATIO = Number.parseFloat(CHIP_WIDTH) / 100;

// Mounted once in the root layout: records each worker destination opened by
// a signed-in, non-preview account while the switch is on.
export function NavUsageRecorder() {
  const pathname = usePathname();
  const { mode, session } = useApp();
  const enabled = useMemberSwitch(NAV_USAGE_SWITCH, true);
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  useEffect(() => {
    const destination = destinationForPath(pathname);
    if (!enabled || !userID || !destination) return;
    void recordNativeNavVisit(userID, destination);
  }, [enabled, userID, pathname]);
  return null;
}

export function useNativeNavUsage(): { enabled: boolean; weights: NavWeight[] } {
  const { mode, session } = useApp();
  const enabled = useMemberSwitch(NAV_USAGE_SWITCH, true);
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  const [weights, setWeights] = useState<NavWeight[]>([]);
  useEffect(() => {
    if (!enabled || !userID) { setWeights([]); return undefined; }
    let active = true;
    const load = () => {
      void readNativeNavUsage(userID).then((usage) => { if (active) setWeights(computeNavWeights(usage)); });
    };
    load();
    const unsubscribe = subscribeNavUsage(load);
    return () => { active = false; unsubscribe(); };
  }, [enabled, userID]);
  return { enabled, weights };
}

export function mostUsedDestinations(weights: readonly NavWeight[], runsDues: boolean | null = null): NativeDestination[] {
  const destinations = rankedDestinations(runsDues);
  const keys = primaryNavKeys(weights, destinations.map((item) => item.key));
  return keys.flatMap((key) => destinations.filter((item) => item.key === key));
}

export function MostUsedRow({ weights }: { weights: readonly NavWeight[] }) {
  const router = useRouter();
  const theme = useTheme();
  const { t, catalogLabel } = useNativeUi();
  const { duesContext } = useApp();
  const { width, fontScale } = useWindowDimensions();
  const items = mostUsedDestinations(weights, duesContext?.runsDues ?? null)
    .map((item) => ({ ...item, label: catalogLabel(item.label) }));
  if (items.length === 0) return null;
  const twoColumnLabelWidth = (width - spacing.lg * 2) * CHIP_WIDTH_RATIO
    - spacing.md * 2 - spacing.sm - CHIP_ICON_SIZE - StyleSheet.hairlineWidth * 2;
  const stacked = items.some(({ label }) => fontScale > (wordFitMultiplier(label, styles.chipLabel.fontSize, twoColumnLabelWidth) ?? 1));
  return (
    <View style={styles.section}>
      <Heading level={2} fitWords>{t('Most used')}</Heading>
      <View style={styles.row}>
        {items.map(({ key, label, href, icon }) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => { void haptics.select(); router.push(href as never); }}
            style={({ pressed }) => [styles.chip, stacked && styles.stackedChip, { backgroundColor: theme.secondary, borderColor: theme.border, opacity: pressed ? 0.82 : 1 }]}
          >
            <Ionicons name={icon} size={CHIP_ICON_SIZE} color={theme.secondaryForeground} accessibilityElementsHidden />
            <MostUsedLabel label={label} color={theme.secondaryForeground} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function MostUsedLabel({ label, color }: { label: string; color: string }) {
  const fit = useWordFit(true, label, styles.chipLabel);
  return <Text onLayout={fit.onLayout} allowFontScaling={fit.allowFontScaling}
    style={[styles.chipLabel, { color }, fit.style]}>{label}</Text>;
}

// Account: the worker-level reset. Shown only while the switch is on.
export function NavUsageResetCard() {
  const { mode, session } = useApp();
  const enabled = useMemberSwitch(NAV_USAGE_SWITCH, true);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  if (!enabled || !userID) return null;
  async function reset() {
    if (!userID) return;
    setState('busy');
    try { await resetNativeNavUsage(userID); setState('done'); } catch { setState('failed'); }
  }
  return (
    <Card>
      <Heading level={3}>Most used places</Heading>
      <Body muted>The places you open most in the last 30 days appear first on Home. They are counted on this phone only and never sent to Union Ground.</Body>
      <Button label="Reset most used" variant="secondary" busy={state === 'busy'} onPress={() => { void reset(); }} />
      {state === 'done' ? <Body accessibilityRole="alert">Reset. Home is back to its usual order on this phone.</Body> : null}
      {state === 'failed' ? <Body accessibilityRole="alert">That couldn’t be reset. Try again.</Body> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexBasis: CHIP_WIDTH,
    flexGrow: 1,
    minHeight: minimumTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stackedChip: { flexBasis: '100%' },
  chipLabel: { flex: 1, fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
});
