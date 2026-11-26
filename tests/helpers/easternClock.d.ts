export interface EasternEvening { at: string; easternDay: string; utcDay: string; zone: 'EST' | 'EDT' }
export interface EasternChangeover { before: string; after: string; day: string; hours: number }
export const EASTERN_INSTANTS: {
  evening: EasternEvening;
  daylightEvening: EasternEvening;
  lastMinute: EasternEvening;
  springForward: EasternChangeover;
  fallBack: EasternChangeover;
};
export const EASTERN_DAY_CASES: ReadonlyArray<readonly [string, string]>;
export interface ClockControl { useFakeTimers(options?: { toFake?: string[] }): unknown; setSystemTime(time: Date): unknown; useRealTimers(): unknown }
export function atEasternInstant<T>(vi: ClockControl, at: string, run: () => T | Promise<T>): Promise<T>;
export function inDeviceZone<T>(zone: string, run: () => T | Promise<T>): Promise<T>;
