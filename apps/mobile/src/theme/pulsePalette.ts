import type { ThemeTokens } from './tokens';
import { chartPalette } from './chartPalette';

// The owner's October 31 Pulse series and five health bands. Text remains in
// semantic ink; these colors identify chart marks and the labelled tier dots.
export function pulsePalette(theme: ThemeTokens) {
  return theme.appearance === 'dark'
    ? { series: chartPalette(theme), tiers: ['#F08A7C', '#F4A261', '#F4B942', '#8CCB6E', '#4CC9B0'] }
    : { series: chartPalette(theme), tiers: ['#B3261E', '#C25A0C', '#8A6A00', '#4B8A3A', '#137C54'] };
}
