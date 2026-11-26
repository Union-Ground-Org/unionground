export const UNION_GROUND_NAME: string;
export const DEVELOPMENT_BRAND_NAME: string;
export const BRAND_LITERAL_DIRECTIVE: string;
export const ATTRIBUTION_NOTICE: string;
export const UPSTREAM_URL: string;
export const DEFAULT_SOURCE_CODE_URL: string;
export const OFFICIAL_SERVICE_LABEL: { en: string; es: string };

export type ResolvedBrand = Readonly<{ name: string; official: boolean; initial: string; warning?: string }>;

export class BrandConfigurationError extends Error {}

export function brandKey(name: unknown): string;
export function isReservedBrandName(name: unknown): boolean;
export function normalizeBrandName(value: unknown): string;
export function parseBrandFlag(value: unknown, variable: string): boolean;
export function brandInitial(name: unknown): string;
export function resolveBrand(options?: {
  brandName?: unknown;
  officialBranding?: unknown;
  officialAssetsPresent?: boolean;
  production?: boolean;
  nameVariable?: string;
  officialVariable?: string;
}): ResolvedBrand;
export function resolveSourceCodeUrl(value: unknown, variable?: string): string;
export function applyBrandName<T>(text: T, name: string): T;
export function withoutProtectedNames(text: unknown): string;
export function isOfficialHost(hostname: unknown, officialHosts: readonly string[]): boolean;
export function showsOfficialServiceMark(options: { official: boolean; hostname: unknown; officialHosts: readonly string[] }): boolean;
export function isOfficialBackend(options: {
  supabaseUrl: unknown;
  portalBaseUrl: unknown;
  officialHosts: readonly string[];
  officialSupabaseOrigins: readonly string[];
}): boolean;
