import { createClient, navigatorLock } from "@supabase/supabase-js";
import { isBuildTimeDemoSurface, liveBackendAllowed, sampleBackendAllowed } from "./demoOrigin.js";
import { isBrowserSafeSupabaseKey, matchSupabaseProjectOrigin } from "./providerShape.js";
import { isForbiddenSampleBackend, isSampleSupabaseProject } from "./sampleBackend.js";
import { boundedSampleFetch } from "./sampleRequest.js";
import { guardedFetch } from "./transportGuard.js";
import { availableBrowserAuthStorage, createExactSessionStorage, sessionIDFromAccessToken } from "./exactSessionStorage.js";

const runtimeConfig = globalThis.__UNIONGROUND_RUNTIME_CONFIG__;
// Unit tests and the local Vite development server still use explicit VITE_*
// inputs. Vite folds this branch out of production builds; the post-build
// isolation verifier rejects any regression that leaves an input value in a
// deployed static file.
const localDevelopmentConfig = import.meta.env.DEV
  ? Object.freeze({
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      supabasePublishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      sampleSupabaseUrl: import.meta.env.VITE_SAMPLE_SUPABASE_URL,
      sampleSupabasePublishableKey: import.meta.env.VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY,
    })
  : null;

const runtimeSurface = runtimeConfig?.configured === true ? runtimeConfig.surface : null;
const supabaseUrl = runtimeSurface === "saas"
  ? runtimeConfig.supabaseUrl
  : localDevelopmentConfig?.supabaseUrl;
const supabasePublishableKey = runtimeSurface === "saas"
  ? runtimeConfig.supabasePublishableKey
  : localDevelopmentConfig?.supabasePublishableKey;
const sampleSupabaseUrl = runtimeSurface === "demo"
  ? runtimeConfig.supabaseUrl
  : localDevelopmentConfig?.sampleSupabaseUrl;
const sampleSupabasePublishableKey = runtimeSurface === "demo"
  ? runtimeConfig.supabasePublishableKey
  : localDevelopmentConfig?.sampleSupabasePublishableKey;

function browserAuthLockOptions() {
  try {
    return globalThis.window?.navigator?.locks?.request
      ? { lock: navigatorLock, lockAcquireTimeout: -1 }
      : {};
  } catch {
    // The lineage-aware storage adapter remains fail-closed when browser
    // capability inspection itself is denied.
    return {};
  }
}

// PKCE, explicitly, on BOTH browser clients — the same flow the Expo client
// already pins (apps/mobile/src/services/supabase.ts). supabase-js defaults the
// browser to the implicit flow, which returns the access and refresh tokens in
// the URL FRAGMENT: they land in the address bar, in tab-restore state, in the
// back/forward history entry, and in anything reading document.location on the
// same origin. PKCE returns a single-use `?code=` instead, redeemed against a
// verifier this browser generated and never sent, so an intercepted callback
// URL is worth nothing on its own.
//
// Nothing in the web app reads an access-token hash: password sign-in uses
// this same PKCE client. The SAMPLE persona
// bootstrap uses verifyOtp with a token_hash (flow-independent — it exchanges
// server-side and returns the session directly), and /invite reads its OWN
// `#invite=` fragment and refuses any query string. So the switch is safe for
// live and SAMPLE alike, and neither client's key resolution changes.
const clientOptions = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
    // Serialize whole auth operations across current browser tabs. The
    // lineage-aware storage adapter remains the rolling-client/fallback guard;
    // an unbounded Web Lock wait cannot steal a still-running auth operation.
    // auth-js 2.118 deprecates this option, but dropping it lets a late
    // getUser cleanup in one tab delete a newer session adopted in another
    // (doubled gate on), so it stays; see createAuthClient below.
    ...browserAuthLockOptions(),
    // No passkey opt-in: Union Ground signs in with a provisioned email and
    // password only (passkey, SSO and store-account sign-in are left out).
    // Keep existing exact redirect allowlists working. Auth-js 2.118 can
    // round-trip sb_flow_id, but appending it changes the allowlisted URL.
    experimental: { appendPkceFlowIdToRedirects: false },
  },
  global: { headers: { "X-Client-Info": "unionground-web" } },
};

// auth-js 2.118 logs "The "lock" option is deprecated" once per page whenever
// a client passes `lock`, so every visitor who opens developer tools sees it
// . Hide only that notice, only while the browser clients are built;
// every other warning passes through and the lock itself is unchanged. If an
// SDK upgrade stops honouring the lock, tests/supabase-auth-lock-sdk.test.js
// fails.
const AUTH_LOCK_DEPRECATION_NOTICE = 'The "lock" option is deprecated';

function createAuthClient(url, key, options) {
  if (!options.auth?.lock) return createClient(url, key, options);
  const warn = console.warn;
  try {
    console.warn = function withoutAuthLockNotice(...args) {
      if (typeof args[0] === "string" && args[0].includes(AUTH_LOCK_DEPRECATION_NOTICE)) return;
      return warn.apply(this, args);
    };
  } catch {
    // A frozen console keeps the notice; the lock is what matters.
  }
  try {
    return createClient(url, key, options);
  } finally {
    try { console.warn = warn; } catch { /* unchanged */ }
  }
}

function authStorageKeyForUrl(url) {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

function configuredAuthStorage(url) {
  const key = authStorageKeyForUrl(url);
  const browserStorage = availableBrowserAuthStorage();
  let unavailable = browserStorage.__unionGroundUnavailable === true;
  if (!unavailable) {
    try {
      // Read only the exact auth slot. Mutating capability probes can strand
      // sentinels in quota- or policy-restricted storage.
      browserStorage.getItem(key);
    } catch {
      unavailable = true;
    }
  }
  return {
    key,
    storage: createExactSessionStorage(browserStorage),
    // The backing realm createExactSessionStorage persists through. Lineage
    // reads must use this object, not a later availableBrowserAuthStorage()
    // call, which would mint a fresh empty memory store.
    adapter: browserStorage,
    unavailable,
  };
}

// The live client exists only for the one Union Ground project the build
// pins (VITE_UNIONGROUND_SUPABASE_REF) and only with a browser-safe key.
// The pin is a build input, never read from the runtime config it validates,
// and vite.config.mjs refuses a build whose pin or URL is a sibling product's
// project (src/lib/providerContract.js), so no deny list ships here. No
// Union Ground provider is provisioned yet, so this is false today and the
// app renders its fail-closed state.
const expectedProjectRef = import.meta.env.VITE_UNIONGROUND_SUPABASE_REF;

function unionGroundProviderValid(url, key) {
  if (!url || !expectedProjectRef || !isBrowserSafeSupabaseKey(key)) return false;
  try {
    matchSupabaseProjectOrigin(url, expectedProjectRef, { allowLocal: import.meta.env.DEV });
    return true;
  } catch {
    return false;
  }
}

export const hasSupabaseConfig = unionGroundProviderValid(supabaseUrl, supabasePublishableKey)
  && runtimeSurface !== "demo"
  && !isBuildTimeDemoSurface()
  && liveBackendAllowed();

export const hasSampleSupabaseConfig = Boolean(sampleSupabaseUrl && sampleSupabasePublishableKey)
  && runtimeSurface !== "saas"
  && sampleBackendAllowed()
  && !isForbiddenSampleBackend(sampleSupabaseUrl);

const liveAuthStorage = hasSupabaseConfig ? configuredAuthStorage(supabaseUrl) : null;
const sampleAuthStorage = hasSampleSupabaseConfig ? configuredAuthStorage(sampleSupabaseUrl) : null;

export const supabase = hasSupabaseConfig
  ? createAuthClient(supabaseUrl, supabasePublishableKey, {
      ...clientOptions,
      auth: {
        ...clientOptions.auth,
        ...(liveAuthStorage
          ? { storageKey: liveAuthStorage.key, storage: liveAuthStorage.storage }
          : {}),
      },
      global: {
        ...clientOptions.global,
        fetch: guardedFetch(boundedSampleFetch),
      },
    })
  : null;

// The SAMPLE-project client for the demo origin. It stays null (never the
// production client) unless a non-forbidden SAMPLE origin is pinned, so a
// misconfigured deploy cannot bleed SAMPLE traffic into production. Its fetch
// adapter bounds JSON auth/REST requests only; Storage retains normal transfer
// semantics and caller cancellation.
export const sampleSupabase = hasSampleSupabaseConfig
  ? createAuthClient(sampleSupabaseUrl, sampleSupabasePublishableKey, {
      ...clientOptions,
      auth: {
        ...clientOptions.auth,
        ...(sampleAuthStorage
          ? { storageKey: sampleAuthStorage.key, storage: sampleAuthStorage.storage }
          : {}),
      },
      global: {
        fetch: guardedFetch(boundedSampleFetch),
        headers: { "X-Client-Info": "unionground-sample-web" },
      },
    })
  : null;

// The one client the member app boots with, resolved by surface: the
// production client on the SaaS origin, the SAMPLE client on the demo origin
// (production parity). The two config flags above
// are mutually exclusive by construction — liveBackendAllowed() and
// sampleBackendAllowed() cannot both hold — so this resolution can never hand
// production keys to the SAMPLE surface or SAMPLE keys to the product site.
// A memory-only anonymous client for signed-out reference reads
// (REQ-UG-FIND-YOUR-UNION-PUBLIC-REGISTRY-SEARCH-20260924). It never
// persists or picks up a session, so its requests run as `anon` even in a
// browser that holds a member session. That is deliberate: public.union_orgs
// carries the restrictive mfa_assurance policy on `authenticated`, which
// returns zero rows to a signed-in member who has enrolled TOTP but is at
// aal1, while `anon` reads the whole registry. A distinct storageKey keeps its
// auth lock and storage slot apart from the member client. Null on the demo
// surface and wherever no live configuration exists, so the caller shows an
// honest unavailable state instead of querying SAMPLE data. One lazy instance
// per page: auth-js counts GoTrueClient instances per storageKey and React
// StrictMode mounts twice, so a per-mount client would warn and leak its
// visibilitychange listener. The same bounded fetch as the member clients
// keeps a stalled request from pinning the page behind its loading state.
let publicReadClient = null;
export function createPublicReadClient() {
  if (!hasSupabaseConfig) return null;
  publicReadClient ??= createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "sg-public-read",
    },
    global: { fetch: boundedSampleFetch, headers: { "X-Client-Info": "unionground-public-read" } },
  });
  return publicReadClient;
}

export const appSupabase = supabase ?? sampleSupabase;
export const hasAppBackend = Boolean(appSupabase);
export const appBackendKind = supabase ? "live" : sampleSupabase ? "sample" : null;

const appBackendUrl = supabase ? supabaseUrl : sampleSupabase ? sampleSupabaseUrl : null;
// appBackendKind names the client, not the project: "live" also covers a main
// client configured with the SAMPLE URL. This answers for the project the
// active client actually connects to.
export const appBackendIsSampleProject = isSampleSupabaseProject(appBackendUrl);
const appBackendKey = supabase ? supabasePublishableKey : sampleSupabase ? sampleSupabasePublishableKey : null;
const appAuthStorage = supabase ? liveAuthStorage : sampleSupabase ? sampleAuthStorage : null;
export const appAuthStorageKey = appAuthStorage?.key ?? null;
export const appAuthStorageUnavailable = appAuthStorage?.unavailable === true;

export function authStorageAdapter() {
  return appAuthStorage?.adapter ?? null;
}

export function appAuthSessionIsClosed(session) {
  if (!appAuthStorage) return false;
  return appAuthStorage.storage.isSessionClosed(appAuthStorage.key, session);
}

// `boundedTransport` gives the client the shared live client's request
// deadline (boundedSampleFetch) on every backend, not only on SAMPLE; the
// private two-person writers ask for it ( round 1, r2s2), so a write that
// moved off the shared client keeps the deadline it had there.
export function createCapturedAppSessionRpcClient(capturedSession, { boundedTransport = false } = {}) {
  if (!appBackendUrl || !appBackendKey || !capturedSession?.access_token) {
    throw new Error("The captured authenticated client is unavailable.");
  }
  const capturedAccessToken = capturedSession.access_token;
  return createClient(appBackendUrl, appBackendKey, {
    accessToken: async () => capturedAccessToken,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      ...(sampleSupabase || boundedTransport ? { fetch: guardedFetch(boundedSampleFetch) } : {}),
      headers: { "X-Client-Info": "unionground-web-captured-session" },
    },
  });
}

// Account configuration needs Auth, which the captured RPC client deliberately
// disables. Its session stays in memory; it never subscribes to or persists
// over the browser's live session. The caller owns any later MFA adoption.
let accountClientSequence = 0;
export async function createCapturedAppAccountClient(capturedSession, { pkce = false } = {}) {
  if (!appBackendUrl || !appBackendKey || !capturedSession?.access_token) throw new Error("The account client is unavailable.");
  // A provider link must leave its verifier for the ordinary live callback.
  // Only PKCE keys use that existing exact-session adapter. The isolated
  // client's session and its BroadcastChannel have a private namespace.
  const privateKey = `${appAuthStorageKey}-account-proof-${++accountClientSequence}`;
  const memory = new Map();
  const pkceKey = (key) => pkce && key.startsWith(privateKey) && key.endsWith("-code-verifier")
    ? `${appAuthStorageKey}${key.slice(privateKey.length)}` : null;
  const storage = {
    getItem(key) { const target = pkceKey(key); return target ? appAuthStorage.storage.getItem(target) : memory.get(key) ?? null; },
    setItem(key, value) { const target = pkceKey(key); return target ? appAuthStorage.storage.setItem(target, value) : memory.set(key, value); },
    removeItem(key) { const target = pkceKey(key); return target ? appAuthStorage.storage.removeItem(target) : memory.delete(key); },
  };
  if (pkce && (!appAuthStorage || appAuthStorage.unavailable)) throw new Error("The account callback storage is unavailable.");
  const isolated = createClient(appBackendUrl, appBackendKey, {
    auth: { autoRefreshToken: false, persistSession: pkce, storageKey: privateKey, storage, detectSessionInUrl: false, flowType: "pkce", experimental: clientOptions.auth.experimental },
    global: { fetch: boundedSampleFetch },
  });
  const seeded = await isolated.auth.setSession(capturedSession);
  if (seeded.error || seeded.data.session?.user?.id !== capturedSession.user?.id
    || sessionIDFromAccessToken(seeded.data.session?.access_token) !== sessionIDFromAccessToken(capturedSession.access_token)) {
    await isolated.auth.dispose();
    // No answer at all (GoTrue's status 0) is not an account change; pass it
    // on so the screen can say to check the connection . Every answer
    // and every identity or lineage mismatch stays this refusal.
    if (seeded.error?.name === "AuthRetryableFetchError" && seeded.error?.status === 0) throw seeded.error;
    throw new Error("The account changed before this was sent.");
  }
  return isolated;
}

let capturedSessionVerifier = null;

export function verifyCapturedAppSession(capturedSession) {
  if (!appBackendUrl || !appBackendKey || !capturedSession?.access_token) {
    throw new Error("The captured authenticated client is unavailable.");
  }
  // getUser can call _removeSession and publish SIGNED_OUT when the server
  // reports session_not_found, even when passed an explicit token. Keep those
  // effects in a dedicated memory-only client with no app auth subscribers.
  // Do not use the RPC client's accessToken option: it disables Auth entirely.
  capturedSessionVerifier ??= createClient(appBackendUrl, appBackendKey, {
    auth: {
      storageKey: `${appAuthStorageKey}-signout-verification`,
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: boundedSampleFetch,
      headers: { "X-Client-Info": "unionground-web-session-verification" },
    },
  });
  return capturedSessionVerifier.auth.getUser(capturedSession.access_token);
}

// Once the captured session is cleared, the sign-in flows' PKCE verifiers go
// with it, as auth-js's own sign-out would remove them . They are
// snapshotted in the clear's own locked turn, before its fence, and removed later only while
// unchanged, so a replacement login's flows, started after the clear, stay
// . That cleanup is best effort: a storage error there must not report
// a completed sign-out as failed.
export function clearCapturedAppSessionLocally(capturedSession, options) {
  if (!appAuthStorage) throw new Error("Exact browser session storage is unavailable.");
  const { key, storage } = appAuthStorage;
  let snapshot = null;
  const onMatched = () => { try { snapshot = storage.snapshotPkceVerifiers(key); } catch { snapshot = null; } };
  // A replacement session seen after the snapshot may own flows in it .
  const onReplaced = () => { snapshot = null; };
  return Promise.resolve(storage.removeSessionIfMatches(key, capturedSession, { ...options, onMatched, onReplaced })).then(async (cleared) => {
    if (cleared && snapshot) await Promise.resolve().then(() => storage.removePkceVerifiers(key, snapshot)).catch(() => {});
    return cleared;
  });
}

// The retired-host refusal's local clear: the lineage compare-and-swap when
// the refused token carries a session id, else the refusal-only removal of
// the exact tuple, which the compare-and-swap cannot fence (gate round 3 on
export function clearRefusedAppSessionLocally(refusedSession, options) {
  if (!appAuthStorage) throw new Error("Exact browser session storage is unavailable.");
  if (sessionIDFromAccessToken(refusedSession?.access_token)) {
    return appAuthStorage.storage.removeSessionIfMatches(appAuthStorage.key, refusedSession, options);
  }
  return appAuthStorage.storage.removeRefusedSessionExactly(appAuthStorage.key, refusedSession);
}
