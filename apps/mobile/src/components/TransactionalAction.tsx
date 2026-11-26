import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { queueAccessibilityAnnouncement } from '../lib/announce';
import { useReduceMotion } from '../lib/reduceMotion';
import { haptics } from '../services/haptics';
import { radii, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from './ui';
import { typeface } from '../theme/typeface';

// The shared transactional primitive adopted as a roll-up in batch B04a and
// listed as triage P1-5: "spinner-in-owning-control → 44px confirmation row →
// figure animation → row-insert flash → Reduce Motion instant swap".
//
// Every write surface in the app already had a success state; what it did not
// have was one way of arriving at it. This module owns the arrival: the busy
// phase (spinner inside the button that was pressed, never a page spinner), the
// success haptic, the confirmation row's anatomy, and the single Reduce Motion
// branch. Screens keep their own copy and their own state.
export const CONFIRMATION_ROW_HEIGHT = 44;
export const ENTER_TRANSLATE = 6;
// Calm spring, no bounce — an arriving receipt that wobbles reads as a toy
// (same rule as the press spring in PressableScale).
export const ENTER_SPRING = { speed: 18, bounciness: 0 } as const;

export type TransactionalStatus = 'idle' | 'busy' | 'done';

export type TransactionalAction = {
  status: TransactionalStatus;
  busy: boolean;
  done: boolean;
  /** Runs the work, holding the owning control busy until it settles. */
  perform: () => void;
  reset: () => void;
};

/**
 * Owns the pressed → busy → done transition for one control.
 *
 * The success haptic fires here so a screen cannot forget it or double it, and
 * a failed run returns to idle rather than to a confirmation the member never
 * earned.
 */
export function useTransactionalAction(run: () => void | Promise<void>): TransactionalAction {
  const [status, setStatus] = useState<TransactionalStatus>('idle');
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const perform = useCallback(() => {
    // A second press while the first is in flight must not start a second
    // write; the control is already showing its spinner.
    if (running.current) return;
    const settle = () => {
      if (mounted.current) setStatus('done');
      void haptics.success();
    };
    const fail = () => {
      if (mounted.current) setStatus('idle');
      void haptics.warning();
    };

    let result: void | Promise<void>;
    try {
      result = run();
    } catch {
      fail();
      return;
    }

    // A synchronous write has no latency to report. Settling inside the same
    // React batch as the screen's own state means the confirmation mounts
    // already knowing it is an arrival — and no spinner flashes for one frame.
    if (!(result instanceof Promise)) {
      settle();
      return;
    }

    running.current = true;
    setStatus('busy');
    void result
      .then(settle, fail)
      .finally(() => { running.current = false; });
  }, [run]);

  const reset = useCallback(() => { setStatus('idle'); }, []);

  return { status, busy: status === 'busy', done: status === 'done', perform, reset };
}

/**
 * The one entrance used by every transactional success: a short spring on
 * opacity and offset. Reduce Motion is an instant swap — the value is set, not
 * animated, so the confirmation is simply there.
 *
 * `enabled` is an arrival flag read at mount: a receipt already on the record,
 * or a history row that was already on screen, renders at rest rather than
 * performing an entrance it did not earn.
 *
 * `announcement` is the arrival spoken to VoiceOver. It belongs here rather
 * than on each screen because "arrived" is exactly what this hook knows: the
 * one place that decides a surface is an arrival is the one place that can
 * announce it once.
 */
export function useTransactionalEntrance(enabled = true, announcement?: string) {
  const reduceMotion = useReduceMotion();
  // Lazily constructed: `useRef(new Animated.Value(…))` builds a driver on
  // every render and discards all but the first, on a component that renders
  // once per confirmed write and once per history row.
  const enterRef = useRef<Animated.Value | null>(null);
  if (enterRef.current === null) enterRef.current = new Animated.Value(enabled ? 0 : 1);
  const enter = enterRef.current;
  const announcementAttempt = useRef(0);

  useEffect(() => {
    if (!enabled || !announcement) return undefined;
    // The effect lifetime owns the queued utterance: a replaced receipt or an
    // unmounted screen cannot speak after it is gone. The monotonic identity
    // keeps an identical later arrival audible after enabled toggles.
    return queueAccessibilityAnnouncement(
      announcement,
      `transactional-arrival:${++announcementAttempt.current}`,
    );
  }, [announcement, enabled]);

  useEffect(() => {
    if (!enabled || reduceMotion) {
      enter.setValue(1);
      return;
    }
    const animation = Animated.spring(enter, { toValue: 1, useNativeDriver: true, ...ENTER_SPRING });
    animation.start();
    return () => { animation.stop(); };
  }, [enabled, enter, reduceMotion]);

  return {
    opacity: enter,
    transform: [{
      translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [ENTER_TRANSLATE, 0] }),
    }],
  };
}

/** The owning control for a transactional write: spinner in, label unmoved. */
export function TransactionalButton({ label, action, disabled = false, variant }: {
  label: string;
  action: TransactionalAction;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'compass' | 'danger';
}) {
  return (
    <Button
      label={label}
      variant={variant}
      disabled={disabled}
      busy={action.busy}
      onPress={action.perform}
    />
  );
}

/**
 * The 44px confirmation row: check glyph plus the surface's own message. The
 * copy always belongs to the screen — this component only standardises how it
 * lands, and the screen's own message is what VoiceOver hears on arrival.
 *
 * The row carries the same hairline every level-1 surface carries: the tinted
 * fill alone measures 1.19:1 against the white card it sits in (wave-2b
 * finding w2b-9), which is a field the member cannot see the edges of.
 */
export function TransactionalConfirmation({ message, enabled = true }: { message: string; enabled?: boolean }) {
  const theme = useTheme();
  const entrance = useTransactionalEntrance(enabled, message);
  return (
    <Animated.View
      accessible
      accessibilityLabel={message}
      style={[styles.confirmation, { backgroundColor: theme.secondary, borderColor: theme.border }, entrance]}
    >
      <View style={styles.glyph}>
        <Ionicons name="checkmark-circle" size={20} color={theme.primary} accessibilityElementsHidden />
      </View>
      <Text style={[styles.confirmationText, { color: theme.secondaryForeground }]}>{message}</Text>
    </Animated.View>
  );
}

/**
 * The figure/row variant: an arriving card or list row animates in with the
 * same spring instead of appearing between two frames. `enabled` is false for
 * rows that were already on screen, so a list does not re-animate on mount.
 *
 * A self-evident artifact is silent to VoiceOver — the new card is simply
 * further down the page — so a call site passes `announce` with the artifact's
 * own words to give the arrival the same voice the confirmation row has.
 */
export function TransactionalReveal({ enabled = true, announce, children }: PropsWithChildren<{
  enabled?: boolean;
  announce?: string;
}>) {
  const entrance = useTransactionalEntrance(enabled, announce);
  return <Animated.View style={entrance}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  confirmation: {
    minHeight: CONFIRMATION_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.rowRadius,
    // The level-1 hairline, same width and token as Card and GroupRow: it
    // gives the field an edge without adding a second saturated fill or
    // out-ranking the card title above it.
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  glyph: { width: 20, alignItems: 'center', justifyContent: 'center' },
  confirmationText: { flex: 1, fontSize: 15, lineHeight: 21, ...typeface.control },
});
