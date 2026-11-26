import { useEffect, useState } from 'react';

import { recruitedYtdFrom } from '../../lib/memberReferral';
import { createCapturedSessionRpcClient } from '../../services/supabase';
import { useApp } from '../../state/AppProvider';

// REQ-UG-NATIVE-MEMBER-REFERRAL-CODE-20261111 (#8175): the member's
// own count of members recruited this year, from the rewards summary's
// recruitedYtd, for live Home's Member summary. Read once per session and
// pull-to-refresh on the session that asked, like the staff desk numbers. Null
// while loading, after a failed read, outside a live member session, or when
// the summary predates the referral wave: Home then shows no recruited count,
// never a stand-in number.
export function useMemberRecruitedCount(enabled: boolean): number | null {
  const { mode, session, refreshing } = useApp();
  const [read, setRead] = useState<{ userID: string; value: number | null } | null>(null);
  const active = enabled && mode === 'authenticated' && session !== null;
  useEffect(() => {
    if (!active || !session || refreshing) return;
    let alive = true;
    void (async () => {
      let value: number | null = null;
      try {
        const reply = await createCapturedSessionRpcClient(session).rpc('get_member_rewards_summary');
        value = reply.error ? null : recruitedYtdFrom(reply.data);
      } catch {
        value = null;
      }
      if (alive) setRead({ userID: session.user.id, value });
    })();
    return () => { alive = false; };
  }, [active, refreshing, session]);
  return active && session && read?.userID === session.user.id ? read.value : null;
}
