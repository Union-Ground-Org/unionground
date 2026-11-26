import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import { PressableScale } from './PressableScale';
import {
  filterOptionPickerOptions,
  OPTION_PICKER_MAX_VISIBLE,
  optionPickerSearchNeedle,
} from './optionPickerFilter';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

import { typeface } from '../theme/typeface';
/**
 * Labelled option list for picking one of a caller-owned set of choices
 * (id + label, plus an optional non-secret detail such as role and campaign
 * context that disambiguates workers who share a full_name). Every option is
 * a named, touch-sized control with an explicit selected state, so VoiceOver
 * announces both the field and the current choice. Rosters larger than
 * OPTION_PICKER_MAX_VISIBLE get a search field and a hard cap on mounted
 * rows, so a 5,000-worker organization never mounts thousands of controls
 * inside Screen's non-virtualized ScrollView. This replaces free-text id
 * fields that would demand values the screen never shows (e.g. raw worker
 * ids on the Power map write form).
 */
export function OptionPicker({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly { id: string; label: string; detail?: string | null }[];
  onChange: (id: string) => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const searchable = options.length > OPTION_PICKER_MAX_VISIBLE;
  useEffect(() => {
    if (!searchable) setQuery('');
  }, [searchable]);
  const { visible, total } = useMemo(
    () => filterOptionPickerOptions(options, optionPickerSearchNeedle(query, options.length), value),
    [options, query, value],
  );
  return (
    <View style={styles.optionPicker}>
      <Text style={[styles.optionPickerLabel, { color: theme.foreground }]}>{label}</Text>
      {searchable ? (
        <TextInput
          accessibilityLabel={`Search ${label}`}
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${options.length} workers`}
          placeholderTextColor={theme.quietForeground}
          style={[styles.optionPickerSearch, { color: theme.foreground, borderColor: theme.border }]}
        />
      ) : null}
      <View role="group" accessibilityLabel={label} style={[styles.group, { borderColor: theme.border }]}>
        {visible.map((option) => {
          const selected = option.id === value;
          const detailSuffix = option.detail ? `, ${option.detail}` : '';
          return (
            <PressableScale
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${option.label}${detailSuffix}`}
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              resting={elevation.level0}
              style={[styles.groupRow, selected ? { backgroundColor: theme.secondary } : null]}
            >
              <Text style={{ color: selected ? theme.secondaryForeground : theme.foreground }}>{option.label}</Text>
              {option.detail ? (
                <Text style={[styles.optionPickerDetail, { color: theme.mutedForeground }]}>{option.detail}</Text>
              ) : null}
            </PressableScale>
          );
        })}
      </View>
      {total > visible.length ? (
        <Text style={[styles.optionPickerHint, { color: theme.mutedForeground }]}>{`Showing ${visible.length} of ${total} — keep typing to narrow.`}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  optionPicker: { gap: spacing.xs },
  optionPickerLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  optionPickerSearch: {
    minHeight: minimumTouchTarget,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    fontSize: 15,
  },
  optionPickerDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  optionPickerHint: { fontSize: 13, lineHeight: 18 },
  group: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  groupRow: { minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, justifyContent: 'center' },
});
