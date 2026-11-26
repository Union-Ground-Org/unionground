import { sessionIDFromAccessToken } from './sessionLineage';

type Identity = { user: { id: string }; access_token: string };
export type NativeAuthOperation = {
  signal: AbortSignal;
  current(): boolean;
  stage(session: Identity): void;
  finish(): void;
};

// Provider UI may background the app. Ownership follows the authenticated
// session lineage, not AppState or the foreground revalidation counter.
export function createNativeAuthGate() {
  let active: { expected: string | null; valid: boolean; abort: AbortController } | null = null;
  const staged = new Map<string, { current(): boolean }>();
  const rejected = new Set<string>();
  const lineage = (session: Identity | null) => session
    ? `${session.user.id}:${sessionIDFromAccessToken(session.access_token) ?? 'invalid'}` : null;
  return {
    begin(captured: Identity | null): NativeAuthOperation {
      if (active) throw new Error('A sign-in request is already open.');
      if (captured && !sessionIDFromAccessToken(captured.access_token)) throw new Error('Sign in again.');
      const operation = { expected: lineage(captured), valid: true, abort: new AbortController() };
      active = operation;
      const current = () => active === operation && operation.valid;
      const stages = new Set<string>();
      return {
        signal: operation.abort.signal,
        current,
        stage(session) {
          const id = sessionIDFromAccessToken(session.access_token);
          if (!current() || !id || rejected.has(id)) throw new Error('The sign-in request ended.');
          if (captured && session.user.id !== captured.user.id) throw new Error('The account changed.');
          staged.set(id, { current });
          stages.add(id);
        },
        finish() {
          for (const id of stages) {
            // An aborted link may have rotated the original session's token.
            // Keep that pre-existing lineage usable; only quarantine a newly
            // introduced session. The guarded write has already rolled back.
            if (!current() && (!captured || id !== sessionIDFromAccessToken(captured.access_token))) rejected.add(id);
            staged.delete(id);
          }
          if (active === operation) active = null;
        },
      };
    },
    cancel() { if (active) { active.valid = false; active.abort.abort(); } },
    observe(session: Identity | null): boolean {
      const id = session && sessionIDFromAccessToken(session.access_token);
      if (id && (rejected.has(id) || (staged.has(id) && !staged.get(id)!.current()))) return false;
      if (active && !(id && staged.has(id)) && lineage(session) !== active.expected) {
        active.valid = false;
        active.abort.abort();
      }
      return true;
    },
    isStaged(session: Identity | null): boolean {
      const id = session && sessionIDFromAccessToken(session.access_token);
      return Boolean(id && staged.has(id));
    },
    canWrite(raw: string): boolean {
      let token: unknown;
      try { token = (JSON.parse(raw) as { access_token?: unknown }).access_token; } catch { return true; }
      if (typeof token !== 'string') return true;
      const id = sessionIDFromAccessToken(token);
      return !id || (!rejected.has(id) && (!staged.has(id) || staged.get(id)!.current()));
    },
    isBusy() { return active !== null; },
  };
}

export const nativeAuthGate = createNativeAuthGate();
