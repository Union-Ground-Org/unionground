import { useNativeUi } from "../lib/useNativeUi";
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from './Text';

import { defaultShortcutKeys, reconcileShortcutKeys } from '../lib/deskCopy';
import { type HatFunction, type HatFunctionGroup } from '../lib/hatFunctions';
import { haptics } from '../services/haptics';
import { PINNED_DESTINATIONS_STORE_PREFIX as SHORTCUT_STORE_KEY } from '../lib/quickActions';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { FontScaleRelayout } from './FontScaleRelayout';
import { HighlightList, HighlightRow } from './RowHighlight';
import { Body, SearchField } from './ui';
import { BrandMark } from './BrandMark';
import { nativeFeatureMatches } from '../lib/nativeUiCopy';

import { typeface } from '../theme/typeface';
export const functionIcons: Record<HatFunction['icon'], keyof typeof Ionicons.glyphMap> = {
  briefcase: 'briefcase-outline',
  chatbubbles: 'chatbubbles-outline',
  calendar: 'calendar-outline',
  document: 'document-text-outline',
  megaphone: 'megaphone-outline',
  checkmark: 'checkmark-circle-outline',
  people: 'people-outline',
  home: 'home-outline',
  stats: 'stats-chart-outline',
  shield: 'shield-checkmark-outline',
  gift: 'gift-outline',
  alert: 'warning-outline',
  flag: 'flag-outline',
  time: 'time-outline',
  search: 'search-outline',
  settings: 'settings-outline',
  notifications: 'notifications-outline',
  person: 'person-circle-outline',
  business: 'business-outline',
  link: 'link-outline',
  analytics: 'analytics-outline',
  map: 'git-network-outline',
  pulse: 'pulse-outline',
  cash: 'cash-outline',
  receipt: 'receipt-outline',
  folder: 'folder-open-outline',
  mail: 'mail-outline',
  help: 'help-circle-outline',
  key: 'key-outline',
  qr: 'qr-code-outline',
  trending: 'trending-up-outline',
  hand: 'hand-left-outline',
  server: 'server-outline',
  puzzle: 'extension-puzzle-outline',
};

const MAX_SHORTCUTS = 4;

// Measure words in the rendered face and system text size. Fixed thresholds
// from #7927 missed Public Sans and let the flex cells compress under their
// circles (#9312). Until native text layout arrives, one full-width cell is
// the safe starting layout. No line cap hides the label.
export type ShortcutRailColumns = 1 | 2 | 4;

export function shortcutRailColumns(railWidth: number, wordWidth?: number): ShortcutRailColumns {
  if (wordWidth === undefined) return 1;
  const needed = Math.max(56, Math.ceil(wordWidth) + 2);
  if ((railWidth - 3 * spacing.sm) / 4 >= needed) return 4;
  if ((railWidth - spacing.sm) / 2 >= needed) return 2;
  return 1;
}

export function FunctionDeck({
  width,
  height,
  topPad,
  bottomPad,
  groups,
  onHome,
  shortcutScope,
  footer = null,
}: {
  width: number;
  height: number;
  topPad: number;
  bottomPad: number;
  groups: HatFunctionGroup[];
  onHome: () => void;
  shortcutScope: string;
  /** Rendered after the groups: the onboarding guide's Show everything control. */
  footer?: ReactNode;
}) {
  const { t, catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const windowSize = useWindowDimensions();
  const [railWidth, setRailWidth] = useState<number | null>(null);
  const [wordMeasurement, setWordMeasurement] = useState<{ key: string; width: number } | null>(null);
  const shortcutStoreKey = `${SHORTCUT_STORE_KEY}.${shortcutScope}`;
  const [query, setQuery] = useState('');
  const [shortcutKeys, setShortcutKeys] = useState<string[] | null>(null);
  const [editingShortcuts, setEditingShortcuts] = useState(false);
  const { drawerGroups, membershipAlias } = useMemo(() => {
    const items = groups.flatMap((group) => group.items);
    const roles = items.find((item) => item.key === 'admin-access');
    const alias = items.find((item) => item.key === 'chapter-memberships' && item.href === roles?.href);
    if (!alias) return { drawerGroups: groups, membershipAlias: undefined };

    // The catalogue supplies both entries to other surfaces. Show their shared
    // destination once in this drawer while retaining search and saved pins.
    return {
      drawerGroups: groups.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.key !== alias.key || item.href !== alias.href),
      })),
      membershipAlias: alias,
    };
  }, [groups]);
  const allItems = useMemo(() => {
    const seen = new Set<string>();
    const items: HatFunction[] = [];
    for (const group of drawerGroups) {
      for (const item of group.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(item);
      }
    }
    return items;
  }, [drawerGroups]);
  useEffect(() => {
    let active = true;
    setShortcutKeys(null);
    void SecureStore.getItemAsync(shortcutStoreKey).then((raw) => {
      if (!active || !raw) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((key: unknown) => typeof key === 'string')) setShortcutKeys(parsed);
      } catch {
        // Ignore a corrupt stored selection and fall back to the defaults.
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [shortcutStoreKey]);
  const shortcuts = useMemo(() => {
    const byKey = new Map(allItems.map((item) => [item.key, item]));
    // Defaults take one destination per group: the row sits directly above
    // the directory, so mirroring its first four rows told the worker nothing.
    // A stored selection is reconciled with the current catalog, so a renamed
    // or removed destination backfills from the defaults instead of leaving a
    // stale or empty row.
    const stored = membershipAlias
      ? shortcutKeys?.map((key) => key === membershipAlias.key ? 'admin-access' : key) ?? null
      : shortcutKeys;
    const keys = reconcileShortcutKeys(stored, [...byKey.keys()], defaultShortcutKeys(drawerGroups, MAX_SHORTCUTS), MAX_SHORTCUTS);
    return keys
      .map((key) => byKey.get(key))
      .filter((item): item is HatFunction => Boolean(item));
  }, [allItems, drawerGroups, membershipAlias, shortcutKeys]);
  const shortcutWords = shortcuts.flatMap(item => catalogLabel(item.label).split(/\s+/u)).join('\n');
  const measurementKey = `${windowSize.fontScale}:${shortcutWords}`;
  const measuredWordWidth = wordMeasurement?.key === measurementKey ? wordMeasurement.width : undefined;
  const availableWidth = railWidth ?? Math.max(56, width - 2 * spacing.lg);
  const railColumns = shortcutRailColumns(availableWidth, measuredWordWidth);
  const pixelRatio = windowSize.scale || 1;
  // Yoga wraps on strict float32 overflow. Round down so the fourth cell
  // cannot spill onto its own row at a fractional drawer width.
  const railCellWidth = Math.floor((availableWidth - (railColumns - 1) * spacing.sm) / railColumns * pixelRatio) / pixelRatio;
  // At accessibility XXXL even a full row cannot fit Administración. Grow
  // with the system size up to the exact whole-word fit, as WordFitText does
  // elsewhere, without shrinking the base font or clipping the label.
  const labelScaleLimit = measuredWordWidth !== undefined && measuredWordWidth + 2 > availableWidth
    ? Math.max(1, windowSize.fontScale * (availableWidth - 2) / measuredWordWidth)
    : undefined;
  const addableShortcuts = useMemo(() => {
    const chosen = new Set(shortcuts.map((item) => item.key));
    return allItems.filter((item) => !chosen.has(item.key));
  }, [allItems, shortcuts]);

  function persistShortcuts(next: string[]) {
    setShortcutKeys(next);
    void SecureStore.setItemAsync(shortcutStoreKey, JSON.stringify(next)).catch(() => undefined);
  }
  const visible = useMemo(() => {
    // A destination is shown once. Searching uses the full directory and
    // hides the rail, so a pinned destination remains searchable too.
    const searching = Boolean(query.trim());
    const seen = new Set(searching ? [] : shortcuts.map(item => item.key));
    const aliasMatches = searching && membershipAlias && nativeFeatureMatches(membershipAlias, query);
    return drawerGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (seen.has(item.key)) return false;
          if (searching && !(item.key === 'admin-access' && aliasMatches) && !nativeFeatureMatches(item, query)) return false;
          seen.add(item.key);
          return true;
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [drawerGroups, membershipAlias, query, shortcuts]);

  return (
    <View style={{ width, height: '100%', backgroundColor: theme.muted }}>
      <ScrollView
        style={[styles.fill, { marginTop: topPad }]}
        contentContainerStyle={[styles.page, { minHeight: height - topPad - bottomPad, paddingBottom: bottomPad + spacing.lg }]}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        nestedScrollEnabled
        directionalLockEnabled
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel={t("All tools")}
      >
        {/* BUG-UG-NATIVE-IOS-PILLS-KEEP-LAUNCH-TEXT-SIZE-FRAME-20261103:
            the drawer sits outside Screen's relayout, so a text size lowered
            while the app was open left the Customize pill in the frame it
            measured at launch. The content mounts again at a size change; the
            search text and the shortcut choices are held above it. */}
        <FontScaleRelayout>
          <View style={styles.brandBlock}>
            {/* The close control is a cross, not a chevron: every row below uses
                a chevron to mean "open", so the same glyph meaning "close" here
                was the one ambiguous affordance in the drawer. */}
            <Pressable accessibilityRole="button" accessibilityLabel={t("Close and return to home")} onPress={onHome} style={styles.brand}>
              <View style={styles.wordmarkRow}>
              <BrandMark size={28} />
              <Text style={[styles.wordmark, { color: theme.foreground }]}>Union Ground</Text>
            </View>
              <View style={[styles.homeAffordance, { backgroundColor: theme.secondary }]}>
                <Ionicons name="close" size={20} color={theme.secondaryForeground} />
              </View>
            </Pressable>
          </View>
          {!query.trim() ? <View style={styles.railBlock} onLayout={(event) => { setRailWidth(event.nativeEvent.layout.width); }}>
            <View style={styles.railMeasure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text
                key={measurementKey}
                style={styles.railLabel}
                onTextLayout={(event) => {
                  const measured = Math.max(0, ...event.nativeEvent.lines.map(line => line.width));
                  if (measured > 0) setWordMeasurement(current => current?.key === measurementKey && current.width === measured ? current : { key: measurementKey, width: measured });
                }}
              >{shortcutWords}</Text>
            </View>
            <View style={styles.railHead}>
              <Text style={[styles.railHeading, { color: theme.mutedForeground }]}>{t("Shortcuts")}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={editingShortcuts ? t("Done customizing shortcuts") : t("Customize shortcuts")}
                onPress={() => { void haptics.select(); setEditingShortcuts((value) => !value); }}
                style={({ pressed }) => [styles.railEdit, { backgroundColor: theme.secondary, opacity: pressed ? 0.9 : 1 }]}
              >
                <Ionicons name={editingShortcuts ? 'checkmark' : 'options-outline'} size={16} color={theme.secondaryForeground} />
                <Text style={[styles.railEditLabel, { color: theme.secondaryForeground }]}>{editingShortcuts ? t("Done") : t("Customize")}</Text>
              </Pressable>
            </View>
            {shortcuts.length ? (
              <View style={styles.rail} accessibilityRole="tablist" accessibilityLabel={t("Shortcuts")}>
                {shortcuts.map((item) => (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityLabel={editingShortcuts ? t('Remove {name} shortcut', { name: catalogLabel(item.label) }) : catalogLabel(item.label)}
                    onPress={() => {
                      if (editingShortcuts) {
                        void haptics.select();
                        persistShortcuts(shortcuts.map((entry) => entry.key).filter((key) => key !== item.key));
                        return;
                      }
                      void haptics.impact();
                      router.push(item.href as never);
                    }}
                    style={({ pressed }) => [styles.railItem, { width: railCellWidth, opacity: pressed ? 0.82 : 1 }]}
                  >
                    <View style={[styles.railCircle, { backgroundColor: theme.card, borderColor: theme.border }]}>
                      <Ionicons name={functionIcons[item.icon]} size={22} color={theme.primary} />
                      {editingShortcuts ? (
                        <View style={[styles.railRemove, { backgroundColor: theme.destructive }]} accessibilityElementsHidden>
                          <Ionicons name="remove" size={12} color={theme.destructiveForeground} />
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.railLabel, { width: '100%', color: theme.foreground }]} maxFontSizeMultiplier={labelScaleLimit}>{catalogLabel(item.label)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : <Body muted>{t("No shortcuts selected. Add up to four below.")}</Body>}
            {editingShortcuts ? (
              <View style={styles.railChoices}>
                {addableShortcuts.map((item) => {
                  const full = shortcuts.length >= MAX_SHORTCUTS;
                  return (
                    <Pressable
                      key={item.key}
                      accessibilityRole="button"
                      accessibilityLabel={t('Add {name} shortcut', { name: catalogLabel(item.label) })}
                      accessibilityState={{ disabled: full }}
                      disabled={full}
                      onPress={() => {
                        void haptics.select();
                        persistShortcuts([...shortcuts.map((entry) => entry.key), item.key]);
                      }}
                      style={({ pressed }) => [styles.railChoice, {
                        backgroundColor: full ? theme.muted : theme.card,
                        borderColor: theme.border,
                        opacity: pressed && !full ? 0.82 : 1,
                      }]}
                    >
                      <Ionicons name="add" size={14} color={full ? theme.mutedForeground : theme.primary} />
                      <Text style={[styles.railChoiceLabel, { color: full ? theme.mutedForeground : theme.foreground }]}>{catalogLabel(item.label)}</Text>
                    </Pressable>
                  );
                })}
                {shortcuts.length >= MAX_SHORTCUTS ? <Body muted>{t('Remove a shortcut to add another (limit {count}).', { count: MAX_SHORTCUTS })}</Body> : null}
              </View>
            ) : null}
          </View> : null}
          <SearchField value={query} onChangeText={setQuery} placeholder={t("Search")} accessibilityLabel={t("Search features")} />
          {visible.map((group) => (
            <View key={group.key} style={styles.group}>
              <Text style={[styles.groupLabel, { color: theme.mutedForeground }]}>{catalogLabel(group.label)}</Text>
              <HighlightList style={[styles.groupCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
                {group.items.map((item, index) => (
                  <HighlightRow key={item.key}>
                    {index > 0 ? <View style={[styles.rowDivider, { backgroundColor: theme.border }]} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={catalogLabel(item.label)}
                      onPress={() => { void haptics.select(); router.push(item.href as never); }}
                      style={styles.row}
                    >
                      <View style={[styles.rowIcon, { backgroundColor: theme.secondary }]}>
                        <Ionicons name={functionIcons[item.icon]} size={20} color={theme.primary} />
                      </View>
                      <Text style={[styles.rowLabel, { color: theme.foreground }]}>{catalogLabel(item.label)}</Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
                    </Pressable>
                  </HighlightRow>
                ))}
              </HighlightList>
            </View>
          ))}
          {query.trim().length > 0 && visible.length === 0 ? (
            <View style={styles.noResults}>
              <Body muted>{t("No features match that search.")}</Body>
            </View>
          ) : null}
          {footer}
        </FontScaleRelayout>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  page: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  brandBlock: { gap: spacing.xs },
  brand: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  homeAffordance: { width: 40, height: 40, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  wordmarkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  wordmark: { fontSize: 20, lineHeight: 26, ...typeface.name, letterSpacing: -0.3 },
  railBlock: { gap: spacing.md },
  railHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  railHeading: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4, textTransform: 'uppercase' },
  railEdit: { minHeight: minimumTouchTarget, maxWidth: '100%', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill, flexDirection: 'row', gap: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  railEditLabel: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong, flexShrink: 1 },
  railRemove: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  railChoice: {
    minHeight: minimumTouchTarget, // iOS review 2026-09-13 D2: 34pt chips were below the 48pt floor
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
  },
  railChoiceLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  railMeasure: { position: 'absolute', width: 10000, height: 0, opacity: 0, overflow: 'hidden' },
  rail: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: spacing.sm },
  railItem: { flexShrink: 0, alignItems: 'center', gap: spacing.sm, minHeight: minimumTouchTarget },
  railCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    // The deck is a level-3 surface (brief §A): its own contents are flat, so
    // the shortcut circles separate by hairline and fill, never by a level-1
    // card shadow that would compete with the drawer's elevation.
    ...elevation.level0,
  },
  railLabel: { fontSize: 11, lineHeight: 14, ...typeface.controlStrong, textAlign: 'center' },
  group: { gap: spacing.xs },
  groupLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: spacing.xs },
  groupCard: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // Nested radii: the first and last icon tiles sat almost tangent to the
    // card's 24pt corner arc. A little vertical padding keeps the inner
    // corners clear of the outer curve.
    paddingVertical: spacing.xs,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.md + 36 + spacing.md,
    // Inset on both sides: a rule that stopped short of the icon but ran under
    // the chevron to the card edge read as asymmetric.
    marginRight: spacing.md,
  },
  row: {
    minHeight: minimumTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { flex: 1, fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  noResults: { alignItems: 'center', paddingVertical: spacing.xxl },
});
