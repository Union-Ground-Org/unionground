import { minimumTouchTarget } from '../theme/tokens';

// The quiet chips under a message (reactions, the add-reaction chip and the
// reply count) share one system: a 36 pt pill whose words, icons, gaps and
// sides grow with the text up to 2x, inside a full-height target.
export const CHIP_TEXT_CAP = 2;
export function chipHeight(textScale: number): number {
  return Math.round(36 * textScale);
}
// The target is the 48 pt minimum, or the grown chip plus 4 pt either side, so
// wrapped lines of large chips never touch.
export function chipTargetHeight(textScale: number): number {
  return Math.max(minimumTouchTarget, chipHeight(textScale) + 8);
}
