import { Platform } from 'react-native';

import { resolveTypography } from './tokens';

// The typography roles as this phone draws them
// (UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115): a screen
// style spreads one role, `{ ...typeface.control, fontSize: 15 }`, and never
// names a font itself. Android before API 28 gets its single-face families.

function platform(): { os: string; version: number | string } {
  // The app always has Platform. Many unit tests stand in a react-native
  // module without it; they draw as iOS.
  try {
    return { os: Platform.OS, version: Platform.Version };
  } catch {
    return { os: 'ios', version: 0 };
  }
}

const { os, version } = platform();

export const typeface = resolveTypography(os, version);

/** True on Android before API 28, where a family yields only its normal and bold faces. */
export const usesSingleFaceFamilies = os === 'android' && Number(version) < 28;
