import { mobileConfig } from './config';
import { trustedPortalForBackend, type MobileConfig } from './configPolicy';

// Native posts an access token only to the portal paired with the configured,
// source-approved backend (configPolicy). The Expo manifest is intentionally
// not a general API-origin knob. With no Union Ground backend provisioned,
// there is no trusted portal and every call refuses before any request.
export function resolvePortalApiOrigin(
  config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'> = mobileConfig,
): string {
  const trusted = config.backendConfigured ? trustedPortalForBackend(config.supabaseUrl) : null;
  let url: URL;
  try { url = new URL(config.portalBaseUrl); } catch { throw new Error('Portal origin is invalid.'); }
  if (!trusted || url.origin !== trusted || url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Portal origin is not trusted.');
  }
  return trusted;
}

// MFA recovery redeems a code at the same paired portal.
export const resolveMfaRecoveryApiOrigin = resolvePortalApiOrigin;
