// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029.
//
// The org-start guide's only doors to the server: one read and three writers
// (supabase/migrations/20261029150000_organization_start_guide.sql). Every
// writer returns the guide as it is after the write. Each call names its RPC
// literally, so the read-RPC drift guard can resolve it.
import { useCallback, useEffect, useRef, useState } from "react";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { MemberApiError } from "../../lib/memberApiError.js";

export const ORG_START_RPCS = Object.freeze({
  read: "get_organization_start_guide",
  reviewSwitches: "mark_organization_start_switches_reviewed",
  saveContacts: "save_organization_start_contacts",
  celebrate: "acknowledge_organization_start_celebration",
});

function unwrap(result) {
  if (result?.error) throw new MemberApiError("Organization start guide", result.error);
  return result?.data ?? null;
}

export async function readOrganizationStartGuide(client) {
  return unwrap(await client.rpc("get_organization_start_guide"));
}

export async function markOrganizationStartSwitchesReviewed(client) {
  return unwrap(await client.rpc("mark_organization_start_switches_reviewed"));
}

export async function saveOrganizationStartContacts(client, { backupUserId, spokespersonUserIds }) {
  return unwrap(await client.rpc("save_organization_start_contacts", {
    p_backup_user_id: backupUserId || null,
    p_spokesperson_user_ids: Array.isArray(spokespersonUserIds) ? spokespersonUserIds : [],
  }));
}

export async function acknowledgeOrganizationStartCelebration(client) {
  return unwrap(await client.rpc("acknowledge_organization_start_celebration"));
}

/**
 * The org-start payload for the signed-in staff person, re-read on each
 * `refreshKey` change (a screen change) and on window focus, so a milestone
 * finished in another tab or by another person shows on the next look. A
 * failed read is reported separately from a hidden guide. `scope` names
 * the session and organization: a change drops the old payload at once.
 * @param {{ client: { rpc: Function } | null, enabled: boolean, scope: string, refreshKey?: unknown }} input
 */
export function useOrganizationStartGuide({ client, enabled, scope, refreshKey }) {
  const [state, setState] = useState({ scope: null, payload: null, phase: "idle" });
  const epoch = useRef(0);
  const writeRequest = useRef(0);
  const canRead = enabled && typeof client?.rpc === "function";
  const load = useCallback(async () => {
    const mine = ++epoch.current;
    if (!canRead) { setState({ scope, payload: null, phase: "idle" }); return; }
    setState((previous) => ({ scope, payload: previous.scope === scope ? previous.payload : null, phase: "loading" }));
    try {
      const payload = await withLoadDeadline(readOrganizationStartGuide(client));
      if (mine === epoch.current) setState({ scope, payload, phase: "ready" });
    } catch {
      if (mine === epoch.current) setState({ scope, payload: null, phase: "failed" });
    }
  }, [client, canRead, scope]);
  useEffect(() => {
    void load();
    return () => { epoch.current += 1; };
  }, [load, refreshKey]);
  useEffect(() => {
    if (!canRead || typeof window === "undefined") return undefined;
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [canRead, load]);
  // A successful write can replace the pending read. A refusal leaves it eligible.
  const run = useCallback(async (write) => {
    if (!canRead) return null;
    const mine = epoch.current;
    const request = ++writeRequest.current;
    const payload = await write(client);
    if (mine === epoch.current && request === writeRequest.current) {
      epoch.current += 1;
      setState({ scope, payload, phase: "ready" });
    }
    return payload;
  }, [client, canRead, scope]);
  const current = canRead && state.scope === scope;
  return {
    payload: current ? state.payload : null,
    phase: current ? state.phase : canRead ? "loading" : "idle",
    reload: load,
    reviewSwitches: () => run(markOrganizationStartSwitchesReviewed),
    saveContacts: (contacts) => run((c) => saveOrganizationStartContacts(c, contacts)),
    celebrate: () => run(acknowledgeOrganizationStartCelebration),
  };
}
