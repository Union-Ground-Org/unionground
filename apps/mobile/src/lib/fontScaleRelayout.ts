// Pure key for FontScaleRelayout (src/components/FontScaleRelayout.tsx).
// Dependency-free so vitest can execute it (fontScaleRelayout.test.ts).
//
// BUG-UG-NATIVE-HOME-ACCESSIBILITY-TEXT-CLIPPED-20261103: when the
// iPhone text size changes while the app is open, React Native draws each
// existing text at the new size inside the frame it measured at the old size,
// so Home's name, role, chapter card, summary labels, headings and the vote
// card title showed only the tops of their glyphs. The same screen opened
// fresh at that size lays out whole. A text first mounted after the change is
// measured at the new size, so the content under the key is mounted again
// whenever the scale changes.

/**
 * One key per text scale. Rounded to the thousandth so float noise in the
 * reported scale never remounts a screen; a missing or invalid scale reads as
 * the default 1.
 */
export function fontScaleLayoutKey(fontScale: number): string {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return `font-scale-${Math.round(scale * 1000)}`;
}
