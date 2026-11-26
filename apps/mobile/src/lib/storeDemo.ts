import { isUnionGroundBackend, parseMobileConfig, SAMPLE_SUPABASE_ORIGIN, type MobileConfig } from './configPolicy';

// The store apps' demo (REQ-UG-STORE-APPS-EXPLORE-THE-DEMO-THROUGH-SAMPLE-20261113,
// owner ruling an owner decision): the unionground-production
// build signs members in to Union Ground, and offers "Explore the demo" beside
// Sign in. The demo is the SAMPLE backend, never Production: one tap saves a
// device marker and restarts the app, and the restarted app reads the marker
// before any client exists and takes the exact configuration a SAMPLE-pinned
// build has. So the Supabase client, its session storage key and every API
// base switch together, at one point, and switch back the same way on Exit
// demo. The website rule is unchanged: app.unionground.example never enters demo.

// The device marker. It names no account and holds no session: only the
// SAMPLE project's publishable key, which sample.unionground.example serves to every visitor.
export const STORE_DEMO_MARKER_KEY = 'org.unionground.app.store-demo';
// The demo session's own storage key. The Production session lives under
// org.unionground.app.auth, and the backend-scoped storage removes a
// session stored under its key for another backend, so the demo must never
// share that key: it would erase a member's saved sign-in.
export const STORE_DEMO_AUTH_STORAGE_KEY = 'org.unionground.app.store-demo.auth';
export const PRODUCTION_AUTH_STORAGE_KEY = 'org.unionground.app.auth';
// The SAMPLE host that serves the demo's runtime configuration and its
// demo-session endpoint. Fixed here, never read from a manifest or a response.
export const STORE_DEMO_PORTAL_ORIGIN = 'https://sample.unionground.example';
export const STORE_DEMO_RUNTIME_CONFIG_URL = `${STORE_DEMO_PORTAL_ORIGIN}/api/runtime-config`;

// 'pending': the visitor tapped Explore the demo and the restarted app opens
// the member's demo session once, with no second tap. 'open': entered.
export type StoreDemoEntry = 'pending' | 'open';
export type StoreDemoMarker = { schema: 1; supabasePublishableKey: string; entry: StoreDemoEntry };

const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9._-]+$/;
const MAX_KEY_LENGTH = 256;

function publishableKey(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_KEY_LENGTH && PUBLISHABLE_KEY.test(value) ? value : null;
}

export function parseStoreDemoMarker(raw: string | null): StoreDemoMarker | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const { schema, supabasePublishableKey, entry } = value as Record<string, unknown>;
    const key = publishableKey(supabasePublishableKey);
    if (schema !== 1 || !key || (entry !== 'pending' && entry !== 'open')) return null;
    return { schema: 1, supabasePublishableKey: key, entry };
  } catch {
    return null; // swallow-ok: an unreadable marker means no demo; the app stays on Production
  }
}

export function serializeStoreDemoMarker(key: string, entry: StoreDemoEntry): string {
  const valid = publishableKey(key);
  if (!valid) throw new Error('invalid demo key');
  return JSON.stringify({ schema: 1, supabasePublishableKey: valid, entry } satisfies StoreDemoMarker);
}

// The demo configuration is what parseMobileConfig gives a SAMPLE-pinned
// production-profile build: the SAMPLE project, the sample.unionground.example portal and
// Compass through it. Every Production-only path in the app (email and PIN
// sign-in, Apple and Google, passkeys, invitations, dues, terms receipts)
// already checks isUnionGroundBackend or isLiveSampleBackend against this
// one object, so none of them is offered while it is in force.
export function storeDemoConfig(key: string): MobileConfig {
  return parseMobileConfig({
    supabaseUrl: SAMPLE_SUPABASE_ORIGIN,
    supabasePublishableKey: key,
    portalBaseUrl: STORE_DEMO_PORTAL_ORIGIN,
    compassNetworkEnabled: true,
  });
}

// Only a build pinned to Union Ground reads the marker. A SAMPLE build is the
// demo already, and a build with no backend has nothing to leave. A marker
// that cannot be read or parsed leaves the build's own configuration.
export function resolveRuntimeMobileConfig(build: MobileConfig, readMarker: () => string | null): MobileConfig {
  if (!isUnionGroundBackend(build)) return build;
  let marker: StoreDemoMarker | null = null;
  try {
    marker = parseStoreDemoMarker(readMarker());
  } catch {
    marker = null;
  }
  if (!marker) return build;
  const config = storeDemoConfig(marker.supabasePublishableKey);
  return config.backendConfigured && config.supabaseUrl === SAMPLE_SUPABASE_ORIGIN
    ? { ...config, storeDemo: { entry: marker.entry } }
    : build;
}

// The store build pinned to Production, outside the demo: the one place the
// Explore the demo entry is offered.
export function offersStoreDemo(config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'>): boolean {
  return isUnionGroundBackend(config);
}

export function isStoreDemo(config: Pick<MobileConfig, 'storeDemo'>): boolean {
  return Boolean(config.storeDemo);
}

export function authStorageKeyFor(config: Pick<MobileConfig, 'storeDemo'>): string {
  return config.storeDemo ? STORE_DEMO_AUTH_STORAGE_KEY : PRODUCTION_AUTH_STORAGE_KEY;
}

// sample.unionground.example/api/runtime-config answers a one-line script carrying the SAMPLE
// project and its publishable key (api/_lib/runtimeConfig.js
// serializeRuntimeConfig). The project must be the pinned SAMPLE project and
// the surface the demo; anything else, including the Production project, is
// refused, so no answer can point the demo at Production.
const RUNTIME_CONFIG_PREFIX = 'globalThis.__UNION_GROUND_RUNTIME_CONFIG__=Object.freeze(';
export function sampleKeyFromRuntimeConfig(body: string): string | null {
  const text = body.trim();
  if (text.length > 4096 || !text.startsWith(RUNTIME_CONFIG_PREFIX) || !text.endsWith(');')) return null;
  try {
    const value: unknown = JSON.parse(text.slice(RUNTIME_CONFIG_PREFIX.length, -2));
    if (!value || typeof value !== 'object') return null;
    const { surface, configured, supabaseUrl, supabasePublishableKey } = value as Record<string, unknown>;
    if (surface !== 'demo' || configured !== true || supabaseUrl !== SAMPLE_SUPABASE_ORIGIN) return null;
    return publishableKey(supabasePublishableKey);
  } catch {
    return null; // swallow-ok: a malformed answer is refused; the caller reports the demo unavailable
  }
}

export const STORE_DEMO_UNAVAILABLE = 'The demo is unavailable right now. Try again.';

export type StoreDemoDevice = {
  fetch: typeof fetch;
  writeMarker(value: string): Promise<void>;
  deleteMarker(): Promise<void>;
  // Removes the demo session stored under STORE_DEMO_AUTH_STORAGE_KEY on this
  // phone, without any server call.
  clearDemoSession(): Promise<void>;
  restart(): Promise<void>;
};

// How long Explore the demo waits for sample.unionground.example's answer, headers and body
// together, before giving the screen back.
export const STORE_DEMO_ENTRY_DEADLINE_MS = 10000;

async function readSampleKey(device: Pick<StoreDemoDevice, 'fetch'>, signal: AbortSignal): Promise<string | null> {
  const response = await device.fetch(STORE_DEMO_RUNTIME_CONFIG_URL, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error();
  return sampleKeyFromRuntimeConfig(await response.text());
}

// Explore the demo, from the Production sign-in screen: read the SAMPLE key,
// save the marker and restart into the demo. Nothing here touches the
// Production session or its storage. stillWanted is the caller's
// auth-ownership check: a sign-in that took the screen while the key was read
// keeps it, and the marker is never left behind for it.
//
// The read has one rejecting deadline over the request and its body (gate
// stage 127 on #8680): a native transport may ignore the abort and never
// settle, and the caller holds the shared sign-in ownership until this
// settles, so every Production sign-in would wait on it. At the deadline the
// request is aborted and anything it brings later is discarded.
export async function beginStoreDemo(
  build: MobileConfig,
  device: StoreDemoDevice,
  stillWanted: () => boolean = () => true,
  deadlineMs: number = STORE_DEMO_ENTRY_DEADLINE_MS,
): Promise<void> {
  let written = false;
  try {
    if (!isUnionGroundBackend(build) || !stillWanted()) throw new Error();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('deadline'));
      }, deadlineMs);
    });
    const read = readSampleKey(device, controller.signal);
    // A read that settles after the deadline has nothing left to report to.
    read.catch(() => undefined); // swallow-ok: the deadline already failed this entry; a late failure is discarded
    let key: string | null;
    try {
      key = await Promise.race([read, deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (!key || !stillWanted()) throw new Error();
    written = true;
    await device.writeMarker(serializeStoreDemoMarker(key, 'pending'));
    if (!stillWanted()) throw new Error();
    await device.restart();
  } catch {
    // A marker left behind would open the demo on the next launch without a
    // tap, or over a sign-in that took the screen; take it back so the app
    // stays on Production.
    if (written) await device.deleteMarker().catch(() => undefined); // swallow-ok: best effort; the entry already fails with STORE_DEMO_UNAVAILABLE
    throw new Error(STORE_DEMO_UNAVAILABLE);
  }
}

// Exit demo: removes the demo session from this phone, then the marker, then
// restarts on the Production configuration. No step needs the SAMPLE server,
// so the visitor can always leave, offline or with SAMPLE down. A demo
// session that cannot be removed stays under its own key, which the
// Production build never reads.
export async function leaveStoreDemo(device: Pick<StoreDemoDevice, 'clearDemoSession' | 'deleteMarker' | 'restart'>): Promise<void> {
  await device.clearDemoSession().catch(() => undefined); // swallow-ok: a demo session left on the phone stays under its own key, never read by Production; Exit must still leave
  await device.deleteMarker();
  await device.restart();
}

// How long Exit demo waits for the ordinary sign-out of the demo persona
// before leaving anyway: the sign-out needs the SAMPLE server.
export const STORE_DEMO_SIGN_OUT_BOUND_MS = 4000;

// Exit demo from inside it: try the app's ordinary sign-out first, so the
// SAMPLE server ends the persona's session, but never wait on it beyond the
// bound and never let its failure hold the visitor in the demo.
export async function endStoreDemo(
  signOut: (() => Promise<void>) | null,
  device: Pick<StoreDemoDevice, 'clearDemoSession' | 'deleteMarker' | 'restart'>,
  boundMs: number = STORE_DEMO_SIGN_OUT_BOUND_MS,
): Promise<void> {
  if (signOut) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((done) => { timer = setTimeout(done, boundMs); });
    await Promise.race([signOut().catch(() => undefined), bound]); // swallow-ok: the SAMPLE sign-out is best effort; Exit must leave without SAMPLE
    clearTimeout(timer);
  }
  await leaveStoreDemo(device);
}

// Where Exit demo is drawn, so it is reachable in every state the store demo
// can be in, whatever the role, session or connectivity
// :
// 'cover' inside the lock and session-check covers, which sit above every
// screen; 'pill' in the DEMO pill's menu when a demo role is open; 'screen'
// on the sign-in screen, which draws its own; 'floating' everywhere else
// (session recovery, an unavailable session, the downloads page, locked or
// not).
export type StoreDemoExitPlacement = 'none' | 'cover' | 'pill' | 'screen' | 'floating';
export function storeDemoExitPlacement(state: {
  storeDemo: boolean;
  locked: boolean;
  privacyCovered: boolean;
  pathname: string;
  mode: string;
  sampleHat: string | null;
}): StoreDemoExitPlacement {
  if (!state.storeDemo) return 'none';
  // The covers are not drawn over the public downloads page, which a locked
  // phone opens from its cover; there the floating DEMO · Exit demo control
  // stays.
  if ((state.locked || state.privacyCovered) && state.pathname !== '/offline') return 'cover';
  if (state.pathname !== '/offline' && state.mode === 'authenticated' && state.sampleHat) return 'pill';
  if (state.pathname === '/sign-in' && state.mode === 'signedOut') return 'screen';
  return 'floating';
}
