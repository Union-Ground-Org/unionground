import type { Session } from '@supabase/supabase-js';
import {
  legalAcceptanceReadNeeded,
  loadLegalAcceptanceState,
  recordLegalAcceptance as recordSharedLegalAcceptance,
} from '../../../../src/lib/legalAcceptance.js';
import { mobileConfig } from '../lib/config';
import type { LegalAcceptanceState } from '../lib/legalAcceptance';
import { publishVerifiedNativeTermsReceipt } from '../lib/legalReleaseGate';
import { isLiveSampleBackend } from './sampleSession';
import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

// The native app records and reads the acceptance through
// the SAME module and the same two database functions as the website
// (public.get_my_legal_acceptance_state and public.record_legal_acceptance,
// both self-only), so there is one server contract for both platforms. With no
// backend the state stays unknown and no prompt is shown.
export async function loadLegalAcceptance(): Promise<LegalAcceptanceState> {
  // Until a published change is marked material nothing can require
  // re-acceptance, so the app spends no read asking; the same predicate keeps
  // the website's cold boot unchanged.
  if (legalAcceptanceReadNeeded() !== true) return null;
  // Owner ruling, October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL
  // USERS". An unknown state renders no card and reserves no band.
  if (isLiveSampleBackend(mobileConfig)) return null;
  const client = getSupabaseClient();
  if (!client) return null;
  return await loadLegalAcceptanceState(client) as LegalAcceptanceState;
}

export async function recordLegalAcceptance(versions: Record<string, string>, residenceState: string, ageAttested: boolean, initiatingSession: Session): Promise<boolean> {
  if (isLiveSampleBackend(mobileConfig)) return false;
  const publication = await publishVerifiedNativeTermsReceipt(() => versions, mobileConfig.portalBaseUrl);
  if (!publication.ran || publication.result == null || typeof publication.result !== 'object' || Array.isArray(publication.result)) return false;
  try {
    const client = createCapturedSessionRpcClient(initiatingSession);
    return await recordSharedLegalAcceptance(client, publication.result as Record<string, string>, residenceState, ageAttested) as boolean;
  } catch { return false; }
}
