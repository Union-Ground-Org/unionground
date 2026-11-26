// BUG-UG-NATIVE-QUICK-NOTE-PLACEHOLDER-CLIPPED-AT-LARGEST-TEXT-IOS-20261103:
// at the largest iPhone text size (React Native's fontScale 3.571) the Quick
// note placeholder wrapped to two lines inside a fixed 120 pt cap and showed
// only "Capture a".
import { describe, expect, it } from 'vitest';

import { placeholderFitMultiplier, placeholderMaxHeight } from './placeholderFit';

const LARGEST = 3.571;
const field = { baseMaxHeight: 120, lineHeight: 22, verticalChrome: 18 };

describe('placeholderMaxHeight', () => {
  it('keeps the usual cap at the default text size', () => {
    expect(placeholderMaxHeight('Capture a note', { ...field, fontScale: 1 })).toBe(120);
    expect(placeholderMaxHeight('Message the committee thread', { ...field, fontScale: 1 })).toBe(120);
  });

  it('lets the Quick note placeholder wrap whole at the largest size', () => {
    const line = 22 * LARGEST;
    // The clipped field: two wrapped lines need more than the old 120 pt cap.
    expect(2 * line + field.verticalChrome).toBeGreaterThan(120);
    // One line per word fits under the new cap, so "note" is never cut off.
    expect(placeholderMaxHeight('Capture a note', { ...field, fontScale: LARGEST })).toBeGreaterThanOrEqual(3 * line + field.verticalChrome);
    expect(placeholderMaxHeight('Message the committee thread', { ...field, fontScale: LARGEST })).toBeGreaterThanOrEqual(4 * line + field.verticalChrome);
  });

  it('ignores a missing or shrinking text scale', () => {
    expect(placeholderMaxHeight('Capture a note', { ...field, fontScale: 0.82 })).toBe(120);
    expect(placeholderMaxHeight('Capture a note', { ...field, fontScale: Number.NaN })).toBe(120);
    expect(placeholderMaxHeight('', { ...field, fontScale: LARGEST })).toBe(120);
  });
});

describe('placeholderFitMultiplier', () => {
  it('leaves the system size alone until the line is measured', () => {
    expect(placeholderFitMultiplier('Add a task', 16, 0)).toBeUndefined();
    expect(placeholderFitMultiplier('', 16, 280)).toBeUndefined();
  });

  it('caps the text where the whole placeholder still fits its line', () => {
    // iPhone 17 Quick task line: 280 pt wide.
    const cap = placeholderFitMultiplier('Add a task', 16, 280)!;
    expect(cap).toBeCloseTo(3.5);
    expect(cap * 16 * 0.5 * 'Add a task'.length).toBeLessThanOrEqual(280);
    // A narrower phone caps lower, never below the default size.
    expect(placeholderFitMultiplier('Add a task', 16, 220)).toBeLessThan(cap);
    expect(placeholderFitMultiplier('Add a task', 16, 40)).toBe(1);
  });
});
