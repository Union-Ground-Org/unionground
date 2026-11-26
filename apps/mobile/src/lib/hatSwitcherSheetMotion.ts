// Shared Hat switcher menu motion. HatSwitcher owns the Animated.Value; this
// helper is the one Reduce Motion branch so a pending or enabled setting can
// never reach Animated.timing. (The file keeps its historical name from when
// the switcher was a bottom sheet; the dropdown that replaced it uses the same
// snap-or-time contract.)

// A dropdown is quicker than the sheet it replaced: it travels a few points
// from its anchor rather than the whole screen height.
export const HAT_MENU_OPEN_MS = 220;
export const HAT_MENU_CLOSE_MS = 160;
// The menu starts this far above its resting place and settles down into it.
export const HAT_MENU_TRAVEL = -8;

export type HatSwitcherMenuValue = {
  setValue: (value: number) => void;
};

export type HatSwitcherMenuTiming = {
  start: (onEnd?: (result: { finished: boolean }) => void) => void;
};

export function openHatSwitcherMenu(
  menu: HatSwitcherMenuValue,
  reduceMotion: boolean,
  timeOpen: () => HatSwitcherMenuTiming,
): void {
  menu.setValue(0);
  if (reduceMotion) {
    menu.setValue(1);
    return;
  }
  timeOpen().start();
}

// A close that is interrupted (the menu was reopened mid-fade) reports
// finished: false and must not dismiss the menu that is open again.
export function closeHatSwitcherMenu(
  menu: HatSwitcherMenuValue,
  reduceMotion: boolean,
  timeClose: () => HatSwitcherMenuTiming,
  dismiss: () => void,
): void {
  if (reduceMotion) {
    menu.setValue(0);
    dismiss();
    return;
  }
  timeClose().start(({ finished }) => {
    if (finished) dismiss();
  });
}
