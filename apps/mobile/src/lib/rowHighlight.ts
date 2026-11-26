// Native counterpart of the web's src/lib/rowHighlight.js (owner request
// 2026-09-13, modelled on 21st.dev hyperiux/interactive-list-preview): one
// translucent bar glides between the rows of a long list instead of every row
// flashing its own block. The web build follows a pointer that hovers; a phone
// has no hover, so the bar follows the touch and leaves with it.
//
// The geometry is pure and dependency-free so vitest can execute it
// (rowHighlight.test.ts). Rows report their own frames on layout; the list
// resolves which frame a touch is over and where to park the bar.

export type RowFrame = { y: number; height: number };
export type GlowFrame = { top: number; height: number };

// The theme token the bar paints. Row copy of every ink (foreground,
// cardForeground, mutedForeground, and the primary of an unread time) sits on
// it while a finger is down, so it is the one surface that keeps all of them at
// WCAG AA in every palette: muted drops primary text to 4.48:1 in Union
// green's dark form.
// listMotion.test.ts audits this token against the palette.
export const ROW_GLOW_SURFACE = 'secondary' as const;

// Rows register as they lay out, which is not always top-to-bottom, and a row
// that re-renders shorter must not leave a stale frame behind. Sorting by y
// keeps the resolved order stable whatever order the registrations arrive in.
export function sortRows(rows: readonly RowFrame[]): RowFrame[] {
  return [...rows].sort((a, b) => a.y - b.y);
}

/**
 * Index of the row under `offset` (points from the top of the list), or null
 * when the touch is in a gap, a header, or past the last row. Bounds are
 * half-open so a touch exactly on a separator belongs to the row below it,
 * which is what the eye expects when a finger slides down a list.
 */
export function rowIndexAtOffset(rows: readonly RowFrame[], offset: number): number | null {
  for (const [index, row] of rows.entries()) {
    if (offset >= row.y && offset < row.y + row.height) return index;
  }
  return null;
}

/**
 * Where the bar sits for a row. `inset` shrinks it vertically so the bar never
 * covers the hairline separators the lists draw between rows.
 */
export function glowFrame(row: RowFrame, inset = 0): GlowFrame {
  const clamped = Math.min(inset, Math.max(0, row.height - 1) / 2);
  return { top: row.y + clamped, height: Math.max(1, row.height - clamped * 2) };
}

export type GlowStep =
  | { action: 'hide' }
  | { action: 'stay' }
  // The bar appears from nothing: it lands on the row without sliding, so a
  // first touch does not shoot it across the screen.
  | { action: 'land'; frame: GlowFrame }
  // The bar is already on screen and moves inside the list.
  | { action: 'glide'; frame: GlowFrame };

/**
 * One decision per touch sample. `parked` is the frame the bar currently sits
 * on (null while hidden). Comparing frames rather than row indexes keeps the
 * bar honest when rows re-register mid-touch after a resize: a row that grew
 * or shifted under a stationary finger is a new frame and the bar follows it,
 * while a touch that stays on an unmoved row does nothing.
 */
export function resolveGlow(rows: readonly RowFrame[], offset: number, parked: GlowFrame | null, inset = 0): GlowStep {
  const sorted = sortRows(rows);
  const index = rowIndexAtOffset(sorted, offset);
  const row = index === null ? undefined : sorted[index];
  if (!row) return { action: 'hide' };
  const frame = glowFrame(row, inset);
  if (!parked) return { action: 'land', frame };
  if (Math.abs(parked.top - frame.top) < 0.01 && Math.abs(parked.height - frame.height) < 0.01) return { action: 'stay' };
  return { action: 'glide', frame };
}

/**
 * Guards the asynchronous origin measurement that starts every touch. A quick
 * tap can lift before the measurement returns; without the gate the late
 * callback would park the bar on a row after the finger has already left, and
 * nothing would ever hide it. Every begin() invalidates earlier tokens.
 */
export function createTouchGate() {
  let generation = 0;
  let open = false;
  return {
    begin(): number {
      open = true;
      generation += 1;
      return generation;
    },
    end(): void {
      open = false;
      generation += 1;
    },
    isLive(token: number): boolean {
      return open && token === generation;
    },
    get touching(): boolean {
      return open;
    },
  };
}
