import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A11Y-UG-NATIVE-CHAPTER-RAIL-CLOSE-IGNORES-ASSISTIVE-PRESS-20261111:
// "Close chapter rail" was the full-screen dimmed backdrop. A screen reader
// activates an element at its centre, which the rail panel covers, so an
// assistive press never closed the rail and an iPhone user could not leave it.
// The mobile lane ships no React renderer, so the contract is pinned in source
// the way chromeContract.test.ts pins the rest of the chrome.
const rail = readFileSync(fileURLToPath(new URL('./ChapterRail.tsx', import.meta.url)), 'utf8');
const pressables = [...rail.matchAll(/<Pressable\b[\s\S]*?>/g)].map(([tag]) => tag);

describe('campaign rail close for assistive technology', () => {
  it('has exactly one control named "Close campaign rail", and it is a real button that closes the rail', () => {
    const closers = pressables.filter((tag) => tag.includes('accessibilityLabel="Close campaign rail"'));
    expect(closers).toHaveLength(1);
    expect(closers[0]).toContain('accessibilityRole="button"');
    expect(closers[0]).toContain('onPress={onClose}');
    expect(closers[0]).toContain('style={styles.closeButton}');
  });

  it('puts that button inside the rail panel, where its centre is on screen and uncovered', () => {
    const panelStart = rail.indexOf('<View style={[styles.panel, { backgroundColor: theme.card }]}>');
    const closeAt = rail.indexOf('accessibilityLabel="Close campaign rail"');
    expect(panelStart).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(panelStart);
    // It comes before both the live and the preview panel content, so it is
    // the first thing a screen reader reaches in the panel in either mode.
    expect(closeAt).toBeLessThan(rail.indexOf('{live ? (', panelStart));
    // A 48 dp square target (touch-target audit and the native contract).
    expect(rail).toContain("closeButton: { alignSelf: 'flex-end', width: minimumTouchTarget, height: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },");
  });

  it('leaves the dimmed backdrop as a touch-only way out that screen readers skip', () => {
    const scrim = pressables.find((tag) => tag.includes('styles.scrim'));
    expect(scrim).toBeDefined();
    expect(scrim).toContain('accessible={false}');
    expect(scrim).toContain('importantForAccessibility="no"');
    expect(scrim).toContain('onPress={onClose}');
    expect(scrim).not.toContain('accessibilityLabel');
    expect(scrim).not.toContain('accessibilityRole');
  });

  it('closes with each platform\'s standard dismiss and keeps focus inside the rail while open', () => {
    // Android Back (and the iPhone hardware-keyboard escape) through the Modal.
    expect(rail).toContain('<Modal visible={open} transparent animationType="none" onRequestClose={onClose}>');
    // The VoiceOver escape gesture (two-finger scrub), and no focus behind the rail.
    expect(rail).toContain('<View style={styles.overlay} accessibilityViewIsModal onAccessibilityEscape={onClose}>');
  });
});
