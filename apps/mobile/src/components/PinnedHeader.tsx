import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { Platform, Pressable, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FLOATING_CONTROL_HIT_WIDTH,
  FLOATING_CONTROL_SIZE,
  floatingControlHitHeight,
  floatingControlTop,
} from '../lib/chrome';
import {
  PINNED_TITLE_FONT_SIZE,
  PINNED_TITLE_LINE_HEIGHT,
  pinnedRowBackingHeight,
  pinnedRowContentInset,
  pinnedTitleLeft,
  pinnedTitleLineEstimate,
  pinnedTitleRight,
  pinnedTitleScale,
  pinnedTitleTop,
} from '../lib/chromeGeometry';
import { nativeUiText, type NativeLanguage } from '../lib/nativeUiCopy';
import { controlSlotTop, echoesScreenName, pinnedHeaderLayout } from '../lib/pinnedHeaderOrder';
import { runScreenBackInterceptor } from '../lib/screenBack';
import { haptics } from '../services/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';
import { FontScaleRelayout } from './FontScaleRelayout';
import { FrostedCapsule, withAlpha } from './TopChrome';

// A pushed surface's top chrome. Since
// UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115 (the owner's pick on
// the phone layout plan, Nov 15, 2026) the title sits on one row beside the
// back control: on iPhone the frosted back circle, then the title; on Android
// the back arrow, then the title. The compact hat capsule (drawn by
// HatSwitcher) keeps the right end of the same row. A canvas backing behind
// the row keeps scrolled content from reading through the title, with no line
// along its bottom edge. The row's heading is still an invisible
// slot spanning the screen, so a screen reader reads the title before Back
// (pinnedHeaderOrder.ts); the painted title is hidden from it.

export const BACK_FALLBACK_ROUTE = '/(tabs)/home';

export function PinnedHeader({ title, screenName, headingTestID, onBack, language = 'en', titleHeight = 0, onTitleLayout }: {
  /** The surface's page title, painted on the row beside the back control. */
  title?: string;
  /**
   * The surface's name when no separate title is given. It is painted on the
   * row the same way, and a scene heading with these exact words is not painted
   * again (ui.tsx `Heading`, `useScreenNameAlreadySpoken`).
   */
  screenName?: string;
  headingTestID?: string;
  onBack?: (() => void) | null;
  language?: NativeLanguage;
  /** The painted title's measured height, for the backing below the row. */
  titleHeight?: number;
  onTitleLayout?: (height: number) => void;
}) {
  const theme = useTheme();
  // The back circle's light fill, the one the DEMO pill carries (a control, not a bar).
  const backCircleFill = withAlpha(theme.card, 0.7);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  // The title's own size for this text size, font and line together, capped.
  const titleScale = pinnedTitleScale(fontScale);
  const showBack = onBack !== null;
  // One heading per surface, painted once, on the row.
  const heading = title ?? screenName;
  // A pushed surface can be the first route in the stack — deep link, push
  // notification tap, cold start on a saved route — and then there is nothing
  // to pop. The chevron used to do nothing at all in that state.
  const canGoBack = router.canGoBack();
  const backLabel = nativeUiText(language)(onBack || canGoBack ? 'Back' : 'Home');
  const controlTop = floatingControlTop(insets.top, spacing.xs);
  const bandHeight = floatingControlHitHeight(insets.top, controlTop);
  const backingHeight = pinnedRowBackingHeight(insets.top, spacing.xs, heading ? titleHeight : 0);

  function goBack() {
    void haptics.select();
    if (onBack) {
      onBack();
      return;
    }
    // A surface that opened a second level inside itself — the rights reading
    // view over its index — answers Back before the stack does, so the chevron
    // returns to the list instead of popping the whole feature (#1021
    // follow-up 2). Nothing is registered on an ordinary pushed surface, so
    // this is a no-op everywhere else.
    if (runScreenBackInterceptor()) return;
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(BACK_FALLBACK_ROUTE);
  }

  return (
    <View pointerEvents="box-none" style={[styles.header, { height: Math.max(controlTop + bandHeight, backingHeight) }]}>
      {/* The canvas behind the row: the page's own colour, so it cannot be
          seen at rest or once content has scrolled under it. No line marks
          its bottom edge (UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118). */}
      <View
        pointerEvents="none"
        style={[styles.backing, { height: backingHeight, backgroundColor: theme.background }]}
      />
      {/*
        The slot, not the text, is the heading element, and its frame starts
        `headingSlotLift` above the control band (pinnedHeaderOrder.ts) so the
        heading leads the back control on the top edge as well as on minX.
        React Native never sets `accessibilityElements`, so UIKit orders these
        siblings automatically and the frame is the only lever we have. The
        back circle stays the front-most view in its own slot
        (`styles.leading` keeps `zIndex: 1` and is rendered after this slot,
        which is `pointerEvents="none"`), so taps and explore-by-touch still
        resolve to it even though this frame overlaps it.
      */}
      <View
        style={[styles.titleSlot, { top: controlTop - pinnedHeaderLayout.headingSlotLift, height: bandHeight + pinnedHeaderLayout.headingSlotLift }]}
        pointerEvents="none"
        accessible={Boolean(heading)}
        accessibilityRole={heading ? 'header' : undefined}
        accessibilityLabel={heading}
        testID={headingTestID}
      />
      {heading ? (
        // The painted title: beside the back control, two lines at most, then
        // an ellipsis. The slot above carries its full words for a screen
        // reader, so this copy stays out of the accessibility tree.
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.titleRow, { top: pinnedTitleTop(controlTop), left: pinnedTitleLeft(showBack), right: pinnedTitleRight() }]}
        >
          {/* A text size change while the screen is open mounts the title
              again, so it is never drawn in the frame measured at the old
              size (iOS kept that frame and cut the words off). */}
          <FontScaleRelayout>
            <Text
              numberOfLines={2}
              ellipsizeMode="tail"
              allowFontScaling={false}
              onLayout={onTitleLayout ? (event: LayoutChangeEvent) => onTitleLayout(event.nativeEvent.layout.height) : undefined}
              style={[styles.title, { color: theme.foreground, fontSize: PINNED_TITLE_FONT_SIZE * titleScale, lineHeight: PINNED_TITLE_LINE_HEIGHT * titleScale }]}
            >
              {heading}
            </Text>
          </FontScaleRelayout>
        </View>
      ) : null}
      <View style={[styles.leading, { top: controlTop + controlSlotTop(bandHeight, bandHeight), height: bandHeight }]} pointerEvents="box-none">
        {showBack ? (
          // The tap target is the slot: 48pt wide, and tall enough from the
          // circle's top edge that 48pt of it sits below the safe-area line
          // (floatingControlHitHeight), so it never reaches up into the
          // status-bar frame, where a tap is never delivered (gate round 3 on
          // PR #4254). No hitSlop, which would push it there. The content
          // starts below the band (pinnedRowContentInset), so the part of it
          // under the circle covers nothing
          // (BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019).
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={goBack}
            style={styles.backTarget}
          >
            {({ pressed }) => Platform.OS === 'android' ? (
              // Android: the Material back arrow, then the title, as the
              // platform's own top app bar draws it.
              <View style={[styles.backArrow, pressed ? { opacity: 0.6 } : null]}>
                <Ionicons name="arrow-back" size={24} color={theme.foreground} />
              </View>
            ) : (
              <FrostedCapsule style={[styles.backCircle, { borderColor: theme.border }, pressed ? { opacity: 0.82 } : null]}>
                {/* The light fill the DEMO pill carries, so the two controls
                    read as one family on the solid top edge. */}
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: backCircleFill }]} />
                <View style={styles.backGlyph}>
                  <Ionicons name="chevron-back" size={16} color={theme.foreground} />
                </View>
              </FrostedCapsule>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type PinnedHeaderChrome = {
  /** The content start line below the title row (pinnedRowContentInset). */
  contentInset: number;
};

const PinnedHeaderContext = createContext<PinnedHeaderChrome | null>(null);

export function usePinnedHeaderChrome(): PinnedHeaderChrome | null {
  return useContext(PinnedHeaderContext);
}

// The name the title row paints and announces for this surface, published so
// the scene below does not paint or say it a second time. Null on a tab root,
// which has no back control and no title row.
const PinnedHeaderNameContext = createContext<string | null>(null);

export function usePinnedHeaderScreenName(): string | null {
  return useContext(PinnedHeaderNameContext);
}

export type ScreenNameEcho = {
  /**
   * The title row already paints and announces these exact words, so the
   * scene's own copy of them is not drawn (ui.tsx `Heading` returns nothing).
   */
  duplicate: boolean;
  /**
   * For a scene line that has to stay painted next to the name (a glyph, a
   * band): it leaves the accessibility tree on both platforms, so the name is
   * announced once and the rotor lists one heading for it.
   */
  hiddenProps: {
    accessible?: false;
    accessibilityElementsHidden: boolean;
    importantForAccessibility: 'auto' | 'no-hide-descendants';
  };
};

const SPEAK: ScreenNameEcho = {
  duplicate: false,
  hiddenProps: { accessibilityElementsHidden: false, importantForAccessibility: 'auto' },
};
const ALREADY_SPOKEN: ScreenNameEcho = {
  duplicate: true,
  hiddenProps: { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' },
};

/**
 * For a scene that paints the surface's own name. The title row paints and
 * announces the name on every pushed screen, so a scene heading with the same
 * words would show and be read twice; `duplicate` tells the scene to leave it
 * out.
 */
export function useScreenNameAlreadySpoken(text: unknown): ScreenNameEcho {
  const screenName = usePinnedHeaderScreenName();
  return echoesScreenName(text, screenName) ? ALREADY_SPOKEN : SPEAK;
}

// Host for a pushed surface: renders the title row over the scene and hands
// the content start line below it down to whichever Screen renders inside it,
// so callers never repeat the arithmetic.
export function PinnedHeaderScreen({ title, screenName, headingTestID, onBack, language, children }: PropsWithChildren<{
  title?: string;
  screenName?: string;
  headingTestID?: string;
  onBack?: (() => void) | null;
  language?: NativeLanguage;
}>) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const heading = title ?? screenName ?? null;
  // Until the title has laid out, the row is sized for one line at this text
  // size; a second line moves the content start line down once measured.
  const [measuredTitle, setMeasuredTitle] = useState<{ key: string; height: number } | null>(null);
  const titleKey = `${heading ?? ''}|${fontScale}`;
  const titleHeight = heading
    ? (measuredTitle?.key === titleKey ? measuredTitle.height : pinnedTitleLineEstimate(fontScale))
    : 0;
  const onTitleLayout = useCallback((height: number) => {
    setMeasuredTitle((current) => (current?.key === titleKey && current.height === height ? current : { key: titleKey, height }));
  }, [titleKey]);
  const contentInset = pinnedRowContentInset(insets.top, spacing.xs, titleHeight);
  const chrome = useMemo<PinnedHeaderChrome>(() => ({ contentInset }), [contentInset]);

  return (
    <PinnedHeaderContext.Provider value={chrome}>
      <PinnedHeaderNameContext.Provider value={title ?? screenName ?? null}>
        <View style={styles.host}>
          {children}
          <PinnedHeader
            title={title}
            screenName={screenName}
            headingTestID={headingTestID}
            onBack={onBack}
            language={language}
            titleHeight={titleHeight}
            onTitleLayout={onTitleLayout}
          />
        </View>
      </PinnedHeaderNameContext.Provider>
    </PinnedHeaderContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  // Above the scene and the ramp: the row floats over the content, and the
  // frame ends with the backing so nothing below it is covered.
  header: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30 },
  backing: { position: 'absolute', top: 0, left: 0, right: 0 },
  // The 48pt-wide tap target, anchored at the circle's top edge and holding
  // 48pt below the safe-area line.
  // Rendered after the heading slot and raised, so the overlapping heading
  // frame never takes its touches.
  leading: {
    position: 'absolute',
    left: pinnedHeaderLayout.hitInset,
    width: FLOATING_CONTROL_HIT_WIDTH,
    zIndex: 1,
  },
  backTarget: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  // The painted circle: FLOATING_CONTROL_SIZE square at the top of the target,
  // so the target grows downwards, over the gap below the row, rather than
  // upwards into the status bar.
  // A hairline keyline in theme.border (3.5:1 or better on every theme, the
  // DEMO pill's own boundary), so the circle still reads as a button where it
  // sits on the solid top edge rather than over scrolled content.
  backCircle: { width: FLOATING_CONTROL_SIZE, height: FLOATING_CONTROL_SIZE, borderWidth: StyleSheet.hairlineWidth },
  backGlyph: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Android's arrow sits where the circle would, centred on the same line.
  backArrow: { height: FLOATING_CONTROL_SIZE, width: FLOATING_CONTROL_HIT_WIDTH, alignItems: 'center', justifyContent: 'center' },
  // The painted title: the one title scale (owner decision, October 10, 2026),
  // 22/28 at the default text size, two lines at most; the row scales both
  // numbers together (pinnedTitleScale).
  titleRow: { position: 'absolute' },
  // The page title is a heading: Archivo 800 from the typography tokens.
  title: { ...typeface.heading, fontSize: 22, lineHeight: 28, letterSpacing: -0.25 },
  // Stretched across the screen rather than shrink-wrapped: the frame is what
  // iOS sorts, and it paints nothing at all.
  titleSlot: {
    position: 'absolute',
    left: pinnedHeaderLayout.titleSlotInset,
    right: pinnedHeaderLayout.titleSlotInset,
  },
});
