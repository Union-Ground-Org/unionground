// REQ-UG-QUOTES-MINI-LESSONS-20260928: the form controls for governed
// learning content. Every control is a semantic native primitive with a
// visible label, an accessibility role and label, and at least a 48pt target;
// character counters count Unicode code points, the unit the server enforces.
// This file holds the feature's one Switch, which is never disabled: switches
// edit a draft, and only the explicit save button waits on the server.

import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';

import { Button } from '../../components/ui';
import { codePointLength } from '../../lib/learningContentModel';
import type { LearningCopy } from '../../lib/learningContentCopy';
import { haptics } from '../../services/haptics';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
export function LearningTextField({ label, value, onChangeText, limit, copy, counter = true, multiline = false, hint, error, editable = true, inputMode, placeholder }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  limit: number;
  copy: LearningCopy;
  /** Short structured inputs (priority, dates) show no character counter. */
  counter?: boolean;
  multiline?: boolean;
  hint?: string;
  error?: string | null;
  editable?: boolean;
  inputMode?: 'text' | 'numeric';
  placeholder?: string;
}) {
  const theme = useTheme();
  const count = codePointLength(value);
  const over = count > limit;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.cardForeground }]}>{label}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.mutedForeground }]}>{hint}</Text> : null}
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !editable }}
        editable={editable}
        multiline={multiline}
        inputMode={inputMode}
        autoCorrect={inputMode !== 'numeric'}
        keyboardAppearance={theme.appearance}
        placeholder={placeholder}
        placeholderTextColor={theme.quietForeground}
        selectionColor={theme.primary}
        textAlignVertical={multiline ? 'top' : 'center'}
        value={value}
        onChangeText={onChangeText}
        style={[
          styles.input,
          multiline ? styles.multiline : null,
          { backgroundColor: theme.input, borderColor: error || over ? theme.destructive : theme.border, color: theme.foreground },
        ]}
      />
      <View style={styles.fieldFooter}>
        {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{error}</Text> : <View style={styles.flex} />}
        {counter ? (
          <Text
            accessibilityLabel={copy.counterLabel(label, count, limit)}
            style={[styles.counter, { color: over ? theme.destructive : theme.mutedForeground }]}
          >
            {copy.counter(count, limit)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export type LearningChoice<T extends string> = { value: T; label: string };

export function LearningChoiceGroup<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly LearningChoice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.cardForeground }]}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
        {options.map((option) => (
          <Button
            key={option.value}
            label={option.label}
            variant={option.value === value ? 'primary' : 'secondary'}
            selected={option.value === value}
            onPress={() => onChange(option.value)}
          />
        ))}
      </View>
    </View>
  );
}

/** A read-only fact shown where a control would otherwise be (fixed identity). */
export function LearningFact({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.fact}>
      <Text style={[styles.label, { color: theme.cardForeground }]}>{label}</Text>
      <Text style={[styles.factValue, { color: theme.cardForeground }]}>{value}</Text>
    </View>
  );
}

export function LearningToggleRow({ label, body, value, onValueChange }: {
  label: string;
  body?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.toggleRow}>
      <View style={styles.flex}>
        <Text style={[styles.label, { color: theme.cardForeground }]}>{label}</Text>
        {body ? <Text style={[styles.hint, { color: theme.mutedForeground }]}>{body}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }}
        value={value}
        onValueChange={(next) => { void haptics.select(); onValueChange(next); }}
        trackColor={{ false: theme.muted, true: theme.primary }}
        thumbColor={value ? theme.primaryForeground : theme.mutedForeground}
      />
    </View>
  );
}

export function LearningCheckRow({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => { void haptics.select(); onToggle(); }}
      style={({ pressed }) => [styles.checkRow, pressed ? { backgroundColor: theme.muted } : null]}
    >
      <View style={[styles.checkBox, { borderColor: checked ? theme.primary : theme.border, backgroundColor: checked ? theme.primary : theme.card }]}>
        {checked ? <Ionicons name="checkmark" size={16} color={theme.primaryForeground} accessibilityElementsHidden /> : null}
      </View>
      <Text style={[styles.checkLabel, { color: theme.cardForeground }]}>{label}</Text>
    </Pressable>
  );
}

export function LearningListField({ label, addLabel, values, max, entryLimit, onChange, copy, errors, editable = true }: {
  label: string;
  addLabel: string;
  values: readonly string[];
  max: number;
  entryLimit: number;
  onChange: (values: string[]) => void;
  copy: LearningCopy;
  errors: readonly (string | null)[];
  editable?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.cardForeground }]}>{label}</Text>
      {values.map((value, index) => {
        const entryLabel = copy.entryLabel(label, index + 1);
        const count = codePointLength(value.trim());
        const error = errors[index] ?? null;
        return (
          <View key={index} style={styles.listEntry}>
            <View style={styles.listRow}>
              <TextInput
                accessibilityLabel={entryLabel}
                accessibilityState={{ disabled: !editable }}
                editable={editable}
                keyboardAppearance={theme.appearance}
                selectionColor={theme.primary}
                value={value}
                onChangeText={(text) => onChange(values.map((entry, position) => (position === index ? text : entry)))}
                style={[styles.input, styles.flex, { backgroundColor: theme.input, borderColor: error ? theme.destructive : theme.border, color: theme.foreground }]}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.removeEntry(label, index + 1)}
                accessibilityState={{ disabled: !editable }}
                disabled={!editable}
                onPress={() => { void haptics.select(); onChange(values.filter((_, position) => position !== index)); }}
                style={({ pressed }) => [styles.iconButton, { borderColor: theme.border, backgroundColor: pressed ? theme.muted : theme.secondary }]}
              >
                <Ionicons name="close" size={20} color={theme.secondaryForeground} accessibilityElementsHidden />
              </Pressable>
            </View>
            <View style={styles.fieldFooter}>
              {error ? <Text style={[styles.error, { color: theme.destructive }]}>{error}</Text> : <View style={styles.flex} />}
              <Text accessibilityLabel={copy.counterLabel(entryLabel, count, entryLimit)} style={[styles.counter, { color: count > entryLimit ? theme.destructive : theme.mutedForeground }]}>
                {copy.counter(count, entryLimit)}
              </Text>
            </View>
          </View>
        );
      })}
      {values.length < max ? <Button label={addLabel} variant="secondary" disabled={!editable} onPress={() => onChange([...values, ''])} /> : null}
    </View>
  );
}

export function LearningMessages({ heading, messages, tone = 'error' }: { heading?: string; messages: readonly string[]; tone?: 'error' | 'status' }) {
  const theme = useTheme();
  if (messages.length === 0) return null;
  const error = tone === 'error';
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.messages, { backgroundColor: theme.card, borderColor: error ? theme.destructive : theme.border }]}
    >
      <Ionicons
        name={error ? 'alert-circle' : 'checkmark-circle'}
        size={18}
        color={error ? theme.destructive : theme.primary}
        accessibilityElementsHidden
      />
      <View style={styles.flex}>
        {heading ? <Text style={[styles.label, { color: theme.cardForeground }]}>{heading}</Text> : null}
        {messages.map((message) => <Text key={message} style={[styles.message, { color: theme.cardForeground }]}>{message}</Text>)}
      </View>
    </View>
  );
}

/**
 * A secondary action that repeats per row ("Edit") and so needs its own
 * accessible name ("Edit Showing up") while the visible label stays short.
 */
export function LearningRowAction({ label, accessibilityLabel, onPress, icon }: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  icon?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => { void haptics.impact(); onPress(); }}
      style={({ pressed }) => [
        styles.rowAction,
        { backgroundColor: pressed ? theme.muted : theme.secondary, borderColor: theme.border },
      ]}
    >
      {icon}
      <Text style={[styles.rowActionText, { color: theme.secondaryForeground }]}>{label}</Text>
    </Pressable>
  );
}

export function LearningLinkButton({ label, accessibilityLabel, onPress, expanded, icon }: {
  label: string;
  /** A repeated link names its own item ("Read lesson: Keep a work log"). */
  accessibilityLabel?: string;
  onPress: () => void;
  expanded?: boolean;
  icon?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={() => { void haptics.select(); onPress(); }}
      style={({ pressed }) => [styles.link, pressed ? { opacity: 0.7 } : null]}
    >
      <Text style={[styles.linkText, { color: theme.primary }]}>{label}</Text>
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  field: { gap: spacing.xs },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  hint: { fontSize: 14, lineHeight: 19 },
  input: {
    minHeight: minimumTouchTarget,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    lineHeight: 21,
  },
  multiline: { minHeight: 112 },
  fieldFooter: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  error: { flex: 1, fontSize: 14, lineHeight: 19, ...typeface.control },
  counter: { fontSize: 13, lineHeight: 18, ...typeface.control, fontVariant: ['tabular-nums'] },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fact: { gap: 2, minHeight: minimumTouchTarget, justifyContent: 'center' },
  factValue: { fontSize: 16, lineHeight: 22 },
  toggleRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  checkRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
  checkBox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkLabel: { flex: 1, fontSize: 15, lineHeight: 20, ...typeface.control },
  listEntry: { gap: 2 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconButton: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  messages: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.md },
  message: { fontSize: 15, lineHeight: 21 },
  rowAction: {
    minHeight: minimumTouchTarget,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  rowActionText: { fontSize: 16, lineHeight: 20, ...typeface.controlStrong },
  link: { minHeight: minimumTouchTarget, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  linkText: { fontSize: 16, lineHeight: 21, ...typeface.controlStrong },
});
