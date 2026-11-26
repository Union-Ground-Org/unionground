import * as SecureStore from 'expo-secure-store';

export type HapticPreference = 'system' | 'subtle' | 'off';
const preferenceKey = 'org.unionground.app.haptics-v1';
type PreferenceState = {
  preference: HapticPreference;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
};
let state: PreferenceState = { preference: 'system', ready: false, loading: true, saving: false, error: null };
let initialization: Promise<void> | undefined;
let revision = 0;
const listeners = new Set<() => void>();

export function getHapticPreferenceState(): PreferenceState { return state; }
export function subscribeHapticPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: PreferenceState) {
  state = next;
  listeners.forEach((listener) => {
    try { listener(); } catch { /* Subscribers cannot change persistence outcomes. */ }
  });
}

/** Silent hydration. Feedback is dropped until the saved choice is known. */
export function initializeHapticPreference(): Promise<void> {
  if (state.ready) return Promise.resolve();
  if (initialization) return initialization;
  const version = revision;
  initialization = (async () => {
    try {
      const stored = await SecureStore.getItemAsync(preferenceKey);
      if (version !== revision) return;
      const preference = stored === 'subtle' || stored === 'off' ? stored : 'system';
      publish({ preference, ready: true, loading: false, saving: false, error: null });
    } catch {
      if (version === revision) publish({ ...state, loading: false, error: 'load' });
    }
  })();
  return initialization;
}

/** Apply immediately, serialize writes, and never turn feedback back on after a failed Off save. */
export async function saveHapticPreference(preference: HapticPreference): Promise<void> {
  if (!['system', 'subtle', 'off'].includes(preference)) throw new Error('Invalid haptic preference');
  if (state.saving) throw new Error('Haptic preference save in progress');
  revision += 1;
  publish({ preference, ready: true, loading: false, saving: true, error: null });
  try {
    await SecureStore.setItemAsync(preferenceKey, preference);
    publish({ ...state, saving: false });
  } catch {
    publish({ ...state, saving: false, error: 'save' });
    throw new Error('Haptic preference could not be saved');
  }
}
