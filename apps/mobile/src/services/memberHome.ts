// Native reads and writes for the restored member-Home surfaces
// (restore-everything). Reads run on the captured-session RPC
// client, the exact JWT that was current when Home asked; the server
// re-derives the caller and the selected organization and enforces each
// organization switch. Writes use the same row-level-security paths the
// Messages screens already use.

import type { Session } from '@supabase/supabase-js';

import { HOME_TAKEOVER_RPC, normalizeHomeTakeover, type HomeTakeover } from '../lib/memberHomeShared';
import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

export type MemberHomeRpcClient = {
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
};

// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001.
export async function loadMemberHomeTakeover(
  session: Session,
  client: MemberHomeRpcClient = createCapturedSessionRpcClient(session),
): Promise<HomeTakeover> {
  const { data, error } = await client.rpc(HOME_TAKEOVER_RPC);
  if (error) throw new Error('The Home updates could not be loaded.');
  return normalizeHomeTakeover(data);
}

// The same receipt write the web Messages screen uses (src/lib/memberApi.js
// markBroadcastRead): an idempotent upsert of the caller's own receipt row.
export async function markMemberBroadcastRead(userID: string, broadcastID: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.from('member_broadcast_receipts').upsert(
    { user_id: userID, broadcast_id: broadcastID },
    { onConflict: 'broadcast_id,user_id', ignoreDuplicates: true },
  );
  if (error) throw error;
}
