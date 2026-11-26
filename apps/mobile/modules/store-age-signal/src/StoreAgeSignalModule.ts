import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class StoreAgeSignalModule extends NativeModule {
  requestAgeSignalAsync(): Promise<unknown>;
}

// Optional on purpose. Web, Expo Go, and any build without the native module
// resolve to null, and the reader reports an explicit unavailable signal.
export default requireOptionalNativeModule<StoreAgeSignalModule>('StoreAgeSignal');
