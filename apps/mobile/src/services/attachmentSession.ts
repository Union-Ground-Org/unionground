import type { MobileSessionWriter } from './supabase';

// The sensitive-file HTTP helpers consume only auth.getSession. Give them the
// binder's checked session read, never the mutable shared Auth namespace. Each
// upload/download pins that exact read for all of its chunks.
export function attachmentHttpClient(writer?: MobileSessionWriter) {
  return {
    auth: {
      async getSession() {
        if (!writer) throw new Error('The account changed before this was sent.');
        return { data: { session: await writer.session() }, error: null };
      },
    },
  };
}

export async function attachmentWriteClient(writer?: MobileSessionWriter) {
  if (!writer) throw new Error('The account changed before this was sent.');
  return writer.client();
}
