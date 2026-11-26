// BUG-UG-NATIVE-QUICK-NOTE-PLACEHOLDER-CLIPPED-AT-LARGEST-TEXT-IOS-20261103:
// at the largest iPhone text size the Quick note placeholder wrapped to two
// lines, but the field stopped growing at its fixed 120 pt cap, so only
// "Capture a" showed. A multiline field's cap now grows with the text size
// until the placeholder can wrap one word per line. A single-line field cannot
// wrap, so it grows with the system size only as far as its whole placeholder
// still fits the line it was laid out in, the way src/lib/wordFit.ts keeps a
// word whole.

// A generous average advance for the regular system font, in ems: "Add a task"
// measures about 4.4 em in SF Pro at the largest size, under 10 x 0.5.
const AVERAGE_REGULAR_GLYPH_EM = 0.5;

function wordCount(placeholder: string): number {
  return placeholder.split(/\s+/u).filter(Boolean).length;
}

// The tallest a multiline field may grow before it scrolls: its usual cap, or
// enough lines at the current text size for the placeholder to wrap one word
// per line, whichever is taller. `verticalChrome` is the field's vertical
// padding and borders.
export function placeholderMaxHeight(
  placeholder: string,
  { baseMaxHeight, lineHeight, fontScale, verticalChrome }: { baseMaxHeight: number; lineHeight: number; fontScale: number; verticalChrome: number },
): number {
  const scale = Number.isFinite(fontScale) && fontScale > 1 ? fontScale : 1;
  return Math.max(baseMaxHeight, Math.ceil(wordCount(placeholder) * lineHeight * scale + verticalChrome));
}

// The largest font-size multiplier at which a single-line field's whole
// placeholder fits a line `lineWidth` points wide, never below the unscaled
// size. Undefined until the line has been measured, which leaves the system
// size alone.
export function placeholderFitMultiplier(placeholder: string, fontSize: number, lineWidth: number): number | undefined {
  const length = placeholder.trim().length;
  if (length === 0 || !(lineWidth > 0) || !(fontSize > 0)) return undefined;
  return Math.max(1, lineWidth / (length * fontSize * AVERAGE_REGULAR_GLYPH_EM));
}
