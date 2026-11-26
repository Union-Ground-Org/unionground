// Typed seam over the web member-Home modules the native app shares
// (restore-everything). Native screens import these pure
// functions from here, never the web JSX.
import {
  HOME_TAKEOVER_RPC as SHARED_HOME_TAKEOVER_RPC,
  normalizeHomeTakeover as sharedNormalizeHomeTakeover,
} from '../../../../src/features/memberHome/takeover.js';

export type HomeTakeoverMessage = {
  id: string;
  conversationId: string;
  senderName: string | null;
  body: string;
  truncated: boolean;
  createdAt: string;
};

export type HomeTakeoverBroadcast = {
  id: string;
  sender: string | null;
  title: string;
  body: string;
  truncated: boolean;
  publishedAt: string;
  audience: 'chapter' | 'organization' | null;
};

export type HomeTakeover = {
  enabled: boolean;
  message: HomeTakeoverMessage | null;
  broadcast: HomeTakeoverBroadcast | null;
};

export const HOME_TAKEOVER_RPC: string = SHARED_HOME_TAKEOVER_RPC;

export function normalizeHomeTakeover(payload: unknown): HomeTakeover {
  const result: HomeTakeover = sharedNormalizeHomeTakeover(payload);
  return result;
}
