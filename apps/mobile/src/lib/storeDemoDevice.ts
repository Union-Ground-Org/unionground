import { STORE_DEMO_AUTH_STORAGE_KEY, STORE_DEMO_MARKER_KEY, serializeStoreDemoMarker, type StoreDemoDevice } from './storeDemo';

type SecureStoreModule = typeof import('expo-secure-store');

// Loaded lazily so a build that never reads the marker (every SAMPLE build)
// and the test graph never load the native module for it.
function secureStore(): SecureStoreModule {
  return require('expo-secure-store') as SecureStoreModule;
}

// Readable after the first unlock, so a launch from a notification while the
// phone is locked still finds the device in the demo it was left in.
function markerOptions(store: SecureStoreModule) {
  return { keychainAccessible: store.AFTER_FIRST_UNLOCK };
}

// Read once, synchronously, before the first client is made (lib/config).
export function readStoreDemoMarker(): string | null {
  const store = secureStore();
  return store.getItem(STORE_DEMO_MARKER_KEY, markerOptions(store));
}

export const storeDemoDevice: StoreDemoDevice = {
  fetch: (input, init) => fetch(input, init),
  async writeMarker(value) {
    const store = secureStore();
    await store.setItemAsync(STORE_DEMO_MARKER_KEY, value, markerOptions(store));
  },
  async deleteMarker() {
    const store = secureStore();
    await store.deleteItemAsync(STORE_DEMO_MARKER_KEY, markerOptions(store));
  },
  async clearDemoSession() {
    // The demo client's own keys (supabase-js stores the session, its PKCE
    // verifier and user under the storage key) and the backend-scoped
    // storage's origin marker. Local only: no SAMPLE call.
    const { secureSessionStorage } = await import('./secureSessionStorage');
    const keys = [STORE_DEMO_AUTH_STORAGE_KEY, `${STORE_DEMO_AUTH_STORAGE_KEY}-code-verifier`, `${STORE_DEMO_AUTH_STORAGE_KEY}-user`];
    await Promise.all([...keys, ...keys.map((key) => `${key}.backend-origin`)].map((key) => secureSessionStorage.removeItem(key)));
  },
  async restart() {
    const { reloadAppAsync } = require('expo') as typeof import('expo');
    await reloadAppAsync('Union Ground demo');
  },
};

// The pending entry is taken once: the marker turns 'open' before the
// session is requested, so a failed or interrupted entry never repeats on
// every launch; the sign-in screen then offers the button again.
export async function markStoreDemoEntered(supabasePublishableKey: string): Promise<void> {
  await storeDemoDevice.writeMarker(serializeStoreDemoMarker(supabasePublishableKey, 'open'));
}
