import { phoneBrand } from './brand';
import { backendAllowedForBrand, type PhoneBrandInfo } from './brandPolicy';
import { TRUSTED_BACKEND_PORTALS } from './trustedBackends';

export type RawMobileConfig = {
  supabaseUrl?: unknown;
  supabasePublishableKey?: unknown;
  portalBaseUrl?: unknown;
  compassNetworkEnabled?: unknown;
  previewEnabled?: unknown;
};

export type MobileConfig = {
  supabaseUrl: string | null;
  supabasePublishableKey: string;
  portalBaseUrl: string;
  compassNetworkEnabled: boolean;
  previewEnabled: boolean;
  backendConfigured: boolean;
  // Set only on the unionground-production store build while it is in the
  // demo (lib/storeDemo); absent everywhere else.
  storeDemo?: { entry: 'pending' | 'open' };
};


// The placeholder portal for an unprovisioned build. `.invalid` never resolves.
export const UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN = 'https://unionground.invalid';

// Upstream's store-review demo and staff two-step link name a SAMPLE project
// and the official portal. This edition has neither: the SAMPLE origin stays
// empty (the store demo is never offered) and the portal is the unprovisioned
// placeholder, and an approved backend is whatever trustedBackends lists.
export const SAMPLE_SUPABASE_ORIGIN = '';
export const UNION_GROUND_PORTAL_ORIGIN = UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN;

export function trustedPortalForBackend(supabaseUrl: unknown): string | null {
  return (typeof supabaseUrl === 'string' && Object.hasOwn(TRUSTED_BACKEND_PORTALS, supabaseUrl)
    && TRUSTED_BACKEND_PORTALS[supabaseUrl]) || null;
}

// True only for a configured backend whose portal is its source-approved pair.
export const isUnionGroundBackend = (config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'>): boolean => isApprovedBackend(config);

export function isApprovedBackend(config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'>): boolean {
  return config.backendConfigured && trustedPortalForBackend(config.supabaseUrl) === config.portalBaseUrl;
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const originOnly = url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
    return url.protocol === 'https:' && originOnly ? url.origin : null;
  } catch {
    return null;
  }
}

export function parseMobileConfig(raw: RawMobileConfig, brand: PhoneBrandInfo = phoneBrand): MobileConfig {
  const candidate = validHttpsUrl(raw.supabaseUrl);
  // Official Union Ground builds talk only to the official service
  // (config/official-domains.json); an unbranded build talks to the
  // operator's own source-approved backend.
  const supabaseUrl = candidate && trustedPortalForBackend(candidate)
    && backendAllowedForBrand(brand, candidate) ? candidate : null;
  const key = typeof raw.supabasePublishableKey === 'string'
    ? raw.supabasePublishableKey.trim()
    : '';
  // This origin receives a live member access token. It is intentionally not
  // runtime-configurable from the public Expo manifest.
  const portalBaseUrl = trustedPortalForBackend(supabaseUrl) ?? UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN;
  const portalMatches = raw.portalBaseUrl === undefined || raw.portalBaseUrl === portalBaseUrl;
  const looksPlaceholder = !key
    || /replace|your[_-]?project/i.test(key)
    || Boolean(supabaseUrl && /your[_-]?project/i.test(supabaseUrl));
  // The mobile contract requires Supabase's publishable-key format. Rejecting
  // every legacy JWT-shaped or secret-key value is safer than trying to decode
  // and classify credentials inside a public bundle.
  const isPublishableCredential = /^sb_publishable_[A-Za-z0-9._-]+$/.test(key);

  return {
    supabaseUrl,
    supabasePublishableKey: key,
    portalBaseUrl,
    compassNetworkEnabled: raw.compassNetworkEnabled === true && Boolean(supabaseUrl) && portalMatches && !looksPlaceholder && isPublishableCredential,
    previewEnabled: raw.previewEnabled === true,
    backendConfigured: Boolean(supabaseUrl) && portalMatches && !looksPlaceholder && isPublishableCredential,
  };
}
