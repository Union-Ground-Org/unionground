import type { Session } from '@supabase/supabase-js';
import { requestAccountDeletion } from '../../../../src/lib/accountLifecycleApi';
import { mobileConfig } from '../lib/config';

// A member with no second factor re-enters their password (see
// NativeAccountDeletion); the route turns it into the fresh sign-in deletion needs.
export async function deleteMobileAccount(session: Session, confirmation: string, password?: string): Promise<{ deleted: true; audited: boolean }> {
  if (!mobileConfig.backendConfigured) throw new Error('not-configured');
  const result: unknown = await requestAccountDeletion(session, confirmation, fetch, `${mobileConfig.portalBaseUrl}/api/account-lifecycle`, { password: password || '' });
  if (!result || typeof result !== 'object' || !('deleted' in result) || result.deleted !== true) {
    throw new Error('account-delete-indeterminate');
  }
  return { deleted: true, audited: 'audited' in result && result.audited === true };
}
