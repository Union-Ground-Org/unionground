import { NativeModule, requireOptionalNativeModule } from 'expo';

type NativeQuickActionEvents = {
  onQuickAction(): void;
};

declare class NativeQuickActionsModule extends NativeModule<NativeQuickActionEvents> {
  consumePendingAsync(): Promise<string | null>;
}

export default requireOptionalNativeModule<NativeQuickActionsModule>('NativeQuickActions');
