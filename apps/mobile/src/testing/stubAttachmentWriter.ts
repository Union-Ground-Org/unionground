import type { Session } from '@supabase/supabase-js';
import { stubSessionWriter } from './stubSessionWriter';

// Explicit operation ownership for legacy protocol fixtures. Authentication
// races are exercised with the real SDK in the *.session suites.
export function stubAttachmentWriter(getClient: () => unknown, userID: string) {
  const writer = stubSessionWriter(getClient, userID);
  writer.session = async () => ({ access_token: 'fixture-access-token', user: { id: userID } } as Session);
  return writer;
}
