import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const preferenceKey = 'org.unionground.app.biometric-lock';

export async function biometricsAvailable(): Promise<boolean> {
  const [hardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hardware && enrolled;
}

export async function authenticateForUnlock(): Promise<boolean> {
  if (!(await biometricsAvailable())) return false;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock Union Ground',
    cancelLabel: 'Use sign in instead',
    disableDeviceFallback: false,
  });
  return result.success;
}

export async function readBiometricLockPreference(): Promise<boolean> {
  return (await SecureStore.getItemAsync(preferenceKey)) === 'enabled';
}

export async function saveBiometricLockPreference(enabled: boolean): Promise<void> {
  if (enabled) await SecureStore.setItemAsync(preferenceKey, 'enabled');
  else await SecureStore.deleteItemAsync(preferenceKey);
}
