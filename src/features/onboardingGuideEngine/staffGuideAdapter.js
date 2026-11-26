// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029.
//
// The staff feature guides' only doors to the server: one read and two
// writers (supabase/migrations/20261030010000_staff_onboarding_guides.sql).
// Each writer answers with the guide after the write. Each call names its RPC
// literally, so the read-RPC drift guard can resolve it.
import { useCallback, useEffect, useRef, useState } from "react";
import { MemberApiError } from "../../lib/memberApiError.js";

export const STAFF_GUIDE_RPCS = Object.freeze({
  read: "get_staff_onboarding_guide",
  complete: "complete_staff_onboarding_step",
  mark: "mark_staff_onboarding_step",
});

function unwrap(result) {
  if (result?.error) throw new MemberApiError("Staff feature guides", result.error);
  return result?.data ?? null;
}

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function readStaffOnboardingGuide(client) {
  return unwrap(await client.rpc("get_staff_onboarding_guide"));
}

export async function completeStaffOnboardingStep(client, stepId, idempotencyKey = newKey()) {
  return unwrap(await client.rpc("complete_staff_onboarding_step", { p_step_id: stepId, p_idempotency_key: idempotencyKey }));
}

export async function markStaffOnboardingStep(client, stepId, mark) {
  return unwrap(await client.rpc("mark_staff_onboarding_step", { p_step_id: stepId, p_mark: mark }));
}

/**
 * The staff guide payload for the signed-in person, re-read on each
 * `refreshKey` change and on window focus, so a guide finished on the phone
 * shows on the next look. A failed read or write shows nothing new; the guide
 * never blocks the page. `scope` names the session and organization: a change
 * drops the old payload at once, and an answer for an older scope is dropped.
 * @param {{ client: { rpc: Function } | null, enabled: boolean, scope: string, refreshKey?: unknown }} input
 */
export function useStaffOnboardingGuide({ client, enabled, scope, refreshKey }) {
  const [state, setState] = useState({ scope: null, payload: null });
  const epoch = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const load = useCallback(async () => {
    const mine = ++epoch.current;
    if (!enabled || !client?.rpc) { setState({ scope, payload: null }); return; }
    try {
      const payload = await readStaffOnboardingGuide(client);
      if (mine === epoch.current) setState({ scope, payload });
    } catch {
      if (mine === epoch.current) setState({ scope, payload: null });
    }
  }, [client, enabled, scope]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);
  // A write answers with the guide after it; keep that answer only while the
  // same person and organization are still signed in.
  const run = useCallback(async (write) => {
    if (!enabled || !client?.rpc) return null;
    const started = scope;
    const mine = ++epoch.current;
    try {
      const payload = await write(client);
      if (mine === epoch.current && scopeRef.current === started) setState({ scope: started, payload });
      return payload;
    } catch {
      return null;
    }
  }, [client, enabled, scope]);
  return {
    payload: enabled && state.scope === scope ? state.payload : null,
    reload: load,
    complete: useCallback((stepId) => run((c) => completeStaffOnboardingStep(c, stepId)), [run]),
    mark: useCallback((stepId, kind) => run((c) => markStaffOnboardingStep(c, stepId, kind)), [run]),
  };
}
