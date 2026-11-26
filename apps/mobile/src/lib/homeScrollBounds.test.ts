// BUG-UG-NATIVE-HOME-HANDLES-VANISH-AFTER-TEXT-SIZE-CHANGE-20261103:
// the Home handles ride translateY = -homeScrollOffset. When a text-size change
// shrinks the feed, the native scroll view clamps its offset without a scroll
// event, so the shared offset must follow the clamp or the handles stay
// translated off screen until the next scroll.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const animated = vi.hoisted(() => ({ value: 0 }));
vi.mock('react-native', () => ({
  Animated: { Value: class { constructor(initial: number) { animated.value = initial; } setValue(next: number) { animated.value = next; } } },
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

import { resetHomeScrollOffset, syncHomeAwayFromTop, syncHomeScrollBounds } from './chrome';
import { clampedScrollOffset } from './chromeGeometry';

// The handle row's translation, as HomeCarousel derives it.
const handleTranslation = () => -animated.value;
// Home's scroll path: the native driver moves the value, the listener records it.
function scrollTo(offset: number) { animated.value = offset; syncHomeAwayFromTop(offset); }

beforeEach(() => { resetHomeScrollOffset(); });

describe('Home handle offset after a content-size change', () => {
  it('follows the clamp when a text-size change shrinks the feed under a scrolled Home', () => {
    syncHomeScrollBounds({ viewportHeight: 800 });
    syncHomeScrollBounds({ contentHeight: 4200 });
    scrollTo(2600);
    expect(handleTranslation()).toBe(-2600);
    // Largest size to large: the remounted feed is 1500 tall, so the native
    // view settles at 700 without a scroll event.
    syncHomeScrollBounds({ contentHeight: 1500 });
    expect(animated.value).toBe(700);
    expect(handleTranslation()).toBe(-700);
    // A feed shorter than the viewport rests at the top.
    syncHomeScrollBounds({ contentHeight: 600 });
    expect(handleTranslation()).toBe(-0);
  });

  it('leaves the offset alone when the content still reaches it', () => {
    syncHomeScrollBounds({ viewportHeight: 800, contentHeight: 4200 });
    scrollTo(1000);
    syncHomeScrollBounds({ contentHeight: 3000 });
    expect(animated.value).toBe(1000);
    // A taller viewport (rotation) clamps too.
    syncHomeScrollBounds({ viewportHeight: 2500 });
    expect(animated.value).toBe(500);
  });

  it('waits for the viewport before clamping, and resets with Home', () => {
    scrollTo(300);
    syncHomeScrollBounds({ contentHeight: 100 });
    expect(animated.value).toBe(300);
    resetHomeScrollOffset();
    expect(animated.value).toBe(0);
    scrollTo(300);
    syncHomeScrollBounds({ contentHeight: 100 });
    expect(animated.value).toBe(300);
  });

  it('never rests past the last screenful or above the top', () => {
    expect(clampedScrollOffset(2600, 1500, 800)).toBe(700);
    expect(clampedScrollOffset(400, 1500, 800)).toBe(400);
    expect(clampedScrollOffset(400, 600, 800)).toBe(0);
    expect(clampedScrollOffset(-20, 1500, 800)).toBe(0);
  });

  it('reports Home\'s viewport and content sizes from its scroll view only', () => {
    const ui = readFileSync(join(__dirname, '../components/ui.tsx'), 'utf8');
    expect(ui).toContain('onLayout={scrollsTopChrome ? (event) => syncHomeScrollBounds({ viewportHeight: event.nativeEvent.layout.height }) : undefined}');
    // The same callback also relays to the keyboard reveal's retry (
    // on #6938) and to a screen that keeps its reader in place (#8068);
    // content sizes are still reported for Home only.
    expect(ui).toContain('onContentSizeChange={(_width, height) => {\n          if (scrollsTopChrome) syncHomeScrollBounds({ contentHeight: height });\n          contentSizeListenerRef.current?.(height);\n          contentHeightListener.current?.(height);\n        }}');
  });
});
