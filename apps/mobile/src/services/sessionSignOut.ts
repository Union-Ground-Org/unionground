import type { SupabaseClient } from '@supabase/supabase-js';

import { withShareRecoveryTestBoundary } from './shareRecoveryTestHook';

/** Keep the full PostgREST envelope and the caller's captured-session client. */
export function prepareMySignOut(
  client: SupabaseClient,
  scope: 'local' | 'global',
  expectedUserID: string,
) {
  return withShareRecoveryTestBoundary('prepare-signout', () => client.rpc('prepare_my_signout', {
    p_scope: scope,
    p_expected_user_id: expectedUserID,
  }));
}
