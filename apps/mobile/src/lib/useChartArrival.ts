import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { Dimensions, Platform, type View } from 'react-native';
// The screen's navigation, or undefined outside a navigator (tests). The one
// context module, without the rest of the router.
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';

import { SCREEN_SETTLE_MS, chartArrived, hiddenBottomBand, markChartArrived, seenEnough } from './chartArrival';
import { reduceMotionKnown, useReduceMotion } from './reduceMotion';

// Charts arrive once: the hook that decides
// when a chart is first seen and runs its clock. Timing lives in
// chartArrival.ts.
//
// A chart is finished at once, and stays finished, when it has no name (an
// exported picture), when it already arrived in this app session, under
// Reduce Motion or while the device has not yet said whether Reduce Motion is
// on, and where it cannot be measured (tests). Otherwise it waits drawn empty
// until its screen is showing and settled and enough of it is on screen, then
// arrives once. Only the drawing inside
// the chart's box changes, so nothing around it moves, and the chart's own
// accessibility label carries the finished values the whole time.

type Phase = 'done' | 'waiting' | 'arriving';

// One shared check for every waiting chart, so a screen of charts below the
// fold costs one timer, and none at all once every chart has arrived.
const CHECK_MS = 150;
const waiting = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function watch(check: () => void): () => void {
  waiting.add(check);
  if (!timer) timer = setInterval(() => { for (const next of Array.from(waiting)) next(); }, CHECK_MS);
  check();
  return () => {
    waiting.delete(check);
    if (!waiting.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * `key` names the chart for this app session (never its data); null draws it
 * finished. `length` is the arrival's length in ms (arrivalLength). Put `ref`
 * on the View that holds the chart. `elapsed` is null when the chart is drawn
 * finished, else the ms since it started arriving (0 while it waits).
 */
export function useChartArrival(key: string | null, length: number): { ref: RefObject<View | null>; elapsed: number | null } {
  const reduceMotion = useReduceMotion();
  const ref = useRef<View | null>(null);
  // A tab or pushed screen is laid out before it is shown, and a hidden tab
  // still measures on screen: on the Android emulator Chapter Pulse's first
  // chart had arrived before its tab was opened (Nov 13, 2026). A chart waits
  // while its screen is not focused, and for the screen to settle after it is.
  const navigation = useContext(NavigationContext);
  const focusedAt = useRef<number | null>(navigation && !navigation.isFocused() ? null : Date.now());
  useEffect(() => {
    if (!navigation) return undefined;
    const focus = () => { focusedAt.current = focusedAt.current ?? Date.now(); };
    const blur = () => { focusedAt.current = null; };
    if (navigation.isFocused()) focus();
    else blur();
    const offFocus = navigation.addListener('focus', focus);
    const offBlur = navigation.addListener('blur', blur);
    return () => { offFocus(); offBlur(); };
  }, [navigation]);
  const [phase, setPhase] = useState<Phase>(() =>
    key && !reduceMotion && reduceMotionKnown() && !chartArrived(key) ? 'waiting' : 'done');
  const [elapsed, setElapsed] = useState(0);

  // A chart drawn finished counts as arrived, so it never arrives later in the session.
  useEffect(() => {
    if (key && phase === 'done') markChartArrived(key);
  }, [key, phase]);

  useEffect(() => {
    if (reduceMotion && phase !== 'done') setPhase('done');
  }, [reduceMotion, phase]);

  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    let live = true;
    const stop = watch(() => {
      const node = ref.current;
      if (!node || typeof node.measureInWindow !== 'function') {
        if (live) setPhase('done');
        return;
      }
      if (focusedAt.current === null || Date.now() - focusedAt.current < SCREEN_SETTLE_MS) return;
      node.measureInWindow((x, y, width, height) => {
        if (live && seenEnough({ x, y, width, height }, Dimensions.get('window'), hiddenBottomBand(Platform.OS))) setPhase('arriving');
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'arriving') return undefined;
    if (key) markChartArrived(key);
    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const now = Date.now() - start;
      if (now >= length) {
        setPhase('done');
        return;
      }
      setElapsed(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, key, length]);

  return { ref, elapsed: phase === 'done' ? null : phase === 'waiting' ? 0 : elapsed };
}
