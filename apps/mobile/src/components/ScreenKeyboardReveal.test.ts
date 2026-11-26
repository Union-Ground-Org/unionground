// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-QUICK-NOTE-HIDDEN-BY-KEYBOARD-20261103: Screen's
// keyboard reveal, executed against a fake keyboard and scroll view.

type ShowEvent = { endCoordinates: { screenY: number; height: number } };
const keyboard = vi.hoisted(() => ({
  platform: 'ios',
  visible: false,
  // What Keyboard.metrics() reports: like React Native 0.86, only
  // keyboardDidShow updates it, never keyboardDidChangeFrame.
  metricsY: 0,
  listeners: [] as { event: string; handler: (event: ShowEvent) => void; removed: boolean }[],
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return keyboard.platform; } },
  // The Android keyboard spacer renders as a marked box with its height.
  View: ({ style }: { style?: { height?: number } }) => createElement('div', { 'data-keyboard-space': String(style?.height ?? '') }),
  Keyboard: {
    isVisible: () => keyboard.visible,
    metrics: () => (keyboard.visible ? { screenX: 0, screenY: keyboard.metricsY, width: 402, height: 874 - keyboard.metricsY } : undefined),
    addListener: (event: string, handler: (event: ShowEvent) => void) => {
      const entry = { event, handler, removed: false };
      keyboard.listeners.push(entry);
      return { remove: () => { entry.removed = true; } };
    },
  },
}));

import { KEYBOARD_REVEAL_MARGIN, revealScrollOffset, ScreenKeyboardReveal, useRevealAboveKeyboard, type KeyboardReveal, type RevealTarget } from './ScreenKeyboardReveal';

const SCREEN_HEIGHT = 874;
function emitKeyboard(event: 'keyboardDidShow' | 'keyboardDidChangeFrame' | 'keyboardDidHide', screenY: number) {
  keyboard.visible = event !== 'keyboardDidHide';
  if (event === 'keyboardDidShow') keyboard.metricsY = screenY;
  for (const entry of keyboard.listeners) if (!entry.removed && entry.event === event) entry.handler({ endCoordinates: { screenY, height: SCREEN_HEIGHT - screenY } });
}
function showKeyboard(screenY: number) {
  emitKeyboard('keyboardDidShow', screenY);
}
function liveListeners() {
  return keyboard.listeners.filter((entry) => !entry.removed);
}
// The provider's own frame recorders, present from mount to unmount.
let providerListeners = new Set<object>();
function trackedListeners() {
  return liveListeners().filter((entry) => !providerListeners.has(entry));
}
function target(y: number, height: number): RevealTarget {
  return { measureInWindow: (callback) => callback(0, y, 370, height) };
}

let container: HTMLDivElement;
let root: Root;
let reveal: KeyboardReveal['reveal'] = () => undefined;
let release: KeyboardReveal['release'] = () => undefined;
const scrollTo = vi.fn<(options: { y: number; animated: boolean }) => void>();
const scrollRef = { current: { scrollTo } as never };
const scrollOffsetRef = { current: 0 };
// Screen's onContentSizeChange relay into the provider.
const contentSizeListenerRef: { current: ((contentHeight: number) => void) | null } = { current: null };
// The page's content height before the spacer, and with Gboard's 348 dp spacer.
const CONTENT = 2000;
const CONTENT_WITH_SPACER = CONTENT + 348;
function reportContent(height: number) {
  contentSizeListenerRef.current?.(height);
}
// Screen's onScroll relay into the provider.
const scrollListenerRef: { current: ((offset: number) => void) | null } = { current: null };
function reportScroll(offset: number) {
  scrollListenerRef.current?.(offset);
}
// Animation frames run only when a test advances them.
let frames = new Map<number, () => void>();
let nextFrameId = 1;
function runFrame() {
  const queued = [...frames.values()];
  frames = new Map();
  for (const run of queued) run();
}
function runFrames(count = 5) {
  for (let index = 0; index < count; index += 1) runFrame();
}

function Capture() {
  ({ reveal, release } = useRevealAboveKeyboard());
  return null;
}
async function renderReveal(options: { minTop?: number; animated?: boolean } = {}, children: ReactNode = createElement(Capture)) {
  await act(async () => {
    root.render(createElement(ScreenKeyboardReveal, { scrollRef, scrollOffsetRef, contentSizeListenerRef, scrollListenerRef, minTop: options.minTop ?? 120, animated: options.animated ?? true }, children));
  });
  providerListeners = new Set(liveListeners());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    const id = nextFrameId++;
    frames.set(id, run);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  keyboard.platform = 'ios';
  keyboard.visible = false;
  keyboard.metricsY = 0;
  keyboard.listeners = [];
  providerListeners = new Set();
  scrollTo.mockClear();
  scrollOffsetRef.current = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('revealScrollOffset', () => {
  it('scrolls by the overlap plus the margin', () => {
    expect(revealScrollOffset({ targetTop: 500, targetBottom: 640, keyboardTop: 560, scrollOffset: 200, minTop: 120 })).toBe(200 + 80 + KEYBOARD_REVEAL_MARGIN);
  });

  it('leaves a block that already clears the keyboard alone', () => {
    expect(revealScrollOffset({ targetTop: 300, targetBottom: 400, keyboardTop: 560, scrollOffset: 0, minTop: 120 })).toBeNull();
    expect(revealScrollOffset({ targetTop: 300, targetBottom: 560 - KEYBOARD_REVEAL_MARGIN, keyboardTop: 560, scrollOffset: 0, minTop: 120 })).toBeNull();
  });

  it('never pushes the block\'s top above the content start line', () => {
    // A block taller than the space above the keyboard keeps its top in view.
    expect(revealScrollOffset({ targetTop: 400, targetBottom: 900, keyboardTop: 560, scrollOffset: 50, minTop: 120 })).toBe(50 + 280);
    expect(revealScrollOffset({ targetTop: 100, targetBottom: 900, keyboardTop: 560, scrollOffset: 50, minTop: 120 })).toBeNull();
  });

  it('ignores a keyboard frame that is not a number', () => {
    expect(revealScrollOffset({ targetTop: 500, targetBottom: 640, keyboardTop: Number.NaN, scrollOffset: 0, minTop: 120 })).toBeNull();
  });
});

describe('ScreenKeyboardReveal', () => {
  it('does nothing outside a Screen', async () => {
    await act(async () => { root.render(createElement(Capture)); });
    expect(() => reveal(target(600, 120))).not.toThrow();
    expect(() => release(target(600, 120))).not.toThrow();
    expect(keyboard.listeners).toEqual([]);
  });

  it('waits for the keyboard on a first focus, then lifts the block above it', async () => {
    await renderReveal();
    scrollOffsetRef.current = 340;
    reveal(target(620, 150));
    expect(scrollTo).not.toHaveBeenCalled();
    showKeyboard(540);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 340 + (770 + KEYBOARD_REVEAL_MARGIN - 540), animated: true });
  });

  //  on #6911: Android reports a taller keyboard (emoji panel,
  // suggestion bar) as another keyboardDidShow, and iOS as
  // keyboardDidChangeFrame; the focused block's own layout does not change.
  const laterFrames: ('keyboardDidShow' | 'keyboardDidChangeFrame')[] = ['keyboardDidShow', 'keyboardDidChangeFrame'];
  it.each(laterFrames)('lifts the focused block again when a later %s brings a taller keyboard', async (event) => {
    await renderReveal();
    let blockTop = 620;
    const block: RevealTarget = { measureInWindow: (callback) => callback(0, blockTop, 370, 150) };
    scrollOffsetRef.current = 340;
    reveal(block);
    showKeyboard(540);
    const firstLift = 770 + KEYBOARD_REVEAL_MARGIN - 540;
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 340 + firstLift, animated: true });
    // The page has scrolled: the block now ends 12 pt above the keyboard.
    scrollOffsetRef.current = 340 + firstLift;
    blockTop -= firstLift;
    emitKeyboard(event, 540);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The keyboard grows by 60 pt; the block is lifted by the same 60 pt.
    emitKeyboard(event, 480);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 340 + firstLift + 60, animated: true });
  });

  //  on #6911: React Native's Keyboard.metrics() updates only on
  // keyboardDidShow, so a growth lift after an iOS frame-only resize must use
  // the frame event's top, not the older metrics.
  it('lifts a block that grows after a frame-only resize against the newer, taller keyboard', async () => {
    await renderReveal();
    let blockHeight = 48;
    const block: RevealTarget = { measureInWindow: (callback) => callback(0, 400, 370, blockHeight) };
    reveal(block);
    showKeyboard(540);
    expect(scrollTo).not.toHaveBeenCalled();
    // The suggestion bar arrives as a frame change only; the block still clears it.
    emitKeyboard('keyboardDidChangeFrame', 480);
    expect(keyboard.metricsY).toBe(540);
    expect(scrollTo).not.toHaveBeenCalled();
    // The note grows from 48 to 120 pt and its block lays out again.
    blockHeight = 120;
    reveal(block);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 520 + KEYBOARD_REVEAL_MARGIN - 480, animated: true });
  });

  it('forgets the last frame when the keyboard hides', async () => {
    await renderReveal();
    emitKeyboard('keyboardDidChangeFrame', 300);
    emitKeyboard('keyboardDidHide', 874);
    // A focus with the keyboard gone waits for it instead of using the old frame.
    reveal(target(400, 48));
    expect(scrollTo).not.toHaveBeenCalled();
    showKeyboard(540);
    expect(scrollTo).not.toHaveBeenCalled();
    showKeyboard(420);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 448 + KEYBOARD_REVEAL_MARGIN - 420, animated: true });
  });

  it('stops following the keyboard once its field blurs, but not for a release of another block', async () => {
    await renderReveal();
    const note = target(620, 150);
    const task = target(700, 48);
    reveal(note);
    // Focus moved to the task before the note reported its blur.
    reveal(task);
    release(note);
    expect(trackedListeners()).toHaveLength(2);
    showKeyboard(540);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    release(task);
    expect(trackedListeners()).toEqual([]);
    showKeyboard(400);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    release(null);
    expect(trackedListeners()).toEqual([]);
  });

  it('lifts at once when the keyboard is already up, as when moving from the note to the task field', async () => {
    await renderReveal({ animated: false });
    keyboard.visible = true;
    keyboard.metricsY = 540;
    reveal(target(560, 48));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 608 + KEYBOARD_REVEAL_MARGIN - 540, animated: false });
    // It keeps following the keyboard while the field stays focused.
    expect(trackedListeners().map((entry) => entry.event)).toEqual(['keyboardDidShow', 'keyboardDidChangeFrame']);
  });

  it('does not scroll a block the keyboard leaves visible', async () => {
    await renderReveal();
    reveal(target(200, 100));
    showKeyboard(540);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows only the latest block and lets go on unmount', async () => {
    await renderReveal();
    reveal(target(620, 150));
    reveal(target(700, 48));
    expect(trackedListeners()).toHaveLength(2);
    reveal(null);
    expect(trackedListeners()).toEqual([]);
    reveal(target(700, 48));
    act(() => root.unmount());
    expect(liveListeners()).toEqual([]);
    root = createRoot(container);
  });

  it('uses the newest content start line and motion setting', async () => {
    await renderReveal({ minTop: 120, animated: true });
    await renderReveal({ minTop: 400, animated: false });
    keyboard.visible = true;
    keyboard.metricsY = 540;
    reveal(target(450, 300));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 50, animated: false });
  });
});

// BUG-UG-NATIVE-MESSAGES-SEARCH-HIDDEN-BY-KEYBOARD-ANDROID-20261103:
// Android's edge-to-edge window keeps its height under the keyboard, so the
// page gets a keyboard-high spacer and the lift runs once it is laid out.
describe('ScreenKeyboardReveal on Android', () => {
  const space = () => container.querySelector('[data-keyboard-space]')?.getAttribute('data-keyboard-space') ?? null;
  beforeEach(() => { keyboard.platform = 'android'; });

  it('adds keyboard-high room under the page, then lifts the focused field into it', async () => {
    await renderReveal();
    // Messages' search row at 627 to 675 dp; Gboard's top at 526 dp.
    const spaceAtScroll: (string | null)[] = [];
    scrollTo.mockImplementation(() => { spaceAtScroll.push(space()); });
    reveal(target(627, 48));
    expect(space()).toBeNull();
    await act(async () => { showKeyboard(526); });
    expect(space()).toBe(String(SCREEN_HEIGHT - 526));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 675 + KEYBOARD_REVEAL_MARGIN - 526, animated: true });
    // The scroll ran with the room already in the page.
    expect(spaceAtScroll).toEqual([String(SCREEN_HEIGHT - 526)]);
  });

  it('lifts at once when the room is already there, as when the block lays out again', async () => {
    await renderReveal();
    const block = target(627, 48);
    reveal(block);
    await act(async () => { showKeyboard(526); });
    scrollTo.mockClear();
    reveal(block);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  //  on #6938: focus moving to another input keeps Gboard up, so the
  // room stays until the keyboard hides.
  it('keeps the room while the keyboard stays up after a blur, and takes it away when the keyboard hides', async () => {
    await renderReveal();
    const row = target(627, 48);
    reveal(row);
    await act(async () => { showKeyboard(526); });
    const room = String(SCREEN_HEIGHT - 526);
    expect(space()).toBe(room);
    await act(async () => { release(row); });
    expect(space()).toBe(room);
    expect(trackedListeners()).toEqual([]);
    await act(async () => { emitKeyboard('keyboardDidHide', SCREEN_HEIGHT); });
    expect(space()).toBeNull();
  });

  it('takes the room away on a blur once the keyboard is already gone', async () => {
    await renderReveal();
    const row = target(627, 48);
    reveal(row);
    await act(async () => { showKeyboard(526); });
    keyboard.visible = false;
    await act(async () => { release(row); });
    expect(space()).toBeNull();
  });

  //  on #6938: a removal queued by a quick blur must not win over the
  // refocus that follows it.
  it('keeps the room through a quick blur and refocus', async () => {
    await renderReveal();
    const row = target(627, 48);
    reveal(row);
    await act(async () => { showKeyboard(526); });
    scrollTo.mockClear();
    await act(async () => {
      keyboard.visible = false;
      release(row);
      keyboard.visible = true;
      reveal(row);
    });
    expect(space()).toBe(String(SCREEN_HEIGHT - 526));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('adds no room on iOS, which insets its own scroll view', async () => {
    keyboard.platform = 'ios';
    await renderReveal();
    reveal(target(627, 48));
    await act(async () => { showKeyboard(526); });
    expect(space()).toBeNull();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('does not scroll a field the keyboard leaves visible', async () => {
    await renderReveal();
    reveal(target(200, 48));
    await act(async () => { showKeyboard(526); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  //  on #6938: Android can run the scroll command before the spacer's
  // height is mounted, so a Reduce Motion scroll is clamped to the old end of
  // the page; the lift is retried once on the new content size.
  it('retries a clamped Reduce Motion lift once the spacer has grown the page', async () => {
    await renderReveal({ animated: false });
    // A page with 100 dp of scroll room before the spacer; the row sits at
    // 627 to 675 dp at offset 0 and Gboard's top is at 526 dp.
    let maxOffset = 100;
    scrollOffsetRef.current = 0;
    scrollTo.mockImplementation(({ y }) => { scrollOffsetRef.current = Math.min(y, maxOffset); });
    const row: RevealTarget = { measureInWindow: (callback) => callback(0, 627 - scrollOffsetRef.current, 370, 48) };
    reportContent(CONTENT);
    reveal(row);
    await act(async () => { showKeyboard(526); });
    const needed = 675 + KEYBOARD_REVEAL_MARGIN - 526;
    // The first scroll reached the ScrollView before its content grew.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: needed, animated: false });
    expect(scrollOffsetRef.current).toBe(100);
    // Android reports the content grown by the spacer; the lift runs again.
    maxOffset += SCREEN_HEIGHT - 526;
    reportContent(CONTENT_WITH_SPACER);
    // The retry waits one frame after the report.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: needed, animated: false });
    expect(scrollOffsetRef.current).toBe(needed);
    // Only once: a later content change does not scroll the page again.
    reportContent(CONTENT_WITH_SPACER + 40);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('drops the retry when the field blurs before the content size arrives', async () => {
    await renderReveal({ animated: false });
    const row = target(627, 48);
    reveal(row);
    await act(async () => { showKeyboard(526); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    release(row);
    reportContent(CONTENT_WITH_SPACER);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('lets go of the content size relay on unmount', async () => {
    await renderReveal();
    expect(contentSizeListenerRef.current).not.toBeNull();
    act(() => root.unmount());
    expect(contentSizeListenerRef.current).toBeNull();
    root = createRoot(container);
  });

  //  on #6938, confirmed by worker N on the Pixel: with Remove
  // animations on, Quick task never moved. A non-animated jump moves the page
  // at once while scrollOffsetRef waits for onScroll, so a retry that measured
  // again aimed short; the retry re-issues the first offset instead.
  it('lands a Reduce Motion lift when the content size grows after the scroll request and onScroll lags', async () => {
    await renderReveal({ animated: false });
    // Quick task at the end of Work: 100 dp of room before the spacer.
    let maxOffset = 100;
    let pageOffset = 0;
    scrollOffsetRef.current = 0;
    // The page jumps at once; onScroll (and so scrollOffsetRef) has not run yet.
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    const taskRow: RevealTarget = { measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) };
    reportContent(CONTENT);
    reveal(taskRow);
    await act(async () => { showKeyboard(526); });
    const needed = 675 + KEYBOARD_REVEAL_MARGIN - 526;
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: needed, animated: false });
    expect(pageOffset).toBe(100);
    // The spacer's content size arrives after the scroll request.
    maxOffset += SCREEN_HEIGHT - 526;
    reportContent(CONTENT_WITH_SPACER);
    runFrames();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: needed, animated: false });
    expect(pageOffset).toBe(needed);
    // The row's bottom now clears the keyboard by the margin.
    expect(627 - pageOffset + 48 + KEYBOARD_REVEAL_MARGIN).toBe(526);
  });

  it('keeps the animated retry measuring again', async () => {
    await renderReveal({ animated: true });
    let rowTop = 627;
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, rowTop, 370, 48) });
    await act(async () => { showKeyboard(526); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The animated scroll has carried the row 100 dp and onScroll kept up.
    rowTop -= 100;
    scrollOffsetRef.current = 100;
    reportContent(CONTENT_WITH_SPACER);
    runFrame();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 100 + (575 + KEYBOARD_REVEAL_MARGIN - 526), animated: true });
  });

  //  on #6938: the retry waits for a content size that includes the
  // spacer, not merely the first content-size report.
  it('does not spend the retry on a content-size report that lacks the spacer', async () => {
    await renderReveal({ animated: false });
    let maxOffset = 100;
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) });
    await act(async () => { showKeyboard(526); });
    expect(pageOffset).toBe(100);
    // Something else on the page changed size before the spacer mounted.
    reportContent(CONTENT + 10);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    maxOffset += SCREEN_HEIGHT - 526;
    reportContent(CONTENT_WITH_SPACER + 10);
    runFrames();
    expect(pageOffset).toBe(675 + KEYBOARD_REVEAL_MARGIN - 526);
  });

  //  on #6938: the content-size report can arrive before
  // measureInWindow's callback; the armed retry must not miss it.
  it('lands a Reduce Motion lift when the content size arrives before the measurement', async () => {
    await renderReveal({ animated: false });
    let maxOffset = 100;
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    const measurements: ((x: number, y: number, width: number, height: number) => void)[] = [];
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => { measurements.push(callback); } });
    await act(async () => { showKeyboard(526); });
    expect(measurements).toHaveLength(1);
    expect(scrollTo).not.toHaveBeenCalled();
    // The spacer is mounted and reported before the measurement comes back.
    maxOffset += SCREEN_HEIGHT - 526;
    reportContent(CONTENT_WITH_SPACER);
    expect(scrollTo).not.toHaveBeenCalled();
    measurements[0]!(0, 627 - pageOffset, 370, 48);
    const needed = 675 + KEYBOARD_REVEAL_MARGIN - 526;
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: needed, animated: false });
    expect(pageOffset).toBe(needed);
    // A content report is not proof of the mount, so the retry
    // still re-issues the same offset a frame later, and onScroll confirms it.
    runFrame();
    reportScroll(pageOffset);
    runFrames();
    expect(pageOffset).toBe(needed);
    expect(scrollTo.mock.calls.every(([options]) => options.y === needed)).toBe(true);
    const calls = scrollTo.mock.calls.length;
    reportContent(CONTENT_WITH_SPACER + 40);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(calls);
  });

  //  on #6938: a same-height keyboard frame used to drop the retry.
  it('keeps the Reduce Motion retry through a same-height keyboard frame', async () => {
    await renderReveal({ animated: false });
    let maxOffset = 100;
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) });
    await act(async () => { showKeyboard(526); });
    expect(pageOffset).toBe(100);
    // Gboard posts the same frame again before the spacer's content size
    // arrives; with onScroll lagging, that lift aims short.
    await act(async () => { showKeyboard(526); });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(pageOffset).toBeLessThan(100);
    maxOffset += SCREEN_HEIGHT - 526;
    reportContent(CONTENT_WITH_SPACER);
    runFrames();
    const needed = 675 + KEYBOARD_REVEAL_MARGIN - 526;
    expect(scrollTo).toHaveBeenLastCalledWith({ y: needed, animated: false });
    expect(pageOffset).toBe(needed);
  });

  //  and on #6938: the spacer-inclusive content report is
  // sent before the mount, so even the deferred scroll can be clamped; the
  // retry confirms through onScroll and re-issues once.
  it('re-issues once when the qualifying content report arrived before the mount', async () => {
    await renderReveal({ animated: false });
    let maxOffset = 100;
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) });
    await act(async () => { showKeyboard(526); });
    const needed = 675 + KEYBOARD_REVEAL_MARGIN - 526;
    // Layout reports the grown content; the native range has not grown yet.
    reportContent(CONTENT_WITH_SPACER);
    runFrame();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(pageOffset).toBe(100);
    // onScroll reports the clamp; the mount lands before the next frame.
    reportScroll(pageOffset);
    maxOffset += SCREEN_HEIGHT - 526;
    runFrame();
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(pageOffset).toBe(needed);
    reportScroll(pageOffset);
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it('re-issues at most once when the page never grows', async () => {
    await renderReveal({ animated: false });
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, 100); });
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) });
    await act(async () => { showKeyboard(526); });
    reportContent(CONTENT_WITH_SPACER);
    for (let round = 0; round < 10; round += 1) {
      runFrame();
      reportScroll(pageOffset);
    }
    // The first lift, the deferred retry and one re-issue: never more.
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(frames.size).toBe(0);
  });

  it('cancels a deferred retry on unmount', async () => {
    await renderReveal({ animated: false });
    scrollTo.mockImplementation(() => undefined);
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627, 370, 48) });
    await act(async () => { showKeyboard(526); });
    reportContent(CONTENT_WITH_SPACER);
    expect(frames.size).toBe(1);
    act(() => root.unmount());
    expect(frames.size).toBe(0);
    expect(scrollListenerRef.current).toBeNull();
    runFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  //  on #6938: a keyboard frame with a new height while the retry
  // waits keeps the measured offset, moved with the keyboard's top.
  it('carries the Reduce Motion offset through a keyboard height change', async () => {
    await renderReveal({ animated: false });
    let maxOffset = 100;
    let pageOffset = 0;
    scrollTo.mockImplementation(({ y }) => { pageOffset = Math.min(y, maxOffset); });
    reportContent(CONTENT);
    reveal({ measureInWindow: (callback) => callback(0, 627 - pageOffset, 370, 48) });
    await act(async () => { showKeyboard(526); });
    expect(pageOffset).toBe(100);
    // The suggestion bar arrives: Gboard's top moves up 46 dp before the
    // first spacer's content size is reported; onScroll still lags.
    await act(async () => { showKeyboard(480); });
    maxOffset += SCREEN_HEIGHT - 480;
    reportContent(CONTENT + SCREEN_HEIGHT - 480);
    runFrames();
    expect(pageOffset).toBe(675 + KEYBOARD_REVEAL_MARGIN - 480);
    expect(627 - pageOffset + 48 + KEYBOARD_REVEAL_MARGIN).toBe(480);
  });
});
