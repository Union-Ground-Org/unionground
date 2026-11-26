// Typed seam over the shared Home nudge policy (REQ-UG-HOME-NUDGES-20261001).
import {
  GUIDE_RPC as SHARED_GUIDE_RPC,
  NUDGES_RPC as SHARED_RPC,
  chooseHomeNudge as sharedChoose,
  normalizeHomeNudges as sharedNormalize,
} from '../../../../src/features/memberHome/nudges.js';

export type HomeNudgeServer = {
  passkey: boolean;
  onboarding: { completed: number; total: number } | null;
  starterList: boolean;
  guidedFirstRun: boolean;
  snoozeDays: number;
};

export type HomeNudgeKind = 'onboarding' | 'starter' | 'passkey';
export type HomeNudgeHistoryEntry = { dismissedAt?: number | null; shownAt?: number | null; shownThisSession?: boolean };
export type HomeNudgeHistory = Partial<Record<HomeNudgeKind, HomeNudgeHistoryEntry>>;
export type HomeNudge = { kind: 'onboarding'; completed: number; total: number } | { kind: 'starter' } | { kind: 'passkey' };

export const NUDGES_RPC: string = SHARED_RPC;
export const GUIDE_RPC: string = SHARED_GUIDE_RPC;

export function normalizeHomeNudges(payload: unknown, guidePayload: unknown = null): HomeNudgeServer {
  const value: HomeNudgeServer = sharedNormalize(payload, guidePayload);
  return value;
}

export function chooseHomeNudge(input: {
  server: HomeNudgeServer | null;
  welcomeTourActive: boolean;
  passkeySupported: boolean;
  hasPasskey: boolean | null;
  signedInAt: number | null;
  history: HomeNudgeHistory;
  now: number;
}): HomeNudge | null {
  if (!input.server) return null;
  const value: HomeNudge | null = sharedChoose({ ...input, server: input.server });
  return value;
}
