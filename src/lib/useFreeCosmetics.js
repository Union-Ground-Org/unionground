import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFreeCosmeticsApi } from './freeCosmetics.js';

/** @typedef {import('./freeCosmetics.js').CosmeticKind} CosmeticKind */
/** @typedef {import('./freeCosmetics.js').CosmeticWorkspace} CosmeticWorkspace */
/** @typedef {import('./freeCosmetics.js').FreeCosmeticsApi} FreeCosmeticsApi */
/**
 * @typedef {object} FreeCosmeticsState
 * @property {CosmeticWorkspace | null} workspace
 * @property {boolean} error
 * @property {boolean} busy
 * @property {boolean} available
 * @property {(search?: string) => Promise<CosmeticWorkspace | null>} load
 * @property {(userId: string, key: string, reason: string) => Promise<void>} grant
 * @property {(kind: CosmeticKind, key: string | null) => Promise<void>} select
 */

// Captured-session clients and an explicit organization identity are supplied
// by the host. Never repaint a different account/tenant with a late response.
/**
 * @param {import('./freeCosmetics.js').CosmeticRpcClient | null} client
 * @param {string | null} identity
 * @param {string | null} organizationId
 * @returns {FreeCosmeticsState}
 */
export function useFreeCosmetics(client, identity, organizationId) {
  const api = useMemo(() => client && organizationId ? createFreeCosmeticsApi(client, organizationId) : null, [client, organizationId]);
  const scope = `${identity ?? ''}:${organizationId ?? ''}`;
  const current = useRef({ api, scope });
  current.current = { api, scope };
  const generation = useRef(0);
  const pending = useRef(false);
  const [state, setState] = useState(/** @type {{ scope: string, workspace: CosmeticWorkspace | null, error: boolean, busy: boolean }} */ ({ scope: '', workspace: null, error: false, busy: false }));
  const live = () => current.current.api === api && current.current.scope === scope;
  const load = useCallback(async (search = '') => {
    if (!api || !identity || !organizationId) return null;
    const version = ++generation.current;
    try {
      const workspace = await api.load(search);
      if (!live() || version !== generation.current) return null;
      if (workspace?.organizationId !== organizationId) throw new Error('Cosmetic scope changed');
      setState((old) => ({ ...old, scope, workspace, error: false }));
      return workspace;
    } catch {
      if (live() && version === generation.current) setState((old) => ({ ...old, scope, workspace: null, error: true }));
      return null;
    }
  }, [api, identity, organizationId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    pending.current = false;
    setState({ scope, workspace: null, error: false, busy: false });
    void load();
    return () => { generation.current += 1; };
  }, [load, scope]);
  /** @param {(adapter: FreeCosmeticsApi) => Promise<unknown>} operation */
  async function mutate(operation) {
    if (!api || !live() || pending.current) throw new Error('Cosmetics unavailable');
    pending.current = true;
    setState((old) => ({ ...old, busy: true }));
    try {
      await operation(api);
      if (!live() || !await load()) throw new Error('Cosmetic change unconfirmed');
    } finally {
      if (live()) {
        pending.current = false;
        setState((old) => ({ ...old, busy: false }));
      }
    }
  }
  const visible = state.scope === scope && api && identity && organizationId;
  return {
    workspace: visible ? state.workspace : null,
    error: visible ? state.error : false,
    busy: visible ? state.busy : false,
    available: Boolean(api && identity && organizationId),
    load,
    grant: (userId, itemKey, reason) => mutate((adapter) => adapter.grant(userId, itemKey, reason)),
    select: (kind, itemKey) => mutate((adapter) => adapter.select(kind, itemKey)),
  };
}
