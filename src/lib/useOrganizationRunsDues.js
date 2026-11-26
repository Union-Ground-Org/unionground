import { useEffect, useState } from "react";
import { loadOrganizationRunsDues } from "./duesNavigation.js";

// The answer belongs to one account in one organization: a hat switch to
// another account, or a late response for the previous one, reads as unknown.
export function useOrganizationRunsDues(client, identity, organizationId) {
  const scope = client && identity && organizationId ? `${identity}:${organizationId}` : "";
  const [state, setState] = useState({ scope: "", runsDues: null });
  useEffect(() => {
    if (!scope) return undefined;
    let cancelled = false;
    loadOrganizationRunsDues(client).then((runsDues) => {
      if (!cancelled) setState({ scope, runsDues });
    });
    return () => { cancelled = true; };
  }, [client, scope]);
  return state.scope === scope ? state.runsDues : null;
}
