import { describe, expect, it } from 'vitest';

import { createTouchGate, glowFrame, resolveGlow, rowIndexAtOffset, sortRows } from './rowHighlight';

// Numeric contract for the native list-highlight geometry (owner request
// 2026-09-13). The component is untestable without a renderer; the math a
// finger drives through it is not.
describe('row highlight geometry', () => {
  const rows = [
    { y: 0, height: 88 },
    { y: 88, height: 96 },
    { y: 184, height: 72 },
  ];

  it('resolves the row a finger is over', () => {
    expect(rowIndexAtOffset(rows, 0)).toBe(0);
    expect(rowIndexAtOffset(rows, 87.9)).toBe(0);
    expect(rowIndexAtOffset(rows, 120)).toBe(1);
    expect(rowIndexAtOffset(rows, 255)).toBe(2);
  });

  it('gives a separator to the row below it', () => {
    // A touch exactly on the hairline belongs to the row the finger is moving
    // into, so the bar never stalls on the boundary.
    expect(rowIndexAtOffset(rows, 88)).toBe(1);
    expect(rowIndexAtOffset(rows, 184)).toBe(2);
  });

  it('returns null above, below, and between rows', () => {
    expect(rowIndexAtOffset(rows, -4)).toBeNull();
    expect(rowIndexAtOffset(rows, 256)).toBeNull();
    expect(rowIndexAtOffset([{ y: 0, height: 40 }, { y: 60, height: 40 }], 50)).toBeNull();
    expect(rowIndexAtOffset([], 10)).toBeNull();
  });

  it('orders rows by position however they register', () => {
    expect(sortRows([{ y: 184, height: 72 }, { y: 0, height: 88 }, { y: 88, height: 96 }])).toEqual(rows);
  });

  it('does not mutate the registry it sorts', () => {
    const registered = [{ y: 184, height: 72 }, { y: 0, height: 88 }];
    sortRows(registered);
    expect(registered[0]).toEqual({ y: 184, height: 72 });
  });

  it('insets the bar off the separators', () => {
    expect(glowFrame({ y: 88, height: 96 }, 1)).toEqual({ top: 89, height: 94 });
    expect(glowFrame({ y: 88, height: 96 })).toEqual({ top: 88, height: 96 });
  });

  it('never inverts a short row', () => {
    // A 2pt row asked for a 6pt inset would otherwise resolve to a negative
    // height and disappear behind its own frame.
    expect(glowFrame({ y: 10, height: 2 }, 6)).toEqual({ top: 10.5, height: 1 });
    expect(glowFrame({ y: 10, height: 0 }, 6)).toEqual({ top: 10, height: 1 });
  });
});

describe('row highlight decisions', () => {
  // Rows are registered out of order on purpose: layout does not report
  // top-to-bottom.
  const rows = [
    { y: 184, height: 72 },
    { y: 0, height: 88 },
    { y: 88, height: 96 },
  ];

  it('lands, without sliding, when the bar appears from nothing', () => {
    expect(resolveGlow(rows, 120, null, 1)).toEqual({ action: 'land', frame: { top: 89, height: 94 } });
  });

  it('glides when the finger moves to another row', () => {
    expect(resolveGlow(rows, 200, { top: 89, height: 94 }, 1)).toEqual({ action: 'glide', frame: { top: 185, height: 70 } });
  });

  it('stays put while the finger moves inside the same row', () => {
    expect(resolveGlow(rows, 100, { top: 89, height: 94 }, 1)).toEqual({ action: 'stay' });
    expect(resolveGlow(rows, 182, { top: 89, height: 94 }, 1)).toEqual({ action: 'stay' });
  });

  it('hides over a header, a gap, or past the list', () => {
    expect(resolveGlow(rows, -3, { top: 89, height: 94 }, 1)).toEqual({ action: 'hide' });
    expect(resolveGlow(rows, 300, { top: 89, height: 94 }, 1)).toEqual({ action: 'hide' });
    expect(resolveGlow([{ y: 0, height: 40 }, { y: 60, height: 40 }], 50, null)).toEqual({ action: 'hide' });
  });

  it('follows a row that resized under a stationary finger', () => {
    // Dynamic Type or a width change relaid the second row taller. The bar was
    // parked on its old frame; the same touch offset now resolves a new frame.
    const resized = [{ y: 0, height: 88 }, { y: 88, height: 120 }];
    expect(resolveGlow(resized, 120, { top: 89, height: 94 }, 1)).toEqual({ action: 'glide', frame: { top: 89, height: 118 } });
  });

  it('does not shoot the bar across the screen after the list re-registers', () => {
    // Nothing moved: identical frames must be a no-op, not a redundant glide.
    expect(resolveGlow(rows, 120, glowFrame({ y: 88, height: 96 }, 1), 1)).toEqual({ action: 'stay' });
  });
});

describe('touch gate', () => {
  it('accepts the measurement of the touch that is still down', () => {
    const gate = createTouchGate();
    const token = gate.begin();
    expect(gate.isLive(token)).toBe(true);
    expect(gate.touching).toBe(true);
  });

  it('drops a measurement that returns after the finger lifted', () => {
    // A quick tap: touch end fires before measureInWindow calls back. Without
    // this the bar would land on the row after release and never leave.
    const gate = createTouchGate();
    const token = gate.begin();
    gate.end();
    expect(gate.isLive(token)).toBe(false);
    expect(gate.touching).toBe(false);
  });

  it('drops a measurement that belongs to an earlier touch', () => {
    const gate = createTouchGate();
    const first = gate.begin();
    gate.end();
    const second = gate.begin();
    expect(gate.isLive(first)).toBe(false);
    expect(gate.isLive(second)).toBe(true);
  });

  it('treats a second finger down as the newest touch', () => {
    const gate = createTouchGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLive(first)).toBe(false);
    expect(gate.isLive(second)).toBe(true);
  });
});
