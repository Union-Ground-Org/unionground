// Typed seam over the shared welcome-back model
// (REQ-UG-REACTIVATION-WELCOME-BACK-20261001).
import {
  WELCOME_BACK_RPC as SHARED_RPC,
  normalizeWelcomeBack as sharedNormalize,
  resolveWelcomeBackStep as sharedStep,
} from '../../../../src/features/memberHome/welcomeBack.js';

export type WelcomeBackDecision = { enabled: boolean; welcomeBack: boolean; afterDays: number | null };

export type WelcomeBackStep =
  | { kind: 'updates'; count: number; title: string | null }
  | { kind: 'poll'; id: string; title: string }
  | { kind: 'event'; id: string; title: string; startsAt: string }
  | { kind: 'case'; id: string; reference: string | null; title: string | null }
  | { kind: 'resources' };

export type WelcomeBackInputs = {
  unreadUpdates: number;
  newestUpdateTitle: string | null;
  openPolls: readonly { id: string; title: string }[];
  events: readonly { id: string; title: string; startsAt: string }[];
  activeCases: readonly { id: string; reference?: string | null; title?: string | null }[];
  now: Date;
};

export const WELCOME_BACK_RPC: string = SHARED_RPC;

export function normalizeWelcomeBack(payload: unknown): WelcomeBackDecision {
  const value: WelcomeBackDecision = sharedNormalize(payload);
  return value;
}

export function resolveWelcomeBackStep(input: WelcomeBackInputs): WelcomeBackStep {
  const value: WelcomeBackStep = sharedStep(input);
  return value;
}
