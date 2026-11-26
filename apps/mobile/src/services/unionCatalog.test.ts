import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogRpcClient } from '../../../../src/features/unionCatalog/catalogSearch.js';

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('../lib/appLinkHosts', () => ({ APP_LINK_HOSTS: Object.freeze(['app.unionground.example']) }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://public.example', supabasePublishableKey: 'sb_publishable_fixture' } }));
vi.mock('./sampleSession', () => ({ isLiveSampleBackend: () => false }));
const captured = vi.hoisted(() => ({ create: vi.fn((session: { access_token: string }) => ({ rpc: vi.fn(), token: session.access_token })) }));
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: captured.create }));

import type { Session } from '@supabase/supabase-js';
import { getCatalogProfileClient, getPublicCatalogClient, readUnionProfile, readUnionSearch } from './unionCatalog';
import { appRouteFromRouterPath, isPublicAppRoute, parseAppRoute, routerPath } from '../lib/routes';

function transport(responses: Record<string, unknown>) {
  const rpc = vi.fn(async (name: string) => ({ data: responses[name], error: null }));
  return { rpc, client: { rpc } as CatalogRpcClient };
}

describe('native unified catalog reads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the shared search RPC with bounded paging and preserves exact identity', async () => {
    const { client, rpc } = transport({
      get_union_catalog_status: { available: true, releaseLabel: '20260929-01' },
      search_union_catalog: { rows: [{ key: 'olms-900000001', name: 'Example Workers', family: 'EXAMPLE', holder: 'DO NOT RENDER' }], total: 26, hasNext: true },
    });
    const result = await readUnionSearch(client, 'Example Workers', 1);
    expect(rpc).toHaveBeenLastCalledWith('search_union_catalog', { p_query: 'Example Workers', p_state: null, p_family: null, p_tier: null, p_page: 2 });
    expect(result.rows[0]?.id).toBe('olms-900000001');
    expect(result.release).toBe('20260929-01');
    expect(JSON.stringify(result)).not.toContain('DO NOT RENDER');
  });

  it('carries hierarchy, document provenance and names-only subunits through the same web allowlist', async () => {
    const { client } = transport({ get_union_catalog_status: { available: true }, get_union_catalog_profile: {
      found: true, organization: { key: 'olms-900000001', name: 'Example Workers', sourceUrls: ['https://example.org/about'] },
      children: [{ key: 'olms-900000002', name: 'Example Local', edgeKind: 'olms_parent', certainty: 'filed' }],
      subunits: [{ key: 'unit-1', name: 'Example campaign', kind: 'chapter', leaders: [{ name: 'DO NOT RENDER' }] }],
      documents: [{ key: 'doc-1', kind: 'form', title: 'Application', url: 'https://example.org/application.pdf', asOf: '2026-09-29' }, { key: 'doc-2', title: 'Bad link', url: 'javascript:alert(1)' }],
      seatOutlines: [{ key: 'seat-1', title: 'Campaign chair', listed: 1, vacant: 0, holder: 'DO NOT RENDER' }],
    } });
    const profile = await readUnionProfile(client, 'olms-900000001');
    expect(profile).toMatchObject({ found: true, children: [{ key: 'olms-900000002' }], documents: [{ link: { href: 'https://example.org/application.pdf' } }, { link: null }] });
    expect(JSON.stringify(profile)).not.toContain('DO NOT RENDER');
    expect(JSON.stringify(profile)).not.toContain('javascript:');
  });

  // REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114
  // (#8743): the native app shows catalog names of up to 1,000 characters whole.
  it('shows a long catalog organization name whole in search and on the profile', async () => {
    const long = `${'Sindicato Nacional de Trabajadores de Ejemplo'.padEnd(621, ' de la Industria Ejemplar').slice(0, 621)}x`;
    const child = `${'Sindicato dos Trabalhadores de Exemplo'.padEnd(999, ' da Industria Exemplar').slice(0, 999)}x`;
    const { client } = transport({
      get_union_catalog_status: { available: true, releaseLabel: '20261114-81' },
      search_union_catalog: { rows: [{ key: 'ug-exmx000000', name: long }], total: 1, hasNext: false },
      get_union_catalog_profile: { found: true, organization: { key: 'ug-exmx000000', name: long },
        children: [{ key: 'ug-exbr000000', name: child, edgeKind: 'parent_body', certainty: 'confirmed' }] },
    });
    const result = await readUnionSearch(client, 'Sindicato Nacional', 1);
    expect(result.rows[0]?.name).toBe(long);
    const profile = await readUnionProfile(client, 'ug-exmx000000');
    expect(profile).toMatchObject({ found: true, organization: { name: long }, children: [{ name: child }] });
  });

  // REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: only a profile
  // read in the member's own session can carry document links.
  it('reads a profile in the worker session when there is one, and anonymously otherwise', () => {
    expect(getCatalogProfileClient(null)).toBe(getPublicCatalogClient());
    expect(captured.create).not.toHaveBeenCalled();
    const session = { access_token: 'member-token' } as Session;
    expect(getCatalogProfileClient(session)).toMatchObject({ token: 'member-token' });
    expect(captured.create).toHaveBeenCalledWith(session);
  });

  it('keeps every document of a members-only profile, with no link', async () => {
    const { client } = transport({ get_union_catalog_status: { available: true }, get_union_catalog_profile: {
      found: true, documentLinks: 'members', organization: { key: 'olms-900000001', name: 'Example Workers' },
      documents: [{ key: 'doc-1', kind: 'contract', title: 'Agreement', url: null, urlHost: null, asOf: '2026-09-29' }, { key: 'doc-2', kind: 'form', title: 'Application', url: 'https://example.org/application.pdf' }],
    } });
    const profile = await readUnionProfile(client, 'olms-900000001');
    expect(profile).toMatchObject({ found: true, documentLinks: 'members', documents: [{ key: 'doc-1', kind: 'contract', link: null }, { key: 'doc-2', link: null }] });
  });

  it('refuses malformed and mismatched identities instead of guessing a local number', async () => {
    const { client, rpc } = transport({ get_union_catalog_status: { available: true }, get_union_catalog_profile: { found: true, organization: { key: 'olms-900000002', name: 'Different body' } } });
    expect(await readUnionProfile(client, 'Local 1')).toEqual({ found: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(await readUnionProfile(client, 'olms-900000001')).toEqual({ found: false });
  });

  it('uses registry query semantics and the requested page when catalog is inactive', async () => {
    const query = { select: vi.fn(), eq: vi.fn(), or: vi.fn(), order: vi.fn(), range: vi.fn() };
    for (const name of ['select', 'eq', 'or', 'order'] as const) query[name].mockReturnValue(query);
    query.range.mockResolvedValue({ data: [{ id: 'registry-fixture', name: 'Example Local', local_number: '7' }], count: 42, error: null });
    const client = { rpc: vi.fn().mockResolvedValue({ data: { available: false }, error: null }), from: vi.fn().mockReturnValue(query) } as CatalogRpcClient;
    const result = await readUnionSearch(client, 'Local 7', 1);
    expect(query.range).toHaveBeenCalledWith(20, 39);
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining('local_number.eq."7"'));
    expect(result.source).toBe('registry');
    expect(result.hasNext).toBe(true);
  });

  it('does not turn a network failure into an empty successful search', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { available: true }, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'network', code: 'NETWORK' } });
    await expect(readUnionSearch({ rpc } as CatalogRpcClient, 'Example')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('native catalog route identity', () => {
  it('round trips exact public identity across native and universal routes', () => {
    for (const url of ['unionground://public/unions/olms-900000001', 'https://app.unionground.example/app/public/unions/olms-900000001']) {
      const route = parseAppRoute(url);
      expect(route).toEqual({ kind: 'publicUnion', key: 'olms-900000001' });
      expect(isPublicAppRoute(route)).toBe(true);
      expect(routerPath(route!)).toBe('/public/unions/olms-900000001');
      expect(appRouteFromRouterPath(routerPath(route!)!)).toEqual(route);
    }
  });
  it('refuses ambiguous, injected and unsupported identities', () => {
    for (const suffix of ['Local509', 'olms-900000001/extra', 'olms-900000001?admin=true', 'olms-900000001%2Fextra']) {
      expect(parseAppRoute(`unionground://public/unions/${suffix}`)).toBeNull();
    }
  });
});
