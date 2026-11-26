import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class NativeCalendarExportModule extends NativeModule {
  isAvailable(): boolean;
  presentEventComposerAsync(
    title: string,
    startMs: number,
    endMs: number,
    location: string | null,
  ): Promise<'saved' | 'canceled' | 'opened'>;
}

export default requireOptionalNativeModule<NativeCalendarExportModule>('NativeCalendarExport');
