import type { Session } from '@supabase/supabase-js';
import { pulseHistoryCards } from '../lib/pulseHistory';
import type { PulseCard } from '../lib/pulseCatalog';
import { createCapturedSessionRpcClient } from './supabase';

// One server read per hat; the server rechecks the hat, chapter, organization
// level and survey gate on every call.
export async function loadPulseHistory(session: Session, hat: string): Promise<PulseCard[]> {
  const result: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(session).rpc('get_pulse_history', { p_hat: hat });
  if (result.error) throw new Error('Weekly history could not be verified.');
  return pulseHistoryCards(result.data);
}
