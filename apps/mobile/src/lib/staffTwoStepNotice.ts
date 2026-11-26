import { mobileConfig } from './config';
import { isApprovedBackend, UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN, type MobileConfig } from './configPolicy';

// REQ-UG-NATIVE-AUTHENTICATOR-SETUP-20261018: a staff member whose
// organization requires two-step sign-in for staff, and who has no second
// factor yet, has every staff role paused by the server. Home says why and
// points to the one place two-step can be set up today: the website.
export const STAFF_TWO_STEP_NOTICE_TITLE = 'Your staff tools are paused';

export type StaffTwoStepSettings = {
  url: string;
  host: string;
  body: string;
  action: string;
  openFailed: string;
};

const SECURITY_PATH = '/m/settings/security';

// Staff security settings live on the web host paired with the build's
// approved backend (configPolicy's trusted pairs; the manifest cannot move
// it). A build with no approved backend names the unprovisioned placeholder.
export function staffTwoStepSettings(
  config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'> = mobileConfig,
): StaffTwoStepSettings {
  const origin = isApprovedBackend(config) ? config.portalBaseUrl : UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN;
  const host = new URL(origin).host;
  return {
    url: `${origin}${SECURITY_PATH}`,
    host,
    body: `Your organization requires two-step sign-in for staff, and this account has no second step yet. Set it up on ${host}, then sign in here again to bring your staff tools back.`,
    action: `Set up two-step on ${host}`,
    openFailed: `The page could not be opened. Visit ${host}${SECURITY_PATH} in a browser.`,
  };
}

// The server decides; the app only reads its answer. Anything that is not an
// explicit blocked-and-holds-a-staff-role answer shows nothing.
export function staffTwoStepPaused(standing: unknown): boolean {
  if (!standing || typeof standing !== 'object' || Array.isArray(standing)) return false;
  const row = standing as Record<string, unknown>;
  return row.blocked === true && row.holdsStaffRole === true;
}
