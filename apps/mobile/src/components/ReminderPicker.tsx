import { useNativeUi } from "../lib/useNativeUi";
import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { haptics } from '../services/haptics';
import type { ReminderResumeDraft } from '../lib/resumeDraftHolder';

import { typeface } from '../theme/typeface';
import { LengthCounter } from './LengthCounter';
import { deviceTimeZoneLabel } from '../lib/evidenceTimestamp';
// The picker dialog is loaded through a plain require at first use rather than
// a static import: Metro bundles a static require the same way, while the root
// vitest transform must never parse the package's Flow-typed source (and the
// dialog itself only matters once a reminder sheet actually opens). Same
// pattern as QuickActionsDrawer's expo-audio loader.
type DateTimePickerModule = typeof import('@react-native-community/datetimepicker');
let dateTimePickerModule: DateTimePickerModule | null | undefined;
function loadDateTimePicker(): DateTimePickerModule | null {
  if (dateTimePickerModule === undefined) {
    try {
      dateTimePickerModule = require('@react-native-community/datetimepicker') as DateTimePickerModule;
    } catch {
      dateTimePickerModule = null;
    }
  }
  return dateTimePickerModule;
}

export type ReminderPickerResult = { iso: string; note: string } | null;

type Props = {
  visible: boolean;
  onClose: () => void;
  // The owner contract wants the mutation awaited before anything downstream
  // reports success, so the consumer may hand back the in-flight request.
  onConfirm: (result: ReminderPickerResult) => void | Promise<void>;
  minDate?: Date;
  maxDate?: Date;
  initialDate?: Date;
  initialNote?: string;
  retained?: { value: ReminderResumeDraft; onChange: (draft: ReminderResumeDraft) => void; pending: boolean; locked: boolean;
    failed: string; retryLabel: string; discardLabel: string; onDiscard: () => void };
};

const MAX_NOTE_LENGTH = 500;
const DEFAULT_MAX_YEARS = 1;

// Android has no single dialog that takes a date and a time together
// (AndroidMode is 'date' | 'time'), so the sheet walks one step there while
// iOS keeps the combined datetime dialog.
type PickerStep = null | 'date' | 'time' | 'datetime';

export function ReminderPicker({ visible, onClose, onConfirm, minDate, maxDate, initialDate, initialNote, retained }: Props) {
  const { t, locale } = useNativeUi();
  const theme = useTheme();
  const [localDate, setLocalDate] = useState<Date>(initialDate ?? new Date(Date.now() + 3600000));
  const [localChosen, setLocalChosen] = useState(false);
  const initialTime = initialDate?.getTime();
  const [localNote, setLocalNote] = useState<string>(initialNote ?? '');
  const [localStep, setLocalStep] = useState<PickerStep>(null);
  const [localBusy, setBusy] = useState(false);
  const date = retained ? new Date(retained.value.date) : localDate;
  const chosen = retained?.value.chosen ?? localChosen;
  const note = retained?.value.note ?? localNote;
  const step = retained ? retained.value.step : localStep;
  const busy = localBusy || retained?.pending === true;
  const controlled = retained !== undefined;
  const patch = (value: Partial<ReminderResumeDraft>) => {
    if (retained) retained.onChange({ ...retained.value, ...value });
    else {
      if (value.date !== undefined) setLocalDate(new Date(value.date));
      if (value.chosen !== undefined) setLocalChosen(value.chosen);
      if (value.note !== undefined) setLocalNote(value.note);
      if ('step' in value) setLocalStep(value.step ?? null);
    }
  };
  // A state flag alone cannot stop a second tap that lands before the re-render,
  // so the confirm gate is a synchronous ref; the generation ref retires work
  // that outlives a close or a source change.
  const working = useRef(false);
  const generation = useRef(0);

  const effectiveMin = minDate ?? new Date();
  const effectiveMax = maxDate ?? new Date(Date.now() + DEFAULT_MAX_YEARS * 365 * 86400000);

  useEffect(() => {
    if (visible) {
      generation.current += 1;
      working.current = false;
      setBusy(false);
      if (!controlled) {
        setLocalDate(initialTime === undefined ? new Date(Date.now() + 3600000) : new Date(initialTime));
        setLocalChosen(false); setLocalNote(initialNote ?? ''); setLocalStep(null);
      }
    } else {
      generation.current += 1;
      working.current = false;
    }
  }, [visible, initialTime, initialNote, controlled]);

  function openPicker() {
    if (busy || retained?.locked) return;
    if (!loadDateTimePicker()) {
      Alert.alert(t("Date picker unavailable"), t("This build cannot open the system date picker. Try again after reinstalling the app."), [{ text: t("OK") }]);
      return;
    }
    void haptics.select();
    patch({ step: Platform.OS === 'android' ? 'date' : 'datetime' });
  }

  function handlePickerChange(event: unknown) {
    if (!event) {
      patch({ step: null });
      return;
    }
    const native = event as { type?: string; nativeEvent?: { timestamp?: number } };
    if (native.type === 'dismissed') {
      patch({ step: null });
      return;
    }
    const timestamp = native.nativeEvent?.timestamp;
    if (!timestamp) {
      patch({ step: null });
      return;
    }
    const picked = new Date(timestamp);
    if (Platform.OS === 'android' && step === 'date') {
      const merged = new Date(date);
      merged.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
      patch({ date: merged.getTime(), step: 'time' });
      return;
    }
    patch({ date: picked.getTime(), chosen: true, step: null });
  }

  async function confirm() {
    if (working.current || retained?.pending || !chosen) return;
    working.current = true;
    const version = generation.current;
    setBusy(true);
    try {
      const chosen = date;
      if (chosen <= new Date()) {
        Alert.alert(t("Invalid time"), t("Reminder must be in the future."), [{ text: t("OK") }]);
        return;
      }
      if (chosen > effectiveMax) {
        Alert.alert(t("Too far ahead"), t('Reminder cannot be more than {years} year ahead.', { years: DEFAULT_MAX_YEARS }), [{ text: t("OK") }]);
        return;
      }
      if (version !== generation.current) return;
      // No success haptic here: the caller's mutation owns the success moment,
      // and claiming one before the server confirms would be dishonest.
      void haptics.select();
      await onConfirm({ iso: chosen.toISOString(), note: note.trim() });
    } finally {
      if (version === generation.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  function cancel() {
    void haptics.select();
    onClose();
  }

  if (!visible) return null;

  // Resolved after the visibility gate so a sheet that never opens never loads
  // the native module; openPicker() has already proved the module is present
  // before `step` could become non-null.
  const DateTimePicker = step ? loadDateTimePicker()?.default : null;
  const zone = deviceTimeZoneLabel(date, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const selectedTime = Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : t('Time unavailable');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={cancel}>
    {/* A11Y-UG-NATIVE-IOS-SET-REMINDER-SHEET-HAS-NO-ACCESSIBLE-CONTROLS-20261111:
        the sheet used to be one `accessible` element with a caller-supplied
        label, which folds every child into it, so VoiceOver and TalkBack saw
        only a title (in the caller's language) and no controls. The sheet is
        now a plain container: the title is a header, each control is its own
        element, focus stays inside while it is open, and the VoiceOver escape
        gesture cancels it (Android Back already does, through the Modal). */}
    <View
      accessibilityViewIsModal
      onAccessibilityEscape={cancel}
      style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: theme.background }}
    >
    <View style={[styles.sheet, elevation.level3, { backgroundColor: theme.popover }]}>
      <View style={[styles.handle, { backgroundColor: theme.border }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text accessibilityRole="header" style={[styles.title, { color: theme.popoverForeground }]}>{t("Set reminder")}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Reminder time, currently {time}', { time: chosen ? selectedTime : t('not selected') })}
        accessibilityHint={Platform.OS === 'android' ? t("Opens the date picker, then the time picker") : t("Opens the system date and time picker")}
        onPress={openPicker}
        style={[styles.timeRow, { borderColor: theme.border }]}
        disabled={busy || retained?.locked}
      >
        <Text style={[styles.timeLabel, { color: theme.popoverForeground }]}>{t("When")}</Text>
        <Text style={[styles.timeValue, { color: theme.popoverForeground }]}>{chosen ? selectedTime : t("Choose date and time")}</Text>
      </Pressable>

      {zone ? <Text style={{ color: theme.mutedForeground }}>{zone}</Text> : null}
      <View style={styles.noteRow}>
        <Text style={[styles.noteLabel, { color: theme.popoverForeground }]}>{t("Note (optional)")}</Text>
        <TextInput
          accessibilityLabel={t("Reminder note")}
          accessibilityHint={t('Up to {count} characters', { count: MAX_NOTE_LENGTH })}
          value={note}
          onChangeText={(value) => { if (!retained?.locked) patch({ note: value }); }}
          maxLength={MAX_NOTE_LENGTH}
          multiline
          numberOfLines={3}
          placeholder={t("Add a note…")}
          placeholderTextColor={theme.quietForeground}
          selectionColor={theme.primary}
          keyboardAppearance={theme.appearance}
          editable={!busy && !retained?.locked}
          style={[styles.noteValue, { backgroundColor: theme.input, color: theme.foreground, borderColor: theme.border }]}
        />
        <LengthCounter value={note} max={MAX_NOTE_LENGTH} />
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Cancel")}
          onPress={cancel}
          style={[styles.actionButton, { borderColor: theme.border }]}
          disabled={busy}
        >
          <Text style={[styles.actionText, { color: theme.popoverForeground }]}>{t("Cancel")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={retained?.failed ? retained.retryLabel : t("Set reminder")}
          accessibilityHint={!chosen && !busy ? t("Choose date and time") : undefined}
          accessibilityState={{ disabled: busy || !chosen, busy }}
          onPress={() => { void confirm(); }}
          style={[styles.actionButton, { backgroundColor: chosen ? theme.primary : theme.muted }]}
          disabled={busy || !chosen}
        >
          <Text style={[styles.actionText, { color: chosen ? theme.primaryForeground : theme.mutedForeground }]}>
            {busy ? t("Setting…") : retained?.failed ? retained.retryLabel : t("Set reminder")}
          </Text>
        </Pressable>
      </View>

      {retained?.failed ? <Text accessibilityRole="alert" style={{ color: theme.foreground }}>{retained.failed}</Text> : null}
      {retained && !retained.pending ? <Pressable accessibilityRole="button" onPress={retained.onDiscard} style={[styles.actionButton, { borderColor: theme.border }]}>
        <Text style={[styles.actionText, { color: theme.popoverForeground }]}>{retained.discardLabel}</Text>
      </Pressable> : null}

      {step && DateTimePicker ? (
        <DateTimePicker
          testID="reminder-date-picker"
          locale={locale}
          value={date}
          mode={step === 'datetime' ? 'datetime' : step}
          minimumDate={effectiveMin}
          maximumDate={effectiveMax}
          onChange={handlePickerChange}
          display="default"
          is24Hour={false}
        />
      ) : null}
    </View>
    </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: radii.sheetRadius,
    borderTopRightRadius: radii.sheetRadius,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    ...typeface.heading,
    textAlign: 'center',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.controlRadius,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: minimumTouchTarget,
  },
  timeLabel: {
    fontSize: 16,
    lineHeight: 22,
    ...typeface.control,
  },
  timeValue: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'right',
    maxWidth: '65%',
  },
  noteRow: {
    gap: spacing.xs,
  },
  noteLabel: {
    fontSize: 14,
    lineHeight: 20,
    ...typeface.control,
  },
  noteValue: {
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: minimumTouchTarget,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  actionButton: {
    flex: 1,
    minHeight: minimumTouchTarget,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.controlRadius,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    fontSize: 16,
    lineHeight: 22,
    ...typeface.controlStrong,
  },
});
