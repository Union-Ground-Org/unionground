import 'react-native-url-polyfill/auto';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

import { mobileConfig } from '../lib/config';
import { isLiveSampleBackend } from './sampleSession';
import { createCapturedSessionRpcClient } from './supabase';
import { CATALOG_KEY_PATTERN, catalogSearchPlan, isMissingRpcError, loadCatalogProfile, probeCatalogStatus, searchCatalog, type CatalogRpcClient, type CatalogProfile } from '../../../../src/features/unionCatalog/catalogSearch.js';
import { searchRegistry } from '../../../../src/features/unionCatalog/registrySearch.js';

let publicClient: SupabaseClient | null = null;
export type NativeUnionRow = {
  id: string; name: string; registryOnly?: boolean;
  affiliation: string | null; designation: string | null; localNumber: string | null;
  city: string | null; state: string | null;
  website: { href: string; host: string } | null;
};
type NativeSearchResult = {
  rows: NativeUnionRow[]; total: number; hasNext: boolean; totalCapped: boolean;
  release: string | null; source: 'catalog' | 'registry';
};

// A separate anonymous client: catalog searches never inherit a member's
// session or persist one. SAMPLE and offline preview contain no real catalog.
export function getPublicCatalogClient(): SupabaseClient | null {
  if (!mobileConfig.backendConfigured || !mobileConfig.supabaseUrl || isLiveSampleBackend(mobileConfig)) return null;
  publicClient ??= createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return publicClient;
}

// Document links are for members (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110):
// a profile is read in the signed-in member's own session, so the server
// includes them; with no session it is read anonymously and they are withheld.
export function getCatalogProfileClient(session: Session | null): CatalogRpcClient | null {
  const anonymous = getPublicCatalogClient();
  if (!anonymous || !session?.access_token) return anonymous;
  return createCapturedSessionRpcClient(session);
}

export async function readUnionSearch(client: CatalogRpcClient, query: string, page = 0): Promise<NativeSearchResult> {
  const status = await probeCatalogStatus(client);
  const plan = catalogSearchPlan(query, {}, page, status.catalog);
  if (plan.source === 'catalog') {
    try {
      const result = await searchCatalog(client, plan.args);
      return { ...result, release: status.status?.releaseLabel ?? null, source: 'catalog' };
    } catch (error) {
      if (!isMissingRpcError(error)) throw error;
    }
  }
  const { rows, total } = await searchRegistry(client, query, { page });
  return { rows, total, hasNext: (page + 1) * 20 < total && page < 49, totalCapped: false, release: null, source: 'registry' };
}

export async function readUnionProfile(client: CatalogRpcClient, key: string): Promise<CatalogProfile> {
  if (!CATALOG_KEY_PATTERN.test(key)) return { found: false };
  const status = await probeCatalogStatus(client);
  if (status.catalog !== 'live') return { found: false };
  const profile = await loadCatalogProfile(client, key);
  // A response for a different body must not lend identity to navigation.
  if (!profile.found || profile.organization?.key !== key) return { found: false };
  return profile;
}
