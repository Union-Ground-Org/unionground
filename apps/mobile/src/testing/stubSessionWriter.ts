import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { MobileSessionWriter } from '../services/supabase';

// A protocol-test fixture, deliberately not an Auth substitute. Session race
// coverage uses the real SDK and captureSessionWriter in onlineWriters.session.
export function stubSessionWriter(getClient: () => unknown, userId = 'member-a'): MobileSessionWriter {
  return {
    userId,
    client: async () => {
      const client = getClient();
      if (!client) throw new Error('Test backend unavailable');
      return client as SupabaseClient;
    },
    session: async () => (await (getClient() as SupabaseClient).auth.getSession()).data.session as Session,
    isCurrent: async () => true,
    check: async () => 'current',
    acknowledged: async <T>(value: T) => ({ acknowledged: true, value, continuationCurrent: true }),
  };
}
