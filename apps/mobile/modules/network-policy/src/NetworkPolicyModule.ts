import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { NativeNetworkSignals } from './NetworkPolicy.types';

type NetworkPolicyEvents = {
  onNetworkChange(signals: NativeNetworkSignals): void;
};

declare class NetworkPolicyModule extends NativeModule<NetworkPolicyEvents> {
  isSupported(): boolean;
  getSignalsAsync(): Promise<NativeNetworkSignals>;
}

// Optional on purpose. Web, Expo Go, and any build without the native module
// resolve to null, and the service reports an explicit unknown reading.
export default requireOptionalNativeModule<NetworkPolicyModule>('NetworkPolicy');
