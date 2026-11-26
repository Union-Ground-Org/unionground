// Whether directory sync (SCIM) is released, for copy that must not name it
// before its release day (REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117,
// #9037). It reads public.get_scim_control() (loadMobileScimReleased), the
// read the Integration controls screen uses. Fails closed: signed out or in a
// preview, while the read is out, after it fails or is refused (the read is
// for organization admins with two-step sign-in), and for a read taken under
// another session, it answers false.
import { useEffect, useState } from 'react';

import { useApp } from '../state/AppProvider';
import { loadMobileScimReleased } from './supabase';

export function useScimReleased(): boolean {
  const { mode, session } = useApp();
  const token = mode === 'authenticated' ? session?.access_token ?? null : null;
  const [read, setRead] = useState<{ token: string; released: boolean } | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    void Promise.resolve().then(() => loadMobileScimReleased()).then(
      (released) => { if (active) setRead({ token, released }); },
      () => { if (active) setRead(null); },
    );
    return () => { active = false; };
  }, [token]);
  return token !== null && read !== null && read.token === token && read.released;
}
