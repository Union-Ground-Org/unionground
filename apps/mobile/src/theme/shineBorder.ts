// Decorative shine palette for the hat pill's travelling ring: the reference
// "shine border" demo's purple, pink and peach. These are brand artwork, not a
// theme surface, and they never carry text. On the light themes they sit at
// roughly 1.4:1 to 3:1 against the canvas, so they are never the only boundary:
// the hat pill draws a `theme.border` keyline inside the ring (border against
// background is 3.5:1 or better on every theme) and carries the control's
// identity in ink, label and chevron.
export const SHINE_BORDER_COLORS: readonly string[] = ['#A07CFE', '#FE8FB5', '#FFBE7B'];
export const SHINE_BORDER_WIDTH = 1.5;
// One slow pass: 3-4 s, no pulsing or scaling.
export const SHINE_BORDER_DURATION_MS = 4000;

// The gradient rect is three control widths wide and slides left by exactly one
// width per loop. Its palette therefore repeats once per width (three periods
// plus the closing stop), so the frame after one width is identical to the
// first and the loop has no seam whatever the palette length. A single colour
// yields a flat ring.
export const SHINE_GRADIENT_PERIODS = 3;

export function shineGradientStops(colors: readonly string[]): string[] {
  const palette = colors.length > 0 ? colors : SHINE_BORDER_COLORS;
  const stops: string[] = [];
  for (let period = 0; period < SHINE_GRADIENT_PERIODS; period += 1) stops.push(...palette);
  stops.push(palette[0]!);
  return stops;
}
