import { NativeModule, requireNativeModule } from 'expo';

import type { NativePendingShare } from './SecureShareIntake.types';

declare class SecureShareIntakeModule extends NativeModule<{}> {
  getPendingAsync(): Promise<NativePendingShare | null>;
  captureCleanupTokensAsync(): Promise<string[]>;
  discardAsync(token: string): Promise<boolean>;
}

export default requireNativeModule<SecureShareIntakeModule>('SecureShareIntake');
