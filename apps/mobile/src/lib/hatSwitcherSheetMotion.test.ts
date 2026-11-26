import { describe, expect, it, vi } from 'vitest';

import {
  HAT_MENU_CLOSE_MS,
  HAT_MENU_OPEN_MS,
  HAT_MENU_TRAVEL,
  closeHatSwitcherMenu,
  openHatSwitcherMenu,
} from './hatSwitcherSheetMotion';

function menuDriver(initial = 0) {
  const menu = { value: initial, setValue(next: number) { this.value = next; } };
  return menu;
}

describe('hat switcher menu motion', () => {
  it('snaps open and never times while Reduce Motion is on or still unknown', () => {
    const menu = menuDriver(0);
    const timeOpen = vi.fn();
    openHatSwitcherMenu(menu, true, timeOpen);
    expect(menu.value).toBe(1);
    expect(timeOpen).not.toHaveBeenCalled();
  });

  it('snaps closed and dismisses without timing while Reduce Motion is on', () => {
    const menu = menuDriver(1);
    const timeClose = vi.fn();
    const dismiss = vi.fn();
    closeHatSwitcherMenu(menu, true, timeClose, dismiss);
    expect(menu.value).toBe(0);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(timeClose).not.toHaveBeenCalled();
  });

  it('uses the timed paths only after Reduce Motion is known off', () => {
    const menu = menuDriver(0);
    const start = vi.fn();
    openHatSwitcherMenu(menu, false, () => ({ start }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(menu.value).toBe(0);

    const closeStart = vi.fn((onEnd?: (result: { finished: boolean }) => void) => {
      onEnd?.({ finished: true });
    });
    const dismiss = vi.fn();
    closeHatSwitcherMenu(menu, false, () => ({ start: closeStart }), dismiss);
    expect(closeStart).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss a menu whose close fade was interrupted by a reopen', () => {
    const menu = menuDriver(1);
    const dismiss = vi.fn();
    closeHatSwitcherMenu(
      menu,
      false,
      () => ({ start: (onEnd) => { onEnd?.({ finished: false }); } }),
      dismiss,
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('restarts a reopened menu from closed so the fade is always seen', () => {
    const menu = menuDriver(0.6);
    openHatSwitcherMenu(menu, false, () => ({ start: vi.fn() }));
    expect(menu.value).toBe(0);
  });

  it('keeps the dropdown short: it closes faster than it opens and travels a few points', () => {
    expect(HAT_MENU_CLOSE_MS).toBeLessThan(HAT_MENU_OPEN_MS);
    expect(HAT_MENU_OPEN_MS).toBeLessThanOrEqual(300);
    expect(HAT_MENU_TRAVEL).toBeLessThan(0);
    expect(Math.abs(HAT_MENU_TRAVEL)).toBeLessThanOrEqual(16);
  });
});
