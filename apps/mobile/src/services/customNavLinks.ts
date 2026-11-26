// Reads the organization's admin-set custom links for the native menu
// (REQ-UG-CUSTOM-NAV-LINKS-20261001) from the member-safe configuration.
import { getSupabaseClient } from './supabase';
import { customNavLinks, type CustomNavLink } from '../lib/customNavLinks';
import type { OrganizationSwitchConfiguration } from '../lib/featureSwitches';

function asConfiguration(value: unknown): OrganizationSwitchConfiguration {
  return value && typeof value === 'object' ? value : null;
}

export async function loadMobileCustomNavLinks(): Promise<CustomNavLink[]> {
  const client = getSupabaseClient();
  if (!client) return [];
  const response: { data: unknown; error: unknown } = await client.rpc('get_member_organization_configuration');
  // #9969 (carved from #9465): a refused or failed read is not "no links";
  // the card says it could not load them.
  if (response.error) throw response.error;
  return customNavLinks(asConfiguration(response.data));
}
