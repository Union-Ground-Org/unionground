// Member-visible organization switches for native screens
// (restore-everything campaign). One get_member_organization_configuration()
// read per access token, shared by every screen that asks; the server enforces
// each switch, and this only keeps the UI honest. While the read is pending or
// fails, the caller's registered default applies.
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { isFeatureEnabled, type OrganizationSwitchConfiguration } from '../lib/featureSwitches';
import { useApp } from '../state/AppProvider';
import { createCapturedSessionRpcClient } from './supabase';

const cache = new Map<string, Promise<OrganizationSwitchConfiguration>>();

export function loadMemberConfiguration(session: Session): Promise<OrganizationSwitchConfiguration> {
  const token = session.access_token;
  const cached = cache.get(token);
  if (cached) return cached;
  const request = Promise.resolve(createCapturedSessionRpcClient(session).rpc('get_member_organization_configuration'))
    .then(({ data, error }): OrganizationSwitchConfiguration => {
      if (error) throw new Error('configuration unavailable');
      return data as OrganizationSwitchConfiguration;
    });
  cache.clear();
  cache.set(token, request);
  request.catch(() => { cache.delete(token); });
  return request;
}

export function useMemberSwitch(key: string, fallback: boolean): boolean {
  const { mode, session } = useApp();
  const [enabled, setEnabled] = useState(fallback);
  useEffect(() => {
    if (mode !== 'authenticated' || !session?.access_token) { setEnabled(fallback); return undefined; }
    let active = true;
    void loadMemberConfiguration(session)
      .then((configuration) => { if (active) setEnabled(isFeatureEnabled(configuration, key, fallback)); })
      .catch(() => { if (active) setEnabled(fallback); });
    return () => { active = false; };
  }, [mode, session, key, fallback]);
  return enabled;
}

// The switch as the member's own read gives it (`absent` stands for a key the
// map does not carry), or null while that read is pending, after it fails, and
// outside a signed-in session. For copy that must not name a feature before a
// read says it is on: the switch map reports a switch held for its release day
// as off (docs/contracts/staged-feature-releases.md;
// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113).
export function useMemberSwitchRead(key: string, absent: boolean): boolean | null {
  const { mode, session } = useApp();
  const token = mode === 'authenticated' ? session?.access_token ?? null : null;
  const [read, setRead] = useState<{ token: string; key: string; value: boolean } | null>(null);
  useEffect(() => {
    if (!token || !session) return undefined;
    let active = true;
    void loadMemberConfiguration(session)
      .then((configuration) => {
        if (!active) return;
        const value = isFeatureEnabled(configuration, key, absent);
        setRead((current) => (current?.token === token && current.key === key && current.value === value ? current : { token, key, value }));
      })
      .catch(() => { if (active) setRead(null); });
    return () => { active = false; };
  }, [token, session, key, absent]);
  // A read for another session or key is not this one's.
  return read?.token === token && read.key === key ? read.value : null;
}
