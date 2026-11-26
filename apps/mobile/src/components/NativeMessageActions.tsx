import { useApp } from '../state/AppProvider';
import { Ionicons } from '@expo/vector-icons';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { messageActionChoices, messageActionRequest, MESSAGE_QUICK_ACTION } from '../../../../src/features/messaging/actions.js';
import { connectedWorkflowApi } from '../lib/connectedWorkflows';
import { MessageReactionPicker } from './MessageReactions';
import { useScreenReader, useScreenReaderKnownOff } from '../lib/screenReader';
import { haptics } from '../services/haptics';
import { captureSessionWriter } from '../services/supabase';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { ReminderPicker } from './ReminderPicker';
import { useNativeUi } from '../lib/useNativeUi';
import type { NativeUiText } from '../lib/nativeUiCopy';

import { typeface } from '../theme/typeface';
export type MessageActionState = { canEdit: boolean; saved: boolean; reminders: { id: string }[]; reactions: string[] };
type Props = {
  sourceKind: 'private' | 'channel';
  messageID: string;
  children: ReactNode;
  onCompose: (kind: 'reply' | 'edit') => void;
  onConfirmed?: (state: MessageActionState) => void;
  enabled?: boolean;
  accessibilityLabel?: string;
  onConnectedActions?: () => void;
  /** A footer row (a channel message's reactions) the Actions control closes. */
  footer?: ReactNode;
  /** Content between the message and its footer row (a channel poll's card). */
  aboveFooter?: ReactNode;
  /**
   * Points the body's target may reach up over plain text above it (a channel
   * message's author line): the space one line of its text leaves in 48 pt.
   * Centred in its 48 pt target, a one-line body had a band of space above and
   * below its words; reaching up keeps the full target with the words next to
   * their author and the footer row. The body's measured height caps the reach,
   * so a longer body or a chart, which fills its target, reaches no further
   * than it must; the reach moves the target, never the words. Until no screen
   * reader is known to run the body keeps its own frame, so the elements in
   * that line stay apart for touch exploration.
   */
  reachAbove?: number;
};

// The sheet's own words (title, Cancel, More actions) follow the saved member
// language with the choices; option labels arrive already translated.
function choose(t: NativeUiText, title: string, options: { label: string; run: () => void }[]) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options.map((o) => o.label), t('Cancel')], cancelButtonIndex: options.length },
      (index) => options[index]?.run());
  } else {
    const page = (offset: number) => {
      const option = options[offset];
      if (!option) return;
      Alert.alert(title, undefined, [
        { text: option.label, onPress: option.run },
        ...(offset + 1 < options.length ? [{ text: t('More actions'), onPress: () => page(offset + 1) }] : []),
        { text: t('Cancel'), style: 'cancel' },
      ]);
    };
    if (options.length) page(0);
  }
}

export function NativeMessageActions({ sourceKind, messageID, children, onCompose, onConfirmed, enabled = true, accessibilityLabel, onConnectedActions, footer, aboveFooter, reachAbove }: Props) {
  const { session } = useApp();
  const writer = captureSessionWriter(session);
  const theme = useTheme();
  const { t, catalogLabel } = useNativeUi();
  const screenReader = useScreenReader();
  const screenReaderKnownOff = useScreenReaderKnownOff();
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [state, setState] = useState<MessageActionState | null>(null);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const working = useRef(false);
  const generation = useRef(0);
  const lastTap = useRef(0);

  useLayoutEffect(() => {
    generation.current += 1;
    working.current = false; setBusy(false); setState(null); setError(false); setShowReminderPicker(false); setReactionsOpen(false);
    return () => { generation.current += 1; };
  }, [messageID, sourceKind, enabled, session?.user.id]);

  async function perform(action: string, value: string | null = null, note = '') {
    if (!enabled || working.current) return;
    const version = generation.current;
    working.current = true; setBusy(true); setError(false);
    let acknowledged = false;
    try {
      let result: { state: MessageActionState };
      if (action === 'remind') {
        const api = connectedWorkflowApi(session);
        if (!api || !value) throw new Error('Reminder unavailable');
        await api.remind({ kind: sourceKind === 'private' ? 'private_message' : 'channel_post', id: messageID }, value, note);
        acknowledged = true;
        result = { state: await messageActionRequest(await writer.client(), sourceKind, messageID, 'state') as MessageActionState };
      } else {
        result = await messageActionRequest(await writer.client(), sourceKind, messageID, action, value) as { state: MessageActionState };
      }
      acknowledged = true;
      const current = await writer.isCurrent();
      if (version !== generation.current || !current) return;
      setState(result.state as MessageActionState);
      void haptics.success();
      onConfirmed?.(result.state);
    } catch {
      const proof = await writer.check();
      if (version === generation.current && proof !== 'changed') { setError(!acknowledged); if (!acknowledged) void haptics.warning(); }
    } finally {
      if (version === generation.current) { working.current = false; setBusy(false); }
    }
  }

  async function menu() {
    if (!enabled || working.current) return;
    const version = generation.current;
    working.current = true; setBusy(true); setError(false);
    try {
      const current = await messageActionRequest(await writer.client(), sourceKind, messageID, 'state') as MessageActionState;
      const owned = await writer.isCurrent();
      if (version !== generation.current || !owned) return;
      setState(current); void haptics.select();
      choose(t, t('Message actions'), [...messageActionChoices(current).filter((choice: { id: string }) => !onConnectedActions || choice.id !== 'remind').map((choice: { id: string; label: string }) => ({
        // The shared choices keep English labels as their contract; only the
        // words shown change, never the ids or the requests they send.
        label: catalogLabel(choice.label),
        run: async () => {
          const owned = await writer.isCurrent();
          if (version !== generation.current || !owned) return;
          if (choice.id === 'reply' || choice.id === 'edit') { onCompose(choice.id); return; }
          if (choice.id === 'react') {
            setReactionsOpen(true);
            return;
          }
          if (choice.id === 'remind') {
            setShowReminderPicker(true);
            return;
          }
          void perform(choice.id, null);
        },
      })), ...(onConnectedActions ? [{ label: t('Reminders and linked tasks…'), run: async () => { const owned = await writer.isCurrent(); if (version === generation.current && owned) onConnectedActions(); } }] : [])]);
    } catch { const proof = await writer.check(); if (version === generation.current && proof !== 'changed') setError(true); }
    finally { if (version === generation.current) { working.current = false; setBusy(false); } }
  }

  function handleReminderConfirm(result: { iso: string; note: string } | null): Promise<void> | void {
    setShowReminderPicker(false);
    if (result) {
      // Returned so the picker can keep its confirm gate closed until the
      // mutation resolves; perform() fires the success haptic only after the
      // server confirms and owns its own duplicate-call lock.
      return perform('remind', result.iso, result.note);
    }
  }

  const maxReminderDate = new Date(Date.now() + 365 * 86400000);
  const reach = screenReaderKnownOff && reachAbove
    ? Math.min(reachAbove, bodyHeight === null ? reachAbove : Math.max(0, minimumTouchTarget - 2 * spacing.xs - bodyHeight))
    : 0;
  const body = !reachAbove ? children : (
    <View onLayout={(event) => { const next = Math.round(event.nativeEvent.layout.height); setBodyHeight((current) => (current === next ? current : next)); }}>{children}</View>
  );

  if (!enabled) {
    const body = accessibilityLabel
      ? <View accessible accessibilityLabel={accessibilityLabel}>{children}</View>
      : <>{children}</>;
    return footer ? <>{body}{aboveFooter}<View style={[styles.footerRow, aboveFooter ? styles.footerAfterAbove : null]}>{footer}</View></> : <>{body}{aboveFooter}</>;
  }

  // In a footer row the control sits centred among the chips; on its own it
  // keeps its words at the top of its target, next to the message. A press
  // lays a muted fill behind it (its words keep their contrast); a saved
  // message or a set reminder reads in the full text colour.
  const actionsTarget = footer ? styles.actionsTargetInRow : styles.actionsTarget;
  const actionsControl = (
    <Pressable accessibilityRole="button" accessibilityLabel={t('Open message actions')} disabled={busy}
      accessibilityState={{ disabled: busy, busy }} onPress={() => { void menu(); }} style={({ pressed }) => (pressed ? [actionsTarget, styles.actionsPressed, { backgroundColor: theme.muted }] : actionsTarget)}>
      {/* A quiet "⋯ Actions" control: plain body text read like a stray label
          repeated under every message (App Store capture, Nov 7, 2026). The
          icon is set in the line, so it scales and wraps with the words. */}
      <Text style={[styles.actionsLabel, { color: theme.mutedForeground }]}>
        <Ionicons name="ellipsis-horizontal" size={16} color={theme.mutedForeground} />
        {busy ? ` ${t('Updating…')}` : ` ${t('Actions')}`}
        {state?.saved ? <Text style={{ color: theme.foreground }}>{` · ${t('Saved')}`}</Text> : null}
        {state?.reminders.length ? <Text style={{ color: theme.foreground }}>{` · ${t('Reminder set')}`}</Text> : null}
      </Text>
    </Pressable>
  );

  return (
    <View style={reach ? { marginTop: -reach } : null}>
      <Pressable accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={t('Opens actions. Double tap without a screen reader toggles Like.')}
        accessibilityState={{ disabled: busy, busy }} disabled={busy}
        accessibilityActions={[{ name: 'activate', label: t('Message actions') }, { name: 'longpress', label: t('Message actions') }]}
        onAccessibilityAction={() => { void menu(); }}
        onLongPress={() => { lastTap.current = 0; void menu(); }} delayLongPress={500}
        onPress={() => {
          if (screenReader) { void menu(); return; }
          const now = Date.now();
          if (now - lastTap.current < 300) { lastTap.current = 0; void perform('react', MESSAGE_QUICK_ACTION); }
          else lastTap.current = now;
        }} style={reach ? [styles.target, styles.targetReaching, { paddingTop: spacing.xs + reach }] : styles.target}>{body}</Pressable>
      {aboveFooter}
      {footer ? <View style={[styles.footerRow, aboveFooter ? styles.footerAfterAbove : null]}>{footer}{actionsControl}</View> : actionsControl}
      {reactionsOpen ? <MessageReactionPicker mine={state?.reactions ?? []} disabled={busy} onReact={(kind) => { void perform('react', kind); }} /> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Action not confirmed. Try again.')}</Text> : null}
      <ReminderPicker
        visible={showReminderPicker}
        onClose={() => setShowReminderPicker(false)}
        onConfirm={handleReminderConfirm}
        minDate={new Date()}
        maxDate={maxReminderDate}
        initialDate={new Date(Date.now() + 86400000)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  target: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingVertical: spacing.xs },
  // The reach above makes up the 48 pt, so any slack left falls under the words.
  targetReaching: { justifyContent: 'flex-start' },
  // The target hugs the control and keeps its full height; the words sit at
  // its top, next to the message they act on, not centred in a band.
  actionsTarget: { minHeight: minimumTouchTarget, justifyContent: 'flex-start', paddingTop: spacing.xs, alignSelf: 'flex-start' },
  // A 4 pt pull keeps its dots 8 pt after the chip before it, like every gap.
  actionsTargetInRow: { minHeight: minimumTouchTarget, maxWidth: '100%', flexShrink: 1, justifyContent: 'center', paddingHorizontal: spacing.xs, marginLeft: -spacing.xs },
  actionsPressed: { borderRadius: radii.pill },
  // Chips sit in 48 pt targets, so wrapped lines need no extra row gap.
  footerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 0, columnGap: spacing.sm },
  // A poll card above the row keeps the row's chips clear of its edge.
  footerAfterAbove: { marginTop: spacing.xs },
  actionsLabel: { flexShrink: 1, fontSize: 14, lineHeight: 19, ...typeface.control },
});
