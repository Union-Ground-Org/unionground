import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class HomeWidgetsModule extends NativeModule {
  resetAsync(generation: string): Promise<void>;
  publishAsync(generation: string, today: number, unread: number, updatedAt: number, expiresAt: number): Promise<void>;
}

export default requireOptionalNativeModule<HomeWidgetsModule>('HomeWidgets');
