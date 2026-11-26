import type { Session } from '@supabase/supabase-js';
import { captureSessionWriter, type MobileSessionWriter } from './supabase';
import {
  loadMobileMemberChapterStewards,
  loadMobileMemberOrganizationStructure,
  startMobileMemberStewardConversation,
} from './supabase';
import type { MemberOrgDataPort } from '../lib/memberOrgContract';

/**
 * The one place the member org-structure surfaces reach the backend. Keeping it
 * behind the contract's port type means the screens hold no RPC name and the
 * names themselves live once, in `MEMBER_ORG_RPC_NAMES`.
 */
export const memberOrgPort: MemberOrgDataPort = {
  loadStewardRoster: loadMobileMemberChapterStewards,
  loadOrganizationStructure: loadMobileMemberOrganizationStructure,
  startStewardConversation: () => { throw new Error('A composing session is required.'); },
};

export function memberOrgPortForSession(session: Session | null): MemberOrgDataPort & { writer: MobileSessionWriter } {
  const writer = captureSessionWriter(session);
  return { ...memberOrgPort, writer, startStewardConversation: (steward, body) => startMobileMemberStewardConversation(writer, steward, body) };
}
