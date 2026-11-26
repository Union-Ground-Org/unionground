// Reads the member-safe organization switches for the Compass panel
// (REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001). Only the switches map
// of get_member_organization_configuration() is kept; nothing is cached.
import type { Session } from '@supabase/supabase-js';

import type { OrganizationSwitchConfiguration, SettingValue } from '../lib/featureSwitches';
import { memberNudgesFrom, type CompassNudge } from '../lib/compassNudges';
import { createCapturedSessionRpcClient } from './supabase';

export type CompassConfigurationRpcClient = {
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function loadCompassSwitchConfiguration(
  session: Session,
  client: CompassConfigurationRpcClient = createCapturedSessionRpcClient(session),
): Promise<OrganizationSwitchConfiguration> {
  const { data, error } = await client.rpc('get_member_organization_configuration');
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const switches = (data as { switches?: unknown }).switches;
  if (!switches || typeof switches !== 'object' || Array.isArray(switches)) return null;
  return { switches: switches as Record<string, SettingValue> };
}

// REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001: the member's own attention
// nudges; counts only, read once the organization switch is known to be on.
export async function loadCompassMemberNudges(
  session: Session,
  client: CompassConfigurationRpcClient = createCapturedSessionRpcClient(session),
): Promise<CompassNudge[]> {
  const { data, error } = await client.rpc('get_compass_nudges');
  if (error) return [];
  return memberNudgesFrom(data);
}
