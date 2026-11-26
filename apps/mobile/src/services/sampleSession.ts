import { pinnedSampleSupabaseOrigin, samplePersonaForHat, samplePersonas, samplePortalOrigin } from '../../../../src/lib/sampleBackend';
import { SAMPLE_SUPABASE_ORIGIN } from '../lib/configPolicy';
import type { PreviewHatKey } from '../data/preview';
import type { MobileConfig } from '../lib/configPolicy';

type SampleConfig = Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl'>;
type SampleAuth = {
  getSession(): Promise<{ data: { session: unknown }; error: unknown }>;
  setSession(input: SampleSessionTokens): Promise<{ error: unknown }>;
};
type SampleSessionTokens = { access_token: string; refresh_token: string };

// The demo entry and its hat switcher
// (UB-UG-NATIVE-DEMO-ENTRY-RESTORED-20261107, owner ruling
// an owner decision): on the SAMPLE host a visitor enters with one
// tap and explores every role the Tamarack seed keeps there. The persona
// behind each hat is the server's own list (src/lib/sampleBackend, the
// allowlist api/demo-session mints from), so the app never names an account
// the server would refuse; only the role words live here. The offline
// PREVIEW fixture stays retired: nothing here is bundled data.
export type SampleHat = { key: PreviewHatKey; label: string; description: string };
const SAMPLE_HAT_COPY: readonly SampleHat[] = [
  { key: 'member', label: 'Worker', description: 'Home, messages, meetings and votes as a worker sees them' },
  { key: 'organizer', label: 'Organizer', description: 'One-on-ones, the card drive and the campaign stage' },
  { key: 'steward', label: 'Committee', description: 'Worker requests, issue work and office hours' },
  { key: 'coordinator', label: 'Campaign lead', description: 'Issues, follow-ups and the issue board' },
  { key: 'advisor', label: 'Advisor', description: 'Accommodation reviews and committee member consults' },
  { key: 'admin', label: 'Admin', description: 'Roles, templates and campaign settings' },
  { key: 'vp', label: 'Campaign chair', description: 'Campaign standing, ratification and the executive board' },
];
// The server names the Organizer persona "organize"; the app's hat is
// "organizer" (samplePersonaForHat resolves the same alias the other way).
const SERVER_HAT_ALIASES: Readonly<Record<string, PreviewHatKey>> = { organize: 'organizer' };
function sampleHatEntry(value: string): SampleHat | null {
  const key = SERVER_HAT_ALIASES[value] ?? value;
  return SAMPLE_HAT_COPY.find((hat) => hat.key === key) ?? null;
}
// In the server's order, so the menu and the website's switcher agree; a hat
// the app has no words for is left out rather than shown blank.
export const SAMPLE_HATS: readonly SampleHat[] = samplePersonas().flatMap((persona) => {
  const hat = sampleHatEntry(persona.hat);
  return hat ? [hat] : [];
});

// The entry starts as the member hat (owner ruling, Nov 7, 2026); every other
// role is one switch away.
export const DEFAULT_SAMPLE_HAT: PreviewHatKey = 'member';

// Product words for every failure: no status code, provider detail or token
// reaches the screen.
export const SAMPLE_UNAVAILABLE = 'The demo is unavailable right now. Try again.';

export function sampleHatForSession(config: SampleConfig, session: unknown): PreviewHatKey | null {
  if (!isLiveSampleBackend(config) || !session || typeof session !== 'object'
    || !('user' in session) || !session.user || typeof session.user !== 'object'
    || !('email' in session.user) || typeof session.user.email !== 'string') return null;
  const email = session.user.email.toLowerCase();
  return SAMPLE_HATS.find((hat) => samplePersonaForHat(hat.key)?.email.toLowerCase() === email)?.key ?? null;
}

export function isLiveSampleBackend(config: SampleConfig): boolean {
  return config.backendConfigured && config.supabaseUrl === pinnedSampleSupabaseOrigin();
}

// The endpoint answers 200 with the persona's session token pair, which the
// pinned Auth client adopts (the website's entry does the same); a 503 is its
// retryable answer and every other status is final. Bounded strings only.
function sessionTokens(payload: unknown): SampleSessionTokens | null {
  if (!payload || typeof payload !== 'object' || !('accessToken' in payload) || !('refreshToken' in payload)) return null;
  const { accessToken, refreshToken } = payload;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  if (!accessToken.trim() || !refreshToken.trim() || accessToken.length > 16384 || refreshToken.length > 1024) return null;
  return { access_token: accessToken, refresh_token: refreshToken };
}

// The same server allowlist and session as the website's entry:
// /api/demo-session (demo host only) signs the persona in server-side and
// returns its session, which the pinned Auth client adopts like any sign-in.
// No persona password, privileged key or locally fabricated session is
// involved, and nothing but the hat leaves the app.
export async function openSampleSession(
  config: SampleConfig,
  auth: SampleAuth,
  stillWanted: () => boolean = () => true,
  hat: string = DEFAULT_SAMPLE_HAT,
): Promise<void> {
  try {
    if (!isLiveSampleBackend(config) || !sampleHatEntry(hat) || !samplePersonaForHat(hat)) throw new Error();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await auth.getSession();
      if (existing.error || existing.data.session || !stillWanted()) throw new Error();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let tokens: SampleSessionTokens | null = null;
      let retryable = false;
      try {
        const response = await fetch(`${samplePortalOrigin()}/api/demo-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hat }),
          // Best effort on native fetch; the session comes only from the
          // pinned origin's answer, never from a redirect target.
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.status === 503) retryable = true;
        else if (!response.ok) throw new Error();
        else tokens = sessionTokens(await response.json());
      } finally {
        clearTimeout(timeout);
      }
      // The persona was busy or a concurrent visitor took its turn. Once more.
      if (retryable) continue;
      if (!tokens || !stillWanted()) throw new Error();
      const current = await auth.getSession();
      if (current.error || current.data.session || !stillWanted()) throw new Error();
      const { error } = await auth.setSession(tokens);
      if (error) throw new Error();
      return;
    }
    throw new Error();
  } catch {
    throw new Error(SAMPLE_UNAVAILABLE);
  }
}

export async function switchSampleSession(
  config: SampleConfig,
  auth: SampleAuth,
  expectedHat: PreviewHatKey,
  nextHat: string,
  signOut: () => Promise<void>,
  stillWanted: () => boolean = () => true,
): Promise<void> {
  try {
    const current = await auth.getSession();
    if (current.error || !sampleHatEntry(nextHat) || !samplePersonaForHat(nextHat)
      || sampleHatForSession(config, current.data.session) !== expectedHat
      || !stillWanted()) throw new Error();
    if (nextHat === expectedHat) return;
    // Reuse the complete installation/session cleanup boundary. A failed or
    // superseded sign-out leaves a session that openSampleSession refuses.
    await signOut();
    await openSampleSession(config, auth, stillWanted, nextHat);
  } catch {
    throw new Error(SAMPLE_UNAVAILABLE);
  }
}
