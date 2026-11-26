import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren, type RefObject } from 'react';
import { Keyboard, Platform, View, type EmitterSubscription, type KeyboardEvent, type ScrollView } from 'react-native';

import { spacing } from '../theme/tokens';

// BUG-UG-NATIVE-QUICK-NOTE-HIDDEN-BY-KEYBOARD-20261103: Screen lets
// the keyboard inset its scroll view (automaticallyAdjustKeyboardInsets on
// iOS, the resized window on Android), so a member could scroll a focused
// field back into view, but nothing scrolled it there. Work's Quick note
// left its own bottom edge, Save note and the whole Quick task section under
// the iPhone keyboard. Screen now offers its scroll view to the fields inside
// it: a field names the block that has to stay visible with it (the input
// and its Save or Create button), and once the keyboard is up the page
// scrolls just far enough to lift that block above it. The block stays
// tracked until its field blurs: a later keyboard frame (Android's emoji
// panel or suggestion bar arrives as another keyboardDidShow) lifts it again.
//
// BUG-UG-NATIVE-MESSAGES-SEARCH-HIDDEN-BY-KEYBOARD-ANDROID-20261103:
// Android's edge-to-edge window no longer resizes for the keyboard (the
// Messages scroll view stayed 2126 px tall with Gboard up), so a page had no
// extra room to scroll a low field into. While a revealed field has the
// keyboard up, Android gets a keyboard-high spacer under the page's content,
// the room iOS gets from automaticallyAdjustKeyboardInsets, and the block is
// lifted once that spacer is laid out. The spacer stays until the keyboard
// is gone, not until the field blurs: focus can move to another input with
// Gboard still up, and a page scrolled into the spacer must not drop back
// under the keyboard.

export type RevealTarget = Pick<View, 'measureInWindow'>;
export type RevealAboveKeyboard = (target: RevealTarget | null) => void;
export type KeyboardReveal = {
  // Track this block (a field's focus, or its block's new layout) and lift it.
  reveal: RevealAboveKeyboard;
  // The field blurred: stop tracking, unless another block took over.
  release: (target: RevealTarget | null) => void;
};

// Clearance between the revealed block and the keyboard's top edge.
export const KEYBOARD_REVEAL_MARGIN = spacing.md;

const NO_REVEAL: KeyboardReveal = { reveal: () => undefined, release: () => undefined };
const RevealContext = createContext<KeyboardReveal>(NO_REVEAL);

export type RevealOffsetInput = {
  targetTop: number;
  targetBottom: number;
  keyboardTop: number;
  scrollOffset: number;
  // The page's content start line: the block's top never scrolls above it,
  // under the status bar and top chrome, to make room for its bottom.
  minTop: number;
  margin?: number;
};

// The scroll offset that lifts the block clear of the keyboard, or null when
// it is already clear or there is no room above it to move into.
export function revealScrollOffset({ targetTop, targetBottom, keyboardTop, scrollOffset, minTop, margin = KEYBOARD_REVEAL_MARGIN }: RevealOffsetInput): number | null {
  const overlap = targetBottom + margin - keyboardTop;
  if (!(overlap > 0)) return null;
  const delta = Math.min(overlap, targetTop - minTop);
  return delta > 0 ? scrollOffset + delta : null;
}

export function ScreenKeyboardReveal({ scrollRef, scrollOffsetRef, contentSizeListenerRef, scrollListenerRef, minTop, animated, children }: PropsWithChildren<{
  scrollRef: RefObject<ScrollView | null>;
  scrollOffsetRef: RefObject<number>;
  // Screen calls these from its ScrollView's onContentSizeChange and onScroll.
  contentSizeListenerRef?: RefObject<((contentHeight: number) => void) | null>;
  scrollListenerRef?: RefObject<((offset: number) => void) | null>;
  minTop: number;
  animated: boolean;
}>) {
  const tracked = useRef<{ target: RevealTarget; subscriptions: EmitterSubscription[] } | null>(null);
  const settings = useRef({ minTop, animated });
  settings.current = { minTop, animated };

  // The keyboard's latest top edge. Keyboard.metrics() updates only on
  // keyboardDidShow, so after an iOS resize that posts only
  // keyboardDidChangeFrame it still reports the older, shorter keyboard; the
  // page keeps every frame event's own top instead.
  const keyboardFrame = useRef<{ top: number; height: number } | null>(null);
  // Android only: the spacer's height, and a lift waiting for it to lay out.
  const [keyboardSpace, setKeyboardSpace] = useState(0);
  const committedSpace = useRef(0);
  const pendingLift = useRef<(() => void) | null>(null);
  // A React commit is not proof Android has applied the spacer's height: its
  // mount dispatcher can run the scroll command before the content grows, and
  // a non-animated scroll (Reduce Motion) is then clamped to the old end of
  // the page. So each spacer change arms one retry before
  // the lift is measured, and the retry waits for a content-size
  // report that includes the spacer's height (r4s1). That report is still
  // not a mount barrier: React Native sends layout events before the mount
  // and runs view commands before mount items. So once
  // the measurement and the report are both in, the retry waits one frame
  // before it scrolls, and with Reduce Motion it then confirms the offset
  // through onScroll, re-issuing once if the page stopped short.
  // With Reduce Motion the retry re-issues the offset the first, consistent
  // measurement chose: a clamped jump has already moved the page while
  // scrollOffsetRef waits for onScroll, so measuring again aimed short and
  // left Work's Quick task behind the keyboard on the Pixel (worker N, 5/5 at
  // text scale 1.0 and 3.2;). The animated retry measures again.
  type SpacerRetry = {
    contentHeightAtLeast: number | null;
    contentReady: boolean;
    measured: boolean;
    offset: number | null;
    // The offset came from an earlier frame's measurement.
    carried: boolean;
    keyboardTop: number;
    remeasure: (() => void) | null;
  };
  const retry = useRef<SpacerRetry | null>(null);
  const contentHeight = useRef<number | null>(null);
  const spacerRetry = useMemo(() => {
    let frame: number | null = null;
    let confirm: { offset: number; reissued: boolean } | null = null;
    const nextFrame = (run: () => void) => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        run();
      });
    };
    const issue = (offset: number, reissued: boolean) => {
      confirm = { offset, reissued };
      scrollRef.current?.scrollTo({ y: offset, animated: false });
      // A clamp that leaves the page where it was posts no onScroll, so the
      // next frame checks the offset too.
      nextFrame(() => check(scrollOffsetRef.current));
    };
    const check = (offset: number) => {
      const pending = confirm;
      if (!pending) return;
      if (offset >= pending.offset - 1 || pending.reissued) {
        confirm = null;
        return;
      }
      confirm = null;
      nextFrame(() => issue(pending.offset, true));
    };
    return {
      check,
      fire: (armed: SpacerRetry) => {
        retry.current = null;
        nextFrame(() => {
          if (settings.current.animated) armed.remeasure?.();
          else if (armed.offset !== null) issue(armed.offset, false);
        });
      },
      cancel: () => {
        retry.current = null;
        confirm = null;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      },
    };
  }, [scrollOffsetRef, scrollRef]);
  useEffect(() => spacerRetry.cancel, [spacerRetry]);
  useLayoutEffect(() => {
    committedSpace.current = keyboardSpace;
    const run = pendingLift.current;
    pendingLift.current = null;
    run?.();
  }, [keyboardSpace]);
  useEffect(() => {
    if (!contentSizeListenerRef) return undefined;
    contentSizeListenerRef.current = (height) => {
      contentHeight.current = height;
      const armed = retry.current;
      if (!armed || armed.contentReady) return;
      if (armed.contentHeightAtLeast !== null && height < armed.contentHeightAtLeast) return;
      armed.contentReady = true;
      if (armed.measured) spacerRetry.fire(armed);
    };
    return () => { contentSizeListenerRef.current = null; };
  }, [contentSizeListenerRef, spacerRetry]);
  useEffect(() => {
    if (!scrollListenerRef) return undefined;
    scrollListenerRef.current = spacerRetry.check;
    return () => { scrollListenerRef.current = null; };
  }, [scrollListenerRef, spacerRetry]);
  const closeSpace = useCallback(() => {
    pendingLift.current = null;
    spacerRetry.cancel();
    setKeyboardSpace(0);
  }, [spacerRetry]);
  useEffect(() => {
    const record = (event: KeyboardEvent) => { keyboardFrame.current = { top: event.endCoordinates.screenY, height: event.endCoordinates.height }; };
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', record),
      Keyboard.addListener('keyboardDidChangeFrame', record),
      Keyboard.addListener('keyboardDidHide', () => { keyboardFrame.current = null; closeSpace(); }),
    ];
    return () => { for (const subscription of subscriptions) subscription.remove(); };
  }, [closeSpace]);

  const clearTracked = useCallback(() => {
    for (const subscription of tracked.current?.subscriptions ?? []) subscription.remove();
    tracked.current = null;
    spacerRetry.cancel();
  }, [spacerRetry]);
  useEffect(() => clearTracked, [clearTracked]);

  const reveal = useCallback<RevealAboveKeyboard>((target) => {
    clearTracked();
    if (!target) return;
    const lift = (keyboardTop: number, afterMeasure?: (offset: number | null) => void) => {
      target.measureInWindow((_x, y, _width, height) => {
        const next = revealScrollOffset({
          targetTop: y,
          targetBottom: y + height,
          keyboardTop,
          scrollOffset: scrollOffsetRef.current,
          minTop: settings.current.minTop,
        });
        if (next !== null) scrollRef.current?.scrollTo({ y: next, animated: settings.current.animated });
        afterMeasure?.(next);
      });
    };
    // The armed retry learns what the lift measured; a block already clear
    // needs no retry. A carried offset is kept.
    const liftForRetry = (top: number) => lift(top, (offset) => {
      const armed = retry.current;
      if (!armed) return;
      armed.remeasure = () => lift(top);
      if (!armed.carried) {
        if (offset === null) {
          retry.current = null;
          return;
        }
        armed.offset = offset;
      }
      armed.measured = true;
      if (armed.contentReady) spacerRetry.fire(armed);
    });
    // A first focus waits for the keyboard to finish arriving, when the scroll
    // view's keyboard inset is in place and the page can scroll far enough.
    // Every later frame while the field stays focused lifts it again: Android
    // reports a taller keyboard as another keyboardDidShow, iOS as
    // keyboardDidChangeFrame.
    const liftWithRoom = (top: number, height: number) => {
      if (Platform.OS !== 'android') {
        lift(top);
        return;
      }
      // Asking for the height again also cancels a removal still queued from
      // a quick blur, so a refocus keeps its room.
      setKeyboardSpace(height);
      if (height === committedSpace.current) {
        pendingLift.current = null;
        // A same-height frame leaves a retry still waiting for the content
        // armed, with the offset its first, consistent measurement chose
        // .
        lift(top);
        return;
      }
      // Armed before the measurement, so a content-size report that arrives
      // first is not lost. A new keyboard height while
      // a Reduce Motion retry waits keeps its measured offset, shifted by the
      // keyboard's move, rather than measuring against a lagging
      // scrollOffsetRef.
      const previous = retry.current;
      const carried = !settings.current.animated && previous?.measured === true && previous.offset !== null
        ? previous.offset + previous.keyboardTop - top
        : null;
      spacerRetry.cancel();
      retry.current = {
        contentHeightAtLeast: contentHeight.current === null ? null : contentHeight.current + height - committedSpace.current,
        contentReady: false,
        measured: carried !== null,
        offset: carried,
        carried: carried !== null,
        keyboardTop: top,
        remeasure: null,
      };
      pendingLift.current = () => liftForRetry(top);
    };
    const onKeyboardFrame = (event: KeyboardEvent) => liftWithRoom(event.endCoordinates.screenY, event.endCoordinates.height);
    tracked.current = {
      target,
      subscriptions: [
        Keyboard.addListener('keyboardDidShow', onKeyboardFrame),
        Keyboard.addListener('keyboardDidChangeFrame', onKeyboardFrame),
      ],
    };
    // Moving between fields, or the block growing while its field is focused,
    // keeps the keyboard up, so its frame is already known and the block
    // lifts at once against the latest frame.
    if (!Keyboard.isVisible()) return;
    const metrics = Keyboard.metrics();
    const frame = keyboardFrame.current ?? (metrics ? { top: metrics.screenY, height: metrics.height } : null);
    if (frame) liftWithRoom(frame.top, frame.height);
  }, [clearTracked, closeSpace, scrollOffsetRef, scrollRef, spacerRetry]);

  // Focus can move to the next field before the previous one reports its
  // blur, so a release only clears the block it names.
  const release = useCallback((target: RevealTarget | null) => {
    if (!target || tracked.current?.target !== target) return;
    clearTracked();
    // The keyboard may stay up for the next input; keyboardDidHide removes
    // the room then. Only a keyboard already gone takes it away here.
    if (!Keyboard.isVisible()) closeSpace();
  }, [clearTracked, closeSpace]);

  const value = useMemo<KeyboardReveal>(() => ({ reveal, release }), [reveal, release]);
  return (
    <RevealContext.Provider value={value}>
      {children}
      {keyboardSpace > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{ height: keyboardSpace }}
        />
      ) : null}
    </RevealContext.Provider>
  );
}

// Outside a Screen there is no page to scroll, so the call does nothing.
export function useRevealAboveKeyboard(): KeyboardReveal {
  return useContext(RevealContext);
}
