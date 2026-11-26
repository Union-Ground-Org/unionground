import { staffTwoStepPaused } from '../lib/staffTwoStepNotice';
import { getSupabaseClient } from './supabase';

// public.get_staff_mfa_standing is the same self-only read the website makes.
// A missing backend or a failed read answers false, so a transient error never
// paints a pause the server did not report.
export async function loadStaffTwoStepPaused(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  const answer: { data: unknown; error: unknown } = await client.rpc('get_staff_mfa_standing');
  if (answer.error) return false;
  return staffTwoStepPaused(answer.data);
}
