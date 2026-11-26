import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubSessionWriter } from '../testing/stubSessionWriter';

// #9240 pull request D2: businessRpc records where a refusal came from (the
// answer's HTTP status, and whether the body has PostgREST's own error shape)
// on the same error object, without changing anything its callers already
// read. Each businessRpc caller below runs through the pinned SDK's real RPC
// builder over a local fake transport: no hosted database, user content or
// real token is involved.
type SupabaseSdk = typeof import('@supabase/supabase-js');
type MobileSessionWriter = ReturnType<typeof stubSessionWriter>;
vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => '33333333-3333-4333-8333-333333333333' }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://business-writer-test.invalid', supabasePublishableKey: 'sb_publishable_test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

const { createClient } = await vi.importActual<SupabaseSdk>('@supabase/supabase-js');
const { attachBusinessRpcProvenance, businessRpcProvenance } = await import('./businessWriters');
const { saveNativeOrganizationWorkload, saveNativeUnitOverrides, saveNativeChapterUnitSettings, saveNativeUnitWorkload } = await import('./unitSettings');
const { saveMobileSurveySession, submitMobileSurveySession } = await import('./memberSurveys');
type UnitWorkspace = import('./unitSettings').UnitWorkspace;
type UnitContext = import('./unitSettings').UnitContext;

const owner = '11111111-1111-4111-8111-111111111111';
const emptyEffective = { workload: [], forms: [], templates: [], capabilities: {} };
const unitWorkspace: UnitWorkspace = {
  actorId: owner, chapterId: owner, units: [], unitId: owner, canSetChapter: true,
  allowed: {}, defaults: emptyEffective, effective: emptyEffective, organizationDefaults: emptyEffective,
  chapterOverrides: {}, overrides: {}, chapterVersion: 1, unitVersion: 1,
  formChoices: [], templateChoices: [], audit: [],
};
const unitContext: UnitContext = {
  actorId: owner, chapterId: owner, organizationId: owner, units: [], unitId: owner, needsChoice: false, canManage: true,
  effective: { ...emptyEffective, configuration: { actorId: owner, chapterId: owner, organizationId: owner, unitId: owner, unitName: 'Unit', version: 1, settingsRevision: 'revision-1',
    definition: { title: 'Workload', period: 'month', statuses: ['logged'], fields: [] } } },
};

// The next answer the fake transport gives, and the RPCs it was asked for.
let respond: () => Response = () => new Response('null', { status: 200 });
let requests: string[] = [];
const client: SupabaseClient = createClient('https://business-writer-test.invalid', 'sb_publishable_test', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (input: RequestInfo | URL) => { requests.push(new URL(String(input)).pathname); return respond(); } },
});
const writer: MobileSessionWriter = stubSessionWriter(() => client, owner);
afterEach(() => { requests = []; respond = () => new Response('null', { status: 200 }); });

const rpcCallers: [string, () => Promise<unknown>][] = [
  ['organization workload', () => saveNativeOrganizationWorkload(writer, { organizationId: owner, version: 0, definition: { title: 'Workload', period: 'month', statuses: ['logged'], fields: [] } }, { cases: 1 }, 'logged')],
  ['unit workload', () => saveNativeUnitWorkload(writer, unitContext, { cases: 1 }, 'logged')],
  ['unit overrides', () => saveNativeUnitOverrides(writer, unitWorkspace, {})],
  ['campaign settings', () => saveNativeChapterUnitSettings(writer, unitWorkspace, {}, {})],
  ['survey save', () => saveMobileSurveySession(writer, owner, { q1: 'answer' })],
  ['survey submit', () => submitMobileSurveySession(writer, owner, { q1: 'answer' })],
];
const json = (status: number, body: object) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const page = (status: number, body: string) => () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const postgrestRefusal = { code: '42501', details: null, hint: null, message: 'authentication required' };
const changedForm = { code: 'PT409', details: 'workload_configuration_changed', hint: null, message: 'settings changed; reload' };
const gatewayBody = { code: '42501', message: 'Gateway Timeout' };
type Provenance = { httpStatus: number; postgrestShape: boolean };
const answers: [string, () => Response, Record<string, unknown> | null, Provenance][] = [
  ['a PostgREST 403 refusal', json(403, postgrestRefusal), postgrestRefusal, { httpStatus: 403, postgrestShape: true }],
  ['a PostgREST 409 refusal', json(409, changedForm), changedForm, { httpStatus: 409, postgrestShape: true }],
  ['a gateway 504 JSON body carrying 42501', json(504, gatewayBody), gatewayBody, { httpStatus: 504, postgrestShape: false }],
  ['a gateway 502 HTML page', page(502, '<html>Bad Gateway</html>'), { message: '<html>Bad Gateway</html>' }, { httpStatus: 502, postgrestShape: false }],
  ['a transport failure', () => { throw new TypeError('Network request failed'); }, null, { httpStatus: 0, postgrestShape: false }],
];

describe.each(rpcCallers)('%s through businessRpc', (_caller, write) => {
  it.each(answers)('records %s on the same error without changing its fields', async (_name, answer, body, provenance) => {
    respond = answer;
    const error: unknown = await write().then(() => null, (failure: unknown) => failure);
    expect(error).toBeTruthy();
    expect(businessRpcProvenance(error)).toEqual(provenance);
    if (body) {
      // Same fields, nothing enumerable added: callers and logs see the body.
      expect(error).toEqual(body);
      expect(JSON.stringify(error)).toBe(JSON.stringify(body));
    } else {
      expect(error).toMatchObject({ code: '', message: 'TypeError: Network request failed' });
    }
    expect(Object.keys(error as object)).not.toContain('httpStatus');
    expect(requests).toHaveLength(1);
  });
});

it('leaves a value it cannot extend exactly as it was', () => {
  expect(attachBusinessRpcProvenance('refused', 400)).toBe('refused');
  const frozen = Object.freeze({ code: '42501', message: 'refused', details: null, hint: null });
  expect(attachBusinessRpcProvenance(frozen, 403)).toBe(frozen);
  expect(businessRpcProvenance(frozen)).toBeNull();
  expect(businessRpcProvenance({ code: '42501' })).toBeNull();
  expect(businessRpcProvenance(null)).toBeNull();
});

it('records no status when the answer reported none', () => {
  const error = attachBusinessRpcProvenance({ code: '42501', message: 'refused', details: null, hint: null }, undefined);
  expect(businessRpcProvenance(error)).toEqual({ httpStatus: 0, postgrestShape: true });
});
