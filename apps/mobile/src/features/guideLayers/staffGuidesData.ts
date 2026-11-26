// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029 (native).
//
// The staff feature guides' doors to the server on the phone: the read and
// both writers of supabase/migrations/20261030010000_staff_onboarding_guides.sql,
// the same RPCs the web calls. The rules are the shared pure module
// (src/features/onboardingGuideEngine/staffGuides.js); the English lines are
// in ./guideCopy.ts. PREVIEW never reads or writes: progress belongs to a real
// person in a real organization.

import * as Crypto from 'expo-crypto';

import { staffGuideFor } from '../../../../../src/features/onboardingGuideEngine/staffGuides.js';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { getSupabaseClient, type MobileSessionWriter } from '../../services/supabase';

// The phone's own names for the screens a guide opens.
export const NATIVE_STAFF_FEATURE_NAMES: Record<string, string> = {
  casework: 'Issue work',
  'chapter-health': 'Campaign health',
  people: 'People',
  units: 'Units',
  leadership: 'Leadership',
  messages: 'Messages',
  settings: 'Account',
};

async function call(response: { data: unknown; error: unknown }): Promise<unknown> {
  if (response.error) throw response.error;
  return response.data ?? null;
}

export async function loadStaffOnboardingGuide(): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) return null;
  return call(await client.rpc('get_staff_onboarding_guide'));
}

export async function completeStaffOnboardingStep(writer: MobileSessionWriter, stepId: string): Promise<unknown> {
  const client = await writer.client();
  return call(await client.rpc('complete_staff_onboarding_step', { p_step_id: stepId, p_idempotency_key: Crypto.randomUUID() }));
}

export async function markStaffOnboardingStep(writer: MobileSessionWriter, stepId: string, mark: 'seen' | 'got' | 'reopen'): Promise<unknown> {
  const client = await writer.client();
  return call(await client.rpc('mark_staff_onboarding_step', { p_step_id: stepId, p_mark: mark }));
}

/** The staff hat a live session works as: the picked role, or the only one held. */
export function liveStaffGuideHat(app: { mode: string; chosenStaffRole?: string | null; authorizedRoles: readonly string[] }): string | null {
  if (app.mode !== 'authenticated') return null;
  return app.chosenStaffRole ?? explicitLiveStaffHat(app.authorizedRoles);
}

/**
 * A staff write that is a guide's real first action has landed: finish that
 * guide for the hat worn. Fire and forget; the server refuses a role the
 * person does not hold, or feature guides switched off, and nothing changes.
 */
export async function finishStaffGuide(writer: MobileSessionWriter, hat: string | null, feature: string): Promise<void> {
  if (!writer?.userId) throw new Error('The composing account is unavailable.');
  const entry: { stepId: string } | null = hat ? staffGuideFor(hat, feature) : null;
  if (!entry) return;
  const stepId: string = entry.stepId;
  try { await completeStaffOnboardingStep(writer, stepId); } catch { /* the guide stays open; nothing else depends on it */ }
}
