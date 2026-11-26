export type SettingValue = boolean | number | string | string[] | null;

export type OrganizationSwitchConfiguration = {
  switches?: Record<string, SettingValue> | null;
  settings?: Array<{ key: string; value: SettingValue }> | null;
} | null | undefined;

export function isFeatureEnabled(configuration: OrganizationSwitchConfiguration, key: string, fallback?: boolean): boolean;
export function featureLimit<T = number>(configuration: OrganizationSwitchConfiguration, key: string, fallback: T): number | T;
export function featureText(configuration: OrganizationSwitchConfiguration, key: string, fallback?: string): string;
export function featureTextList(configuration: OrganizationSwitchConfiguration, key: string, fallback?: string[]): string[];
