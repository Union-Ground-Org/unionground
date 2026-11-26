import Constants from 'expo-constants';

import { parseMobileConfig } from './configPolicy';
import { resolveRuntimeMobileConfig } from './storeDemo';
import { readStoreDemoMarker } from './storeDemoDevice';

// The build's own pin: Union Ground on the unionground-production store build.
const buildMobileConfig = parseMobileConfig(
  (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>,
);

// What this run of the app uses. On the store build in the demo (lib/storeDemo)
// it is the SAMPLE configuration; it is decided once, here, before any client
// or API base is read, and changes only across a restart.
export const mobileConfig = resolveRuntimeMobileConfig(buildMobileConfig, readStoreDemoMarker);
