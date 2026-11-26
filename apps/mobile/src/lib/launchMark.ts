// The launch (splash) mark and
// the in-app boot mark that replaces it must be the same size, or the hand-off
// from the launch screen to the boot screen jumps. Android draws the splash
// mark at 144 dp so its corners fit the system's circular splash mask
// (app.config.ts, expo-splash-screen `android.imageWidth`); iOS has no mask
// and draws it at 180 pt (`imageWidth`). appConfig.test.ts pins these numbers
// to the plugin configuration.
export const LAUNCH_MARK_SIZE = Object.freeze({ ios: 180, android: 144 });

export function launchMarkSize(os: string): number {
  return os === 'android' ? LAUNCH_MARK_SIZE.android : LAUNCH_MARK_SIZE.ios;
}
