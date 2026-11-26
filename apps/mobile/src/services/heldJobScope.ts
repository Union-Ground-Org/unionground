// The two reads behind the native held-job rule
// (withoutHeldJobs in ../lib/mi1Shared). Kept out of supabase.ts, which is a
// gate path. The web admin desk already makes both reads, and both fail
// closed.
import { getSupabaseClient } from './supabase';

// The keys of the admin settings list (get_admin_organization_configuration).
// The list leaves a held switch out, so Operations health leaves out a job
// that serves one (withoutHeldJobs, shared with the web Job health list).
// Any failure answers null: unread, so those jobs stay hidden (fail closed).
export async function loadMobileAdminListedSettingKeys(): Promise<string[] | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  try {
    const response: { data: unknown; error: unknown } = await supabase.rpc('get_admin_organization_configuration');
    if (response.error || !response.data || typeof response.data !== 'object') return null;
    const settings: unknown = (response.data as Record<string, unknown>).settings;
    if (!Array.isArray(settings)) return null;
    return settings.flatMap((item: unknown) => {
      const key: unknown = item && typeof item === 'object' ? (item as Record<string, unknown>).key : null;
      return typeof key === 'string' ? [key] : [];
    });
  } catch {
    return null; // swallow-ok: unread keeps every held-feature job hidden (fail closed), and the job list reports its own failure
  }
}

// Whether this account is a Compass AI platform operator (canManage of the
// member-callable get_compass_platform_ai, as the web admin desk reads it). Any
// failure answers false.
export async function loadMobileCompassPlatformOperator(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  try {
    const response: { data: unknown; error: unknown } = await supabase.rpc('get_compass_platform_ai');
    if (response.error || !response.data || typeof response.data !== 'object') return false;
    return (response.data as Record<string, unknown>).canManage === true;
  } catch {
    return false; // swallow-ok: not known as an operator, so held-feature jobs stay hidden (fail closed)
  }
}
