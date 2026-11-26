// Native password sign-in goes through the portal's password proxy
// (api/auth-password-signin.js), the same route the web sign-in uses, so a
// refused native attempt reaches the organization's failed-login telemetry.
// The proxy answers with tokens for the portal's backend, which is the backend
// this app pins (the trusted portal origin, see lib/configPolicy.ts). Every
// server answer — credentials, outage, malformed reply, refused session — is
// one flat error. Two cases say something else, and neither reveals whether
// an address has an account:
// - the proxy's 429: its sign-in limits are the same for every address, so
//   "wait and try again" is the honest answer;
// - fetch itself rejecting before any response arrived (no signal, DNS or TLS
//   failure, BUG-UG-NATIVE-NO-SIGNAL-SHOWN-AS-WRONG-PASSWORD-20261018):
//   the server never saw the attempt, so the member is told to check the
//   connection instead of retyping a password that was never checked.
export type NativeSignInPlatform = 'ios' | 'android';

export const PASSWORD_SIGN_IN_FAILED = 'Could not sign in. Check the email and password.';
export const PASSWORD_SIGN_IN_RATE_LIMITED = 'Too many sign-in attempts. Wait a while, then try again.';
export const PASSWORD_SIGN_IN_UNREACHABLE = 'Could not reach Union Ground. Check your connection and try again.';

type Dependencies = {
  fetch: typeof fetch;
  setSession(tokens: { access_token: string; refresh_token: string }): Promise<{ error: unknown }>;
};

export function nativeSignInPlatform(os: unknown): NativeSignInPlatform | null {
  return os === 'ios' || os === 'android' ? os : null;
}

export async function signInThroughPortalPasswordProxy(
  input: { portalOrigin: string; email: string; password: string; platform: NativeSignInPlatform | null },
  dependencies: Dependencies,
): Promise<void> {
  let response: Response;
  try {
    response = await dependencies.fetch(`${input.portalOrigin.replace(/\/$/, '')}/api/auth-password-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        ...(input.platform ? { client: input.platform } : {}),
      }),
    });
  } catch {
    // No response at all: the attempt never reached the proxy.
    throw new Error(PASSWORD_SIGN_IN_UNREACHABLE);
  }
  let rateLimited = false;
  try {
    rateLimited = response.status === 429;
    const payload = await response.json().catch(() => null) as { accessToken?: unknown; refreshToken?: unknown } | null;
    if (!response.ok || typeof payload?.accessToken !== 'string' || typeof payload?.refreshToken !== 'string') {
      throw new Error('sign-in-failed');
    }
    const { error } = await dependencies.setSession({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
    });
    if (error) throw new Error('sign-in-failed');
  } catch {
    throw new Error(rateLimited ? PASSWORD_SIGN_IN_RATE_LIMITED : PASSWORD_SIGN_IN_FAILED);
  }
}
