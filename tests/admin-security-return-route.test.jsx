import { capturedAppClientFixture, capturedAppAccountFixture } from "./helpers/capturedAppClientFixture.js";
import { SAMPLE_HOST } from "./helpers/fictional-provider.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.jsx';
import { fallbackData } from './fixtures/retired-pre-bot/src/data/fallback.js';
import { applyDeviceParityState, clearDeviceParityState, deviceParityValue } from '../src/lib/deviceParity.js';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';
import { SetupTwoStepNotice, TwoStepSettingsLink } from '../src/features/orgSetup/SetupTwoStepNotice.jsx';
import { unionBuildContext } from '../src/features/orgSetup/UnionBuildPlacement.jsx';
import { createdOrganizationNextHref } from '../src/lib/openSignup.js';

const setupReview = '/m/admin/setup-review?union=olms-900000077&build=chapter';

const backend = vi.hoisted(() => {
  const state = { data: null, session: null };
  const verified = [{ id: 'local-totp', factor_type: 'totp', status: 'verified' }];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      getUser: async () => ({ data: { user: state.session?.user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
        listFactors: async () => ({ data: { all: verified, totp: verified }, error: null }),
      },
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from: () => { let query; query = new Proxy({}, { get: (_target, key) => key === 'then'
      ? (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject) : () => query }); return query; },
    channel: () => { const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock('../src/lib/supabase.js', async (original) => ({
  ...await original(), hasAppBackend: true, appAuthStorageUnavailable: false,
  get appBackendKind() { return window.location.hostname === SAMPLE_HOST ? 'sample' : 'live'; },
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client), appSupabase: backend.client,
  createCapturedAppAccountClient: async () => capturedAppAccountFixture(backend.client),
}));
vi.mock('../src/lib/memberSessionLoader.js', async (original) => ({
  ...await original(),
  createMemberSessionLoader: (_client, user) => ({
    userId: user.id, loadShell: async () => backend.state.data, loadRoute: async () => backend.state.data,
    invalidateResources() {}, resourcesForRoute: () => [], failuresForResources: () => [],
    subscribe: () => () => {}, inspect: () => ({ status: 'loaded' }),
    stateForRoute: () => ({ status: 'loaded', error: '' }), retryFailedResources() {}, dispose() {},
  }),
}));
// Keep the actual App, SettingsView, MfaSettings, workspace navigation and
// role guards. Only unrelated destination content and network I/O are inert.
vi.mock('../src/views/AdminView.jsx', () => ({ AdminView: () => <h1>Entered Admin desk</h1> }));
vi.mock('../src/views/StewardView.jsx', () => ({ StewardView: () => <h1>Entered Steward desk</h1> }));
vi.mock('../src/views/TodayView.jsx', () => ({ TodayView: () => <h1>Entered Member Home</h1> }));

beforeEach(() => {
  vi.stubEnv('MODE', 'local-auth-navigation-proof');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No hosted requests in local proof')));
  window.scrollTo = vi.fn(); localStorage.clear(); sessionStorage.clear(); clearDeviceParityState();
  const payload = Buffer.from(JSON.stringify({ sub: 'local-admin', aal: 'aal2', session_id: '11111111-2222-4333-8444-555555555555' })).toString('base64url');
  backend.state.session = { user: { id: 'local-admin', email: 'non-persona-admin@example.invalid', factors: [{ factor_type: 'totp', status: 'verified' }] }, access_token: `e30.${payload}.local`, refresh_token: 'local-only' };
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearDeviceParityState(); });

// This edition's two-step settings card (src/components/MfaSettings.jsx) is
// public main's and offers no "Continue to Admin setup" link, so every case
// here stays on the security page; upstream's cases that follow that link
// are not carried.
describe('Admin security return follows the shell hat contract', () => {
  it.each([
    { label: 'SAMPLE non-legacy Admin wearing Member', host: SAMPLE_HOST, hat: 'member', roles: ['admin'], destination: '/m/settings/security', link: false },
    { label: 'SaaS Admin wearing Member control', host: 'unionground.net', hat: 'member', roles: ['admin'], destination: '/m/admin', link: true },
    { label: 'SaaS Admin wearing Steward control', host: 'unionground.net', hat: 'steward', roles: ['admin', 'steward'], destination: '/m/settings/security', link: false },
    { label: 'setup-review return cannot switch a worn Steward hat', host: 'unionground.net', hat: 'steward', roles: ['admin', 'steward'], returnTarget: setupReview, destination: '/m/settings/security', link: false },
    { label: 'setup-review return cannot restore a lost Admin role', host: 'unionground.net', hat: 'member', roles: ['steward'], returnTarget: setupReview, destination: '/m/settings/security', link: false },
    { label: 'SAMPLE Member cannot follow a stored Admin return', host: SAMPLE_HOST, hat: 'member', roles: ['admin'], returnTarget: setupReview, destination: '/m/settings/security', link: false },
    { label: 'cross-origin query return is refused', host: 'unionground.net', hat: 'member', roles: ['admin'], securityReturn: 'https://other.example/m/admin/setup-review', destination: '/m/admin', link: true },
    // REQ-UG-SIGNUP-UNION-CATALOG-PICKER-20261109: a chapter picked when
    // creating the organization keeps its local through required two-step.
    { label: 'a chapter picked at organization creation reaches its build-a-chapter draft after MFA', host: 'unionground.net', hat: 'member', roles: ['admin'], createdPlacement: { unionKey: 'olms-900000077', scope: 'chapter' }, destination: '/m/admin/setup-review', link: true },
  ])('$label', async ({ host, hat, roles, destination, link: offered, returnTarget, homeNotice, securityReturn, createdPlacement }) => {
    expect(globalThis.jsdom, 'The real JSDOM URL must be configurable').toBeTruthy();
    globalThis.jsdom.reconfigure({ url: `https://${host}/m/settings/security` });
    if (returnTarget || homeNotice) {
      globalThis.jsdom.reconfigure({ url: `https://${host}${returnTarget || '/m'}` });
      const start = render(<LanguageProvider lang="en">{homeNotice
        ? <SetupTwoStepNotice staffMfa={{ blocked: true, holdsStaffRole: true }} />
        : <TwoStepSettingsLink plain returnTo={returnTarget}>Open Settings</TwoStepSettingsLink>}</LanguageProvider>);
      // This is a plain, draft-protected browser navigation. Remount the real
      // App at the actual shipped link's href after MFA standing is restored.
      const href = screen.getByRole('link', { name: 'Open Settings' }).href;
      start.unmount();
      globalThis.jsdom.reconfigure({ url: href });
    }
    if (securityReturn) globalThis.jsdom.reconfigure({ url: `https://${host}/m/settings/security?${new URLSearchParams({ setupReturnTo: securityReturn })}` });
    if (createdPlacement) globalThis.jsdom.reconfigure({ url: `https://${host}${createdOrganizationNextHref(createdPlacement)}` });
    if (host === SAMPLE_HOST) {
      // The SAMPLE host adopts only a restored session whose token names the
      // same email on an accepted account (#5285, #7277). A fictional SAMPLE
      // organization admin is used: the shared demo personas never see the
      // security card (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107).
      const email = 'kayla.doyle@loadtest.demo.example.com';
      const claims = Buffer.from(JSON.stringify({ sub: 'local-admin', email, aal: 'aal2', session_id: '11111111-2222-4333-8444-555555555555' })).toString('base64url');
      backend.state.session = { ...backend.state.session, access_token: `e30.${claims}.local`, user: { ...backend.state.session.user, email } };
    }
    applyDeviceParityState('app.selectedStaffHat', hat);
    backend.state.data = { ...structuredClone(fallbackData), roles, rolesUnknown: false,
      member: { ...fallbackData.member, id: 'local-admin', organizationId: 'local-org', organizationRoles: roles, chapterRoles: roles, language: 'en', membershipStatus: 'active' },
      staffMfa: { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] },
    };
    render(<App />);
    await screen.findByText(/Your organization requires two-step sign-in while you use a staff role/, {}, { timeout: 10000 });
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    // Session restoration deliberately resets to Member. Apply the control's
    // worn hat through the same live device-parity store consumed by App.
    // A restored SAMPLE persona wears its own hat, so that case re-applies Member too.
    if (hat !== 'member' || host === SAMPLE_HOST) await act(async () => applyDeviceParityState('app.selectedStaffHat', hat));
    expect(deviceParityValue('app.selectedStaffHat')).toBe(hat);
    const link = screen.queryByRole('link', { name: 'Continue to Admin setup' });
    const observedOffered = Boolean(link);
    if (link) await act(async () => fireEvent.click(link));
    await waitFor(() => expect(window.location.pathname).toBe(destination), { timeout: 10000 });
    if (destination === '/m') await screen.findByRole('heading', { name: 'Entered Member Home' });
    if (destination.startsWith('/m/admin')) await screen.findByRole('heading', { name: 'Entered Admin desk' });
    if (destination === '/m/admin/setup-review') expect(unionBuildContext(window.location.search)).toEqual({ key: 'olms-900000077' });
    if (destination === '/m/admin/catalog-verification') expect(window.location.search).toBe('?claim=olms-900000077&scope=local-wide');
    if (destination === '/m/admin') expect(window.location.search).toBe('');
    expect(observedOffered).toBe(offered);
  }, 20000);
});
