import { useEffect, useState } from 'react';

import type { LiveStaffRole } from '../../lib/hatFunctions';
import { staffDeskNumbers, staffDeskNumbersRead, type StaffDeskNumber } from '../../lib/staffDeskNumbers';
import { createCapturedSessionRpcClient } from '../../services/supabase';
import { useApp } from '../../state/AppProvider';

// The desk numbers for the staff role Home leads with
// (UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108).
// Read once per role, session and pull-to-refresh, on the session that asked,
// so a role switch or sign-out never paints another role's figures. The
// status says whether a missing value is still loading or could not be read.
export type StaffDeskNumbersState = { numbers: StaffDeskNumber[]; status: 'loading' | 'ready' | 'failed' };

export function useStaffDeskNumbers(role: LiveStaffRole | null): StaffDeskNumbersState | null {
  const { session, refreshing } = useApp();
  const [read, setRead] = useState<{ key: string; result: { data: unknown; error: unknown } } | null>(null);
  const key = role && session ? `${role}:${session.user.id}` : null;
  useEffect(() => {
    if (!role || !session || refreshing || !staffDeskNumbersRead(role)) return;
    let alive = true;
    void (async () => {
      let result: { data: unknown; error: unknown };
      try {
        const reply = await createCapturedSessionRpcClient(session).rpc(staffDeskNumbersRead(role));
        result = { data: reply.data, error: reply.error };
      } catch (error) {
        result = { data: null, error };
      }
      if (alive) setRead({ key: `${role}:${session.user.id}`, result });
    })();
    return () => { alive = false; };
  }, [refreshing, role, session]);
  if (!role) return null;
  const current = read && read.key === key ? read.result : null;
  return { numbers: staffDeskNumbers(role, current), status: current === null ? 'loading' : current.error ? 'failed' : 'ready' };
}
