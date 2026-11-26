import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Heading } from '../components/ui';
import { PressableScale } from '../components/PressableScale';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { WorkFilterPresets, WORK_FILTER_NAME_LIMIT } from '../services/workFilterPresets';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
/** Mounted with the exact scope as its React key; no previous scope can paint here. */
export function WorkFilterPresetsCard({ scope, query, onQuery }: { scope: string; query: string; onQuery: (query: string) => void }) {
  const theme = useTheme();
  const [store] = useState(() => new WorkFilterPresets(scope));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const announce = useAccessibilityAnnouncementQueue(scope);
  useEffect(() => { void store.load(); }, [store]);
  useEffect(() => { if (state.message) return announce(state.message); }, [state.message, announce]);
  const save = async () => {
    if (await store.change(renaming ? 'rename' : 'save', name, query, renaming ?? '')) {
      setName(''); setRenaming(null);
    }
  };
  return <View style={styles.group}>
    <Heading level={3}>Saved filters · {state.presets.length}/5</Heading>
    <Body muted>Personal to this account and campaign on this device. Apply a filter to the current campaign list.</Body>
    <View accessibilityRole="radiogroup" accessibilityLabel="Saved campaign-work filters">
    {state.presets.map((preset) => {
      const selected = query.trim().toLowerCase() === preset.query.toLowerCase();
      return <View key={preset.name} style={styles.group}>
        <WorkFilterButton label={`${selected ? 'Selected: ' : 'Apply '}${preset.name}`} selected={selected}
          onPress={() => onQuery(preset.query)} />
        <View style={styles.actions}>
          <WorkFilterButton label={`Rename ${preset.name}`} disabled={state.saving}
            onPress={() => { setName(preset.name); setRenaming(preset.name); }} />
          <WorkFilterButton label={`Delete ${preset.name}`} disabled={state.saving}
            onPress={() => { void store.change('delete', preset.name).then((saved) => {
              if (saved && renaming === preset.name) { setName(''); setRenaming(null); }
            }); }} />
        </View>
      </View>;
    })}
    </View>
    <Body>{renaming ? `New name for ${renaming}` : 'Filter name'}</Body>
    <TextInput accessibilityLabel={renaming ? `New name for ${renaming}` : 'Saved filter name'}
      keyboardAppearance={theme.appearance}
      value={name} onChangeText={setName} maxLength={WORK_FILTER_NAME_LIMIT} editable={!state.saving}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: focused ? theme.ring : theme.border }]} />
    <WorkFilterButton label={state.saving ? 'Saving filter…' : renaming ? 'Save new name' : 'Save current filter'}
      disabled={!state.ready || state.saving} onPress={() => { void save(); }} />
    {renaming ? <WorkFilterButton label="Cancel rename" onPress={() => { setName(''); setRenaming(null); }} /> : null}
    {!state.ready && !state.message ? <Body muted>Loading saved filters…</Body> : null}
    {!state.ready && state.message ? <WorkFilterButton label="Retry saved filters" onPress={() => { void store.load(); }} /> : null}
    {state.message ? <Body accessibilityRole="alert">{state.message}</Body> : null}
  </View>;
}

export function WorkFilterButton({ label, disabled = false, selected, onPress }: {
  label: string; disabled?: boolean; selected?: boolean; onPress: () => void;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const background = disabled ? theme.muted : selected ? theme.primary : theme.secondary;
  const foreground = disabled ? theme.mutedForeground : selected ? theme.primaryForeground : theme.secondaryForeground;
  return <PressableScale accessibilityRole={selected === undefined ? 'button' : 'radio'}
    accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={[styles.button, { backgroundColor: background, borderColor: focused ? (selected ? theme.primaryForeground : theme.ring) : theme.border }]}>
    <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
  </PressableScale>;
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { minHeight: minimumTouchTarget, borderWidth: 2, borderRadius: radii.sm, padding: spacing.sm, fontSize: 16 },
  button: { minHeight: minimumTouchTarget, minWidth: minimumTouchTarget, borderWidth: 2,
    borderRadius: radii.md, padding: spacing.sm, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontSize: 16, ...typeface.control },
});
