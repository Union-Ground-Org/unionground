import * as SecureStore from 'expo-secure-store';
import { createPulseOpeningStore } from '../../../../src/lib/pulseOpeningPreference';

export type PulseOpening = 'week' | 'charts';
export type PulseOpeningPreference = { opening: PulseOpening; setupComplete: boolean };
const store = createPulseOpeningStore({ getItem: SecureStore.getItemAsync, setItem: SecureStore.setItemAsync });

export async function loadPulseOpening(userID: string): Promise<PulseOpeningPreference> {
  return await store.load(userID) as PulseOpeningPreference;
}
export async function savePulseOpening(userID: string, opening: PulseOpening): Promise<PulseOpeningPreference> {
  return await store.save(userID, opening) as PulseOpeningPreference;
}
