// The phone app's brand, written into the bundle at build time by
// plugins/babel-brand-name.js. Pure helpers only, so tests need no Expo
// runtime; src/lib/brand.ts binds them to the build. The rules are
// src/lib/shared-core/brand.js's.
import {
  ATTRIBUTION_NOTICE,
  DEFAULT_SOURCE_CODE_URL,
  DEVELOPMENT_BRAND_NAME,
  OFFICIAL_SERVICE_LABEL,
  brandInitial,
  isOfficialBackend,
} from '../../../../src/lib/shared-core/brand.js';

export { ATTRIBUTION_NOTICE, OFFICIAL_SERVICE_LABEL };

export type PhoneBrandInfo = Readonly<{
  name: string;
  official: boolean;
  initial: string;
  sourceCodeUrl: string;
  officialHosts: readonly string[];
  officialSupabaseOrigins: readonly string[];
  // The official mark (a PNG data URL of branding/official/mark-tile-180.png),
  // present only in an official build.
  officialMarkUri: string | null;
}>;

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as readonly unknown[]).filter((item) => typeof item === 'string') : []);

export function parsePhoneBrand(raw: unknown): PhoneBrandInfo {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : DEVELOPMENT_BRAND_NAME;
  const official = input.official === true;
  const sourceCodeUrl = typeof input.sourceCodeUrl === 'string' && /^https:\/\//.test(input.sourceCodeUrl)
    ? input.sourceCodeUrl
    : DEFAULT_SOURCE_CODE_URL;
  return Object.freeze({
    name,
    official,
    initial: brandInitial(name),
    sourceCodeUrl,
    officialHosts: Object.freeze(strings(input.officialHosts)),
    officialSupabaseOrigins: Object.freeze(strings(input.officialSupabaseOrigins)),
    officialMarkUri: official && typeof input.officialMarkUri === 'string' && input.officialMarkUri.startsWith('data:image/png;base64,')
      ? input.officialMarkUri
      : null,
  });
}

// An official build accepts only a backend on the official list; an
// unbranded build accepts the operator's own (source-approved) backend.
export function backendAllowedForBrand(brand: Pick<PhoneBrandInfo, 'official' | 'officialSupabaseOrigins'>, supabaseUrl: string | null): boolean {
  if (!supabaseUrl) return true;
  return !brand.official || brand.officialSupabaseOrigins.includes(supabaseUrl);
}

// "Official Union Ground service" shows only in an official build whose
// backend and portal are the official service's.
export function showsOfficialServiceMark(
  brand: PhoneBrandInfo,
  config: { supabaseUrl: string | null; portalBaseUrl: string; backendConfigured: boolean },
): boolean {
  return brand.official && config.backendConfigured && isOfficialBackend({
    supabaseUrl: config.supabaseUrl,
    portalBaseUrl: config.portalBaseUrl,
    officialHosts: brand.officialHosts,
    officialSupabaseOrigins: brand.officialSupabaseOrigins,
  });
}

// The public "Who runs this server" page of the app's portal, or null when
// the app has no real server (the unprovisioned .invalid placeholder).
export function operatorPageUrl(portalBaseUrl: string): string | null {
  try {
    const url = new URL('/operator', portalBaseUrl);
    return url.protocol === 'https:' && !url.hostname.endsWith('.invalid') ? url.toString() : null;
  } catch { // swallow-ok: an unparseable portal address has no operator page
    return null;
  }
}
