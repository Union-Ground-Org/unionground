// Pure value logic for the rolling stat (NumberFlow.tsx), the native twin of
// the web's src/components/FlowValue.jsx. Dependency-free so vitest can
// execute it (numberFlow.test.ts).
//
// Stat surfaces hand the component an already formatted string: "38%",
// "1,204", "3h", "$8.4k", and also "Not available", "Sep 12", "213/300" or
// "2:45". Only a value that is one number with a short unit around it rolls.
// The component never reformats: prefix + core + suffix is always the exact
// string it was given, so units, fractions and locale separators render as the
// caller wrote them.

const NUMBER = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s;

export type FlowParts = { prefix: string; core: string; suffix: string };

/** Splits the first number out of a formatted value, or null when there is none. */
export function splitFlowValue(value: string): FlowParts | null {
  const match = NUMBER.exec(value);
  if (!match) return null;
  const [, prefix = '', core = '', suffix = ''] = match;
  return { prefix, core, suffix };
}

/**
 * Words around the number beyond this length make the value prose ("Due in 3
 * days, Sep 12"), not a stat: rolling it would trade a readable wrapped line
 * for a marquee.
 */
export const FLOW_TEXT_BUDGET = 8;

/**
 * Parts to roll, or null when the value should stay plain text. A second number
 * after the first ("213/300", "2:45", "1 234,5", "3 of 12") means the split
 * cannot tell which digits are the stat, so the whole value is left as one
 * string that keeps its own wrapping and shrink-to-fit.
 */
export function flowParts(value: string): FlowParts | null {
  const parts = splitFlowValue(value);
  if (!parts) return null;
  if (parts.prefix.length + parts.suffix.length > FLOW_TEXT_BUDGET) return null;
  if (/\d/.test(parts.suffix)) return null;
  return parts;
}

export function shouldFlow(value: string): boolean {
  return flowParts(value) !== null;
}

/**
 * Digit columns cannot wrap, and their cell is a measured line box. Past this
 * text scale the value renders as an ordinary Text so Dynamic Type accessibility
 * sizes wrap and shrink the way every other line does.
 */
export const FLOW_MAX_FONT_SCALE = 1.35;

export function canFlowAtFontScale(fontScale: number): boolean {
  return Number.isFinite(fontScale) && fontScale <= FLOW_MAX_FONT_SCALE;
}

export type FlowColumn = { char: string; key: string; digit: number | null };

/**
 * Columns of the numeric core, keyed from the right so the units digit keeps
 * its roller when the count gains or loses a leading digit ("99" to "100").
 * Separators are columns too, so "1,204" keeps its comma in place.
 */
export function flowColumns(core: string): FlowColumn[] {
  const chars = Array.from(core);
  return chars.map((char, index) => {
    const fromRight = chars.length - 1 - index;
    return /^\d$/.test(char)
      ? { char, key: `d${fromRight}`, digit: Number(char) }
      : { char, key: `c${fromRight}`, digit: null };
  });
}

/** Resting translateY of a 0-9 column whose cells are `cell` points tall. */
export function digitOffset(digit: number, cell: number): number {
  return -digit * cell;
}

/**
 * What a digit column does when its inputs change. A column that has never
 * settled, or whose digit is unchanged (a Dynamic Type resize, a parent
 * re-render), jumps to its resting place: an unchanged number never animates.
 */
export function digitTransition(previous: number | null, next: number): 'set' | 'roll' {
  return previous === null || previous === next ? 'set' : 'roll';
}

/**
 * Scale that keeps a rolling row inside the width its parent gave it. Digit
 * columns cannot shrink the way adjustsFontSizeToFit text does, so the whole
 * row scales instead. Unmeasured, zero or already-fitting rows return 1.
 */
export function fitScale(available: number, content: number): number {
  if (!(available > 0) || !(content > 0)) return 1;
  if (content <= available + 0.5) return 1;
  return available / content;
}

/**
 * A whole count with its thousands separators, e.g. 1840 -> "1,840". Callers
 * format before handing the value over — the component itself never reformats
 * — and a separated count is also what keeps a long total from needing the
 * width of five bare digits in a narrow tile.
 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export function formatFlowCount(value: number): string {
  return Number.isFinite(value) ? COUNT_FORMAT.format(value) : String(value);
}

export function flowAlignment(textAlign: string | undefined): 'flex-start' | 'center' | 'flex-end' {
  if (textAlign === 'center') return 'center';
  if (textAlign === 'right') return 'flex-end';
  return 'flex-start';
}
