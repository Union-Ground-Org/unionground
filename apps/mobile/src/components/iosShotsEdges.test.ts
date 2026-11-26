import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as chrome from '../lib/chromeGeometry';
import { chapterIdentityPresentation } from '../lib/chapterIdentity';
import { summaryColumns } from '../lib/homeSummaryLayout';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const home = read('../../app/(tabs)/home.tsx');
const screen = read('./ui.tsx');
const switcher = read('./HatSwitcher.tsx');
const carousel = read('./HomeCarousel.tsx');
const tabs = read('../../app/(tabs)/_layout.tsx');

// Owner's November 20 screenshot review: K9, defects 2, 15, 16, 17, 18.
describe('native screenshot edge regressions', () => {
  it('D02: keeps Home chrome out of the status bar, including the root sibling #7547 missed', () => {
    // HatSwitcher is a root sibling: scene content cannot mask a sibling
    // translated over the clock (S13), so it fades itself out.
    expect(switcher).toContain('const pillTop = floatingControlTop(insets.top, spacing.xs);');
    expect(switcher).toContain("inputRange: [0, FLOATING_CONTROL_LIFT], outputRange: [1, 0], extrapolate: 'clamp'");
    expect(switcher).toContain('scrollsWithHome ? Animated.multiply(pillDim, homePillVisibility) : pillDim');
    expect(switcher).toContain('opacity: pillOpacity');
    expect(chrome.FLOATING_CONTROL_LIFT).toBe(8);
    expect(switcher).toContain("pointerEvents={drawerOpen || pillOffScreen ? 'none' : 'box-none'}");
    expect(screen).not.toContain('marginTop:');
    expect(carousel).toContain('top: handleRowTop, opacity: handleOpacity, transform: [{ translateY: handleTravel }]');
  });

  it('D15: gives tab titles one owner for the top inset, instead of UIKit plus Screen padding', () => {
    const triggers = tabs.match(/<NativeTabs.Trigger\s[^>]+>/g) ?? [];
    expect(triggers).toHaveLength(5);
    // Home keeps its original automatic-inset contract; the other roots opt
    // out of UIKit's override while retaining explicit full-edge padding.
    expect(triggers[0]).toContain("disableAutomaticContentInsets={Platform.OS === 'android'}");
    for (const trigger of triggers.slice(1)) expect(trigger).toContain("disableAutomaticContentInsets={Platform.OS === 'ios'}");
    expect(tabs).toContain("disableAutomaticContentInsets={Platform.OS === 'ios'}");
    expect(screen).toContain('nativeHeaderHeight === undefined ? startLine :');
  });

  it('D16: clips only sibling drawer handles, leaving every feed full-edge', () => {
    for (const bottom of [0, 21, 34]) {
      expect(chrome.homeHandleClipInset(bottom, 'ios', false)).toBe(bottom + chrome.IOS_NATIVE_TAB_BAR_HEIGHT + chrome.CHROME_CLEARANCE);
      expect(chrome.homeHandleClipInset(bottom, 'ios', true)).toBe(0);
    }
    expect(chrome.homeHandleClipInset(24, 'android', false)).toBe(0);
    //: a pill crossing the clip is hidden, never cut. A 48pt row at
    // 720pt in a 749pt clip is whole from a 19pt scroll; a taller pill at a
    // large text size reaches further; an unmeasured row or clip draws as before.
    expect(chrome.homeHandleReach(48, 0)).toBe(48);
    expect(chrome.homeHandleReach(48, 80)).toBe(64);
    expect(chrome.homeHandleWholeFromOffset(720, 48, 749)).toBe(19);
    expect(chrome.homeHandleWholeFromOffset(0, 48, 749)).toBeNull();
    expect(chrome.homeHandleWholeFromOffset(720, 48, 0)).toBeNull();
    // Whole at rest (exactly, or with room to spare): no threshold (Sol answer 7).
    expect(chrome.homeHandleWholeFromOffset(701, 48, 749)).toBeNull();
    expect(chrome.homeHandleWholeFromOffset(700.75, 48, 749)).toBeNull();
    expect(chrome.homeHandleWholeFromOffset(701.25, 48, 749)).toBe(0.25);
    // It acts only once its half-point fade has ended ( split).
    expect(chrome.HOME_HANDLE_FADE).toBe(0.5);
    expect(chrome.homeHandleDrawn(19, 19)).toBe(false);
    expect(chrome.homeHandleDrawn(19.49, 19)).toBe(false);
    expect(chrome.homeHandleDrawn(19.5, 19)).toBe(true);
    expect(chrome.homeHandleDrawn(-40, -101)).toBe(true);
    expect(chrome.homeHandleDrawn(0, null)).toBe(true);
    expect(screen).toContain('style={{ marginBottom: bottomClearance }}');
    expect(screen).not.toContain('nativeTabViewportInsets');
    expect(carousel).toContain('marginBottom: minimizedReserve');
    expect(carousel).toContain('testID="home-drawer-handle-clip"');
    expect(tabs).toContain('minimizeBehavior={screenReader');
    expect(tabs).toContain("? 'never' : 'onScrollDown'}");
  });

  it('D17: avoids a lone final tile for three staff or five worker metrics, in either language', () => {
    for (const width of [390, 402]) {
      for (const fontScale of [1, 1.353, 2, 3.571]) {
        for (const labels of [
          ['Open issues', 'Due this week', 'In arbitration'],
          ['Open issues', 'Activity', 'Unread messages', 'This week', 'Recruited this year'],
          ['Casos abiertos', 'Esta semana', 'En arbitraje'],
          ['Casos abiertos', 'Actividad', 'Mensajes sin leer', 'Esta semana', 'Personas reclutadas este año'],
        ]) {
          const columns = summaryColumns({ labels, fontScale, rowWidth: width - 48, columnPadding: 16 });
          expect(columns === 1 || labels.length % columns !== 1, `${width}/${fontScale}/${labels.length}: ${columns}`).toBe(true);
        }
      }
    }
    expect(home).toContain('...SUMMARY_LABELS, REFERRAL_COPY.homeLabel');
    expect(home).not.toContain('hint="Opens Contributions." width="100%"');
    expect(home).not.toContain("summaryWidth === '25%' ?");
  });

  it('D18: keeps every campaign separator with the preceding word in English and Spanish', () => {
    const memberships = [
      { name: 'Service Coordination', region: 'Tamarack County', selected: true },
      { name: 'Transportation', region: null, selected: false },
    ];
    for (const language of ['en', 'es'] as const) {
      for (const rows of [memberships, [memberships[0]!], memberships.map(row => ({ ...row, region: null }))]) {
        const identity = chapterIdentityPresentation(rows, language);
        expect(identity.subtitle).not.toMatch(/(?<!\u00a0)·/u);
        if (language === 'es') {
          expect(identity.subtitle).toMatch(/campaña/i);
          expect(identity.accessibilityHint).toBe('Abre la lista de campañas');
        }
      }
    }
  });
});
