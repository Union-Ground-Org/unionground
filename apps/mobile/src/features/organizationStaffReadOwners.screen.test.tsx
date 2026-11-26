// @vitest-environment jsdom
import { act, createElement as h, useRef, type Dispatch, type SetStateAction } from 'react';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { useBusinessOperation, useBusinessRequests, useBusinessState, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { directoryReadIsCurrent, mergeDirectoryPages, retainedMemberSelection, chapterMembershipTargetReady, completionStillCurrent, classifyMembershipFailure } from '../lib/chapterAdministration';
import { settleMemberSupportCommit } from './memberSupportNotice';
import { retainedDraftHandlerNames, retainedDraftStub } from '../testing/retainedDraftStub';
import { useBusinessDraftState } from '../lib/useBusinessDraftState';

const port = vi.hoisted(() => ({ grant: false }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated',
  session: { user: { id: 'person-a' }, access_token: 'fixture-a' }, organizationID: 'org-a',
  dashboard: { member: { id: 'person-a', chapterID: 'chapter-a' } },
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], chapterRoles: ['admin'],
  organizationRoles: port.grant ? ['coordinator'] : [], authorizedRoles: ['admin'],
  resumeDraftReads: { dashboard: true, memberships: true, staff: true },
}) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ userId: 'person-a' }) }));

type Row = { path: string; component: string; name: string; counter: string; args?: unknown[] };
function production(row: Row, context: Record<string, unknown>) {
  const source = readFileSync(new NodeURL(row.path, import.meta.url), 'utf8');
  const f = ts.createSourceFile(row.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = f.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === row.component);
  if (!scope) throw new Error(row.component);
  let expression = '';
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === row.name) expression = n.getText(f);
    if (ts.isVariableDeclaration(n) && n.name.getText(f) === row.name && n.initializer)
      expression = ts.isCallExpression(n.initializer) ? n.initializer.arguments[0]!.getText(f) : n.initializer.getText(f);
    ts.forEachChild(n, visit);
  }
  visit(scope);
  if (!expression) throw new Error(row.name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), context) as (...args: unknown[]) => Promise<unknown>;
}
const readers: Row[] = [
  { path: '../components/ChapterLeadershipCard.tsx', component: 'ChapterLeadershipCard', name: 'refresh', counter: 'reads' },
  { path: './FeatureScreen.tsx', component: 'LivePartnersFeature', name: 'refresh', counter: 'readSequence' },
  { path: './FeatureScreen.tsx', component: 'LiveHealthFeature', name: 'refresh', counter: 'readSequence' },
  { path: './mi1/OperationsHealthScreen.tsx', component: 'OperationsHealthScreen', name: 'refresh', counter: 'reads' },
  { path: './mi1/OrganizationIntelligenceScreens.tsx', component: 'useSnapshot', name: 'retry', counter: 'sequence' },
  { path: './ChapterMembershipsScreen.tsx', component: 'ChapterMembershipsScreen', name: 'readDirectory', counter: 'readSequence', args: ['pay', 1] },
  { path: './StewardDeskSectionsScreen.tsx', component: 'useStewardQueue', name: 'refreshThrough', counter: 'generation', args: [''] },
];
function membershipAcceptanceState() {
  const path = './ChapterMembershipsScreen.tsx';
  const source = readFileSync(new NodeURL(path, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
      && node.name.elements[0]?.getText(file) === 'needsRefresh' && node.initializer) initializer = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file); if (!initializer) throw new Error('Missing membership acceptance state');
  return runInNewContext(ts.transpile(`(${initializer})`, { target: ts.ScriptTarget.ES2022 }), {
    useBusinessDraftState, useBusinessState, useBusinessSubjectState, organizationID: 'org-a',
  }) as [boolean, Dispatch<SetStateAction<boolean>>];
}
const acceptedStates = [
  ['leadership', '../components/ChapterLeadershipCard.tsx', 'accepted', true],
  ['memberships', './ChapterMembershipsScreen.tsx', 'needsRefresh', true],
  ['partners', './FeatureScreen.tsx', 'unconfirmedWrite', true],
  ['map', './mi1/OrganizationIntelligenceScreens.tsx', 'needsRefresh', true],
  ['actions', './mi1/OrganizationIntelligenceScreens.tsx', 'acceptedActions', new Set(['action-a'])],
  ['operations', './mi1/OperationsHealthScreen.tsx', 'needsRefresh', true],
  ['operation keys', './mi1/OperationsHealthScreen.tsx', 'acceptedOperations', new Set(['run-a'])],
  ['support', './MemberSupportScreen.tsx', 'unconfirmedWrite', true],
  ['requests', './StewardDeskSectionsScreen.tsx', 'acceptedRequests', { 'request-a': 'closed' }],
  ['forms', './StewardDeskSectionsScreen.tsx', 'acceptedForms', { 'form-a': 'approve' }],
] satisfies [string, string, string, unknown][];
function acceptedState(path: string, name: string) {
  const source = readFileSync(new NodeURL(path, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
      && node.name.elements[0]?.getText(file) === name && node.initializer) expression = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file); if (!expression) throw new Error(name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), {
    useBusinessDraftState, useBusinessState, useBusinessSubjectState,
    organizationID: 'org-a', chapterID: 'chapter-a', actor: { organizationId: 'org-a', selectedOrganizationId: 'org-a', chapterId: 'chapter-a' },
    scope: { key: 'desk-a' }, selectedMembership: { chapterID: 'chapter-a' }, dashboard: { member: { chapterID: 'chapter-a' } },
  }) as [unknown, Dispatch<SetStateAction<unknown>>];
}
let view: Rendered | null = null;
const releases = new Set<() => void>();
function held() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); releases.add(release); return { promise, release }; }
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
beforeEach(() => { port.grant = false; });
afterEach(async () => { await act(async () => { for (const release of releases) release(); }); releases.clear(); await view?.unmount(); view = null; setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('organization/staff continuation ownership on %s', platform => {
  it('leadership background recovery clears the old read error but keeps acceptance until confirmation', async () => {
    setPlatform(platform); let saved = false; let error: string | null = null;
    let refresh: (...args: unknown[]) => Promise<unknown> = async () => {};
    function Probe() {
      const requests = useBusinessRequests({}); const reads = useRef(0);
      const [accepted, setAccepted] = useBusinessSubjectState('leadership-a', true);
      const [failure, setError] = useBusinessDraftState<string | null>('Could not read leadership.');
      saved = accepted; error = failure;
      refresh = production({ path: '../components/ChapterLeadershipCard.tsx', component: 'ChapterLeadershipCard', name: 'refresh', counter: 'reads' }, {
        requests, reads, setAccepted, setError, setRecovery: vi.fn(),
        loadMobileLeadershipRecovery: async () => ({ claim: null }),
      });
      return null;
    }
    view = await render(h(Probe));
    await act(async () => { await refresh(); }); expect(error).toBeNull(); expect(saved).toBe(true);
    await act(async () => { await refresh(true); }); expect(error).toBeNull(); expect(saved).toBe(false);
  });
  it.each(acceptedStates)('%s retains its accepted baseline across a same-person campaign lead grant', async (_family, path, name, accepted) => {
    setPlatform(platform); let value: unknown; let set: Dispatch<SetStateAction<unknown>> = () => {};
    function Probe() { [value, set] = acceptedState(path, name); return null; }
    view = await render(h(Probe)); const composingSetter = set;
    port.grant = true; await view.rerender(h(Probe));
    await act(async () => { composingSetter(accepted); });
    expect(value).toEqual(accepted);
  });
  it.each(readers.map(row => [row.component + '.' + row.name, row] as const))('%s cannot retire its replacement grant read', async (_name, row) => {
    setPlatform(platform); const wait = held(); let calls = 0;
    const read = async () => { calls++; await wait.promise; return []; };
    const installed = vi.fn(); let run: (...args: unknown[]) => Promise<unknown> = async () => {};
    let counter = { current: 0 };
    function Probe() {
      const requests = useBusinessRequests({}); counter = useRef(0);
      const setters = Object.fromEntries('setNeedsRefresh setRecovery setAccepted setError setItems setTargets setBinding setDocuments setPartnerOrgID setSelectedDocumentID setUnconfirmedWrite setNotice setChapters setSnapshot setState setAuditEvents setJobRows setHeldScope setLoadError setLoading setSubmittedQuery setMembers setNextCursor setPagesLoaded setUserID setRows setTotal setLoadingMore'.split(' ').map(name => [name, installed]));
      run = production(row, { ...setters, requests, [row.counter]: counter,
        loadMobileLeadershipRecovery: read, loadMobileHandshakes: read, loadMobileHandshakeTargets: read,
        loadMobileChapterBinding: read, loadMobileHandshakeDocuments: read, loadMobileHealthPortfolio: read,
        loadMobileOperationsAudit: read, loadMobileOperationsJobHealth: read, loadMobileAdminListedSettingKeys: read,
        loadMobileCompassPlatformOperator: read, loader: read,
        searchMobileAdminMemberDirectory: async () => { await read(); return { members: [], nextCursor: null }; },
        loadPageRef: { current: async () => { await read(); return { rows: [], nextCursor: null, total: 0 }; } },
        failedRefreshRef: { current: null }, cursorRef: { current: null }, loadingMoreRef: { current: false }, rowsRef: { current: [] },
        appendRows: (before: unknown[], after: unknown[]) => [...before, ...after],
        chapterID: 'chapter-a', mounted: { current: true }, live: true, authorized: true,
        UNREAD_HELD_JOB_SCOPE: {}, DIRECTORY_MAX_PAGES: 10, directoryReadIsCurrent, mergeDirectoryPages, retainedMemberSelection,
        copy: { refreshError: 'Could not refresh' }, leadershipFailureCopy: () => 'Could not refresh', leadershipFailureReason: () => 'other',
      });
      return null;
    }
    view = await render(h(Probe)); const old = run;
    port.grant = true; await view.rerender(h(Probe));
    const next = run(...row.args ?? []); await settle(); const at = counter.current, before = calls;
    const obsolete = old(...row.args ?? []); await settle();
    try { expect(counter.current).toBe(at); expect(calls).toBe(before); }
    finally { await act(async () => wait.release()); await next; await obsolete; }
    expect(installed).toHaveBeenCalled();
  });

  it.each([
    ['requests', './StewardDeskSectionsScreen.tsx', 'RequestsSection', 'triage', 'refreshAccepted'],
    ['forms', './StewardDeskSectionsScreen.tsx', 'FormsSection', 'review', 'refreshAccepted'],
    ['map', './mi1/OrganizationIntelligenceScreens.tsx', 'OrganizationIntelligenceScreen', 'mutate', 'refreshView'],
    ['operations', './mi1/OperationsHealthScreen.tsx', 'OperationsHealthScreen', 'remediate', 'refreshView'],
  ] as const)('%s keeps accepted controls withdrawn until a guarded read-only recovery', async (family, path, component, name, recovery) => {
    setPlatform(platform); const write = vi.fn(async () => {}), read = vi.fn(async () => true);
    let proof: 'current' | 'unavailable' = 'unavailable';
    let run: (...args: unknown[]) => Promise<unknown> = async () => {};
    let refresh: (...args: unknown[]) => Promise<unknown> = async () => {};
    let refreshRequired = false;
    const args = family === 'requests' ? [{ id: 'request-a', status: 'requested' }, 'acknowledge']
      : family === 'forms' ? ['form-a', 'Worker', 'approve', null]
      : family === 'map' ? [write] : ['job-a', 'run-a', 'acknowledge'];
    function Probe() {
      const requests = useBusinessRequests({}); const [busy, setBusy] = useBusinessState<string | boolean | null>(false);
      const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
      const [acceptedRows, setAcceptedRows] = useBusinessDraftState<Record<string, string>>({});
      const [acceptedOperations, setAcceptedOperations] = useBusinessDraftState(() => new Set<string>());
      const [needsRefresh, setNeedsRefresh] = useBusinessDraftState(false);
      refreshRequired = Object.keys(acceptedRows).length > 0 || needsRefresh;
      const context = { mode: 'authenticated', requests, busy, operate, needsRefresh, setNeedsRefresh, acceptedOperations, setAcceptedOperations,
        acceptedRequests: acceptedRows, setAcceptedRequests: setAcceptedRows, acceptedForms: acceptedRows, setAcceptedForms: setAcceptedRows, refusedForms: {},
        writer: { check: async () => proof, isCurrent: async () => proof === 'current' },
        setActionError: vi.fn(), setError: vi.fn(), setNotice: vi.fn(), setOpenID: vi.fn(), setNote: vi.fn(),
        triageStewardRequest: write, reviewStewardForm: write, acknowledgeMobileOperationsJob: write, requestMobileOperationsJobRetry: write,
        queue: { reread: read, refreshThrough: read }, retry: read, refresh: read,
        haptics: { success: vi.fn() }, t: (line: string) => line, note: '',
        BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite,
        StewardFormChangedError: class extends Error {}, StewardFormReturnBlockedError: class extends Error {}, isMfaRequiredRpcError: () => false,
      };
      run = production({ path, component, name, counter: '' }, context);
      // The original has no recovery, so assert accepted withdrawal first.
      refresh = async () => production({ path, component, name: recovery, counter: '' }, context)();
      return h('button', { disabled: Boolean(busy) }, 'Refresh');
    }
    view = await render(h(Probe));
    await act(async () => { await run(...args); });
    expect(refreshRequired).toBe(true);
    await act(async () => { await run(...args); }); expect(write).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    proof = 'current'; const wait = held(); read.mockImplementation(async () => { await wait.promise; return true; });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = refresh(); }); await settle();
    expect(view.container.querySelector('button')!.disabled).toBe(true);
    await act(async () => { wait.release(); await pending; });
    expect(refreshRequired).toBe(false); expect(write).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
  });

  it('Worker Support keeps an accepted reread newer than its initial background load', async () => {
    setPlatform(platform); const initial = held(); const model = vi.fn(); let calls = 0;
    const loadWorkspace = async () => { if (++calls === 1) { await initial.promise; return { state: 'ready', marker: 'old' }; } return { state: 'ready', marker: 'accepted' }; };
    let commit: (...args: unknown[]) => Promise<unknown> = async () => {};
    let start: () => (() => void) | void = () => {};
    function Probe() {
      const requests = useBusinessRequests({}); const workspaceReads = useRef(0);
      const [busy, setBusy] = useBusinessState(false); const [control] = useBusinessState(() => ({ current: false }));
      const context = { mode: 'authenticated', requests, workspaceReads, control, unconfirmedWrite: false, setBusy,
        setUnconfirmedWrite: vi.fn(), publishNotice: vi.fn(), setModel: model, loadWorkspace, adapter: {}, actor: {},
        writer: { check: async () => 'current', isCurrent: async () => true },
        checkBusinessContinuation, settleMemberSupportCommit, BUSINESS_SAVED_STALE, t: (line: string) => line,
        haptics: { success: vi.fn(), warning: vi.fn() },
      };
      commit = production({ path: './MemberSupportScreen.tsx', component: 'MemberSupportScreen', name: 'commit', counter: 'workspaceReads' }, context);
      const source = readFileSync(new NodeURL('./MemberSupportScreen.tsx', import.meta.url), 'utf8');
      const f = ts.createSourceFile('MemberSupportScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let expression = '';
      function visit(n: ts.Node) {
        if (ts.isCallExpression(n) && n.expression.getText(f) === 'useEffect' && n.arguments[0]?.getText(f).includes('void loadWorkspace(adapter, actor)')) expression = n.arguments[0].getText(f);
        ts.forEachChild(n, visit);
      }
      visit(f); if (!expression) throw new Error('Initial support load effect missing');
      start = runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), context) as typeof start;
      return h('button', { disabled: busy }, 'Save');
    }
    view = await render(h(Probe)); const cleanup: { current: (() => void) | void } = { current: undefined };
    await act(async () => { cleanup.current = start(); });
    await act(async () => { await commit(async () => {}, 'Saved'); });
    expect(model.mock.calls.at(-1)?.[0]).toEqual({ state: 'ready', marker: 'accepted' });
    await act(async () => initial.release()); await settle();
    expect(model.mock.calls.at(-1)?.[0]).toEqual({ state: 'ready', marker: 'accepted' });
    if (cleanup.current) cleanup.current();
  });

  it.each<'unavailable' | 'grant'>(['unavailable', 'grant'])('membership acceptance blocks a repeated change until a guarded directory Refresh (%s)', async boundary => {
    setPlatform(platform); let proof: 'current' | 'unavailable' = boundary === 'unavailable' ? 'unavailable' : 'current';
    const acknowledgement = held();
    const write = vi.fn(async () => { if (boundary === 'grant') await acknowledgement.promise; }), read = vi.fn(async () => true);
    let run: (...args: unknown[]) => Promise<unknown> = async () => {};
    let refresh: () => Promise<unknown> = async () => {};
    let required = false;
    function Probe() {
      const requests = useBusinessRequests({});
      const [busy, setBusy] = useBusinessState<string | null>(null);
      const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
      const [needsRefresh, setNeedsRefresh] = membershipAcceptanceState(); required = needsRefresh;
      const context = { mode: 'authenticated', requests, busy, operate, needsRefresh, setNeedsRefresh,
        userID: 'member-a', chapterID: 'chapter-a', selected: { fullName: 'Worker' }, pagesLoaded: 1, submittedQuery: '',
        target: { current: { userID: 'member-a', chapterID: 'chapter-a' } }, mounted: { current: true },
        writer: { check: async () => proof }, chapterMembershipTargetReady, completionStillCurrent, classifyMembershipFailure,
        checkBusinessContinuation, readDirectory: async () => { const okay = await read(); if (okay) setNeedsRefresh(false); return okay; }, setMessage: vi.fn(), report: vi.fn(),
        setConfirmingRevoke: vi.fn(), setUnitID: vi.fn(), setUnitRevision: vi.fn(), haptics: { success: vi.fn() },
      };
      run = production({ path: './ChapterMembershipsScreen.tsx', component: 'ChapterMembershipsScreen', name: 'act', counter: '' }, context);
      refresh = async () => production({ path: './ChapterMembershipsScreen.tsx', component: 'ChapterMembershipsScreen', name: 'refreshAccepted', counter: '' }, context)();
      return h('button', { disabled: Boolean(busy) }, 'Refresh');
    }
    view = await render(h(Probe));
    const save = () => run('role-grant', write, 'role-granted', 'refused-role', 'unconfirmed-role');
    let saved: Promise<unknown> = Promise.resolve();
    await act(async () => { saved = save(); });
    if (boundary === 'grant') {
      port.grant = true; await view.rerender(h(Probe));
      expect(view.container.querySelector('button')!.disabled).toBe(true);
    }
    await act(async () => { acknowledgement.release(); await saved; }); expect(required).toBe(true);
    await act(async () => { await save(); }); expect(write).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    proof = 'current'; const wait = held(); read.mockImplementation(async () => { await wait.promise; return true; });
    let pending: Promise<unknown> = Promise.resolve(); await act(async () => { pending = refresh(); });
    expect(view.container.querySelector('button')!.disabled).toBe(true);
    await act(async () => { wait.release(); await pending; });
    expect(required).toBe(false); expect(write).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
  });

  it('organization guide keeps its composing control held through write and proof', async () => {
    setPlatform(platform); const write = held(), proof = held(); const writes = vi.fn(async () => { await write.promise; return { saved: true }; });
    let run: (work: () => Promise<unknown>) => Promise<unknown> = async () => {};
    function Probe() {
      const requests = useBusinessRequests({}); const [busy, setBusy] = useBusinessState(false);
      const [operate] = useBusinessOperation<typeof busy>(setBusy, false); const epoch = useRef(0);
      run = production({ path: './guideLayers/GuideLayers.tsx', component: 'useOrganizationStartGuide', name: 'run', counter: 'epoch' }, {
        requests, operate, epoch, setState: vi.fn(), setNotice: vi.fn(),
        writer: { check: async () => { await proof.promise; return 'current'; } }, settleBusinessWrite, BUSINESS_SAVED_STALE,
      });
      return h('button', { disabled: busy }, 'Save');
    }
    view = await render(h(Probe)); let first: Promise<unknown> = Promise.resolve(), second: Promise<unknown> = Promise.resolve();
    await act(async () => { first = run(writes); second = run(writes); });
    try {
      expect(writes).toHaveBeenCalledOnce(); expect(view.container.querySelector('button')!.disabled).toBe(true);
      await act(async () => write.release()); await settle();
      expect(view.container.querySelector('button')!.disabled).toBe(true);
    } finally { await act(async () => { write.release(); proof.release(); await first; await second; }); }
    expect(view.container.querySelector('button')!.disabled).toBe(false);
  });
});

// Ledger 689, 690 and 691 (stage 511 on #9429). The partners and health
// refreshes report whether their read loaded, failed or was superseded; a
// write's follow-up confirms with the success haptic only after a loaded
// read, and a failed one leaves the saved-stale notice. The connections
// panel's return to partners does nothing once its workspace ticket retired.
type RefreshResult = 'loaded' | 'failed' | 'superseded';
type Production = (...args: unknown[]) => Promise<unknown>;
const partnersRow = (name: string): Row => ({ path: './FeatureScreen.tsx', component: 'LivePartnersFeature', name, counter: 'readSequence' });
const healthRow = (name: string): Row => ({ path: './FeatureScreen.tsx', component: 'LiveHealthFeature', name, counter: 'readSequence' });
const partnerWrites: [string, unknown[]][] = [
  ['transition', [{ id: 'handshake-a' }, 'accept']],
  ['sendRequest', []],
  ['requestBinding', []],
  ['shareDocument', ['handshake-a']],
];
describe.each<'ios' | 'android'>(['ios', 'android'])('partners and health follow-up results on %s', platform => {
  it.each([['partners', partnersRow('refresh')], ['health', healthRow('refresh')]] satisfies [string, Row][])('%s refresh reports a loaded, failed or superseded read', async (_screen, row) => {
    setPlatform(platform); const gate = held(); let failing = false; let holding = false;
    const read = async (): Promise<unknown[]> => { if (holding) await gate.promise; if (failing) throw new Error('offline'); return []; };
    let refresh: Production = async () => undefined;
    function Probe() {
      const requests = useBusinessRequests({}); const readSequence = useRef(0);
      const setters = Object.fromEntries('setError setItems setTargets setBinding setDocuments setPartnerOrgID setSelectedDocumentID setUnconfirmedWrite setNotice setChapters'.split(' ').map((name): [string, () => void] => [name, () => undefined]));
      refresh = production(row, { ...setters, requests, readSequence, chapterID: 'chapter-a', copy: { refreshError: 'Could not refresh' }, BUSINESS_SAVED_STALE,
        // #9240 pull request C: a failed read hands its error to the held drafts.
        refusedDrafts: { current: () => undefined },
        loadMobileHandshakes: read, loadMobileHandshakeTargets: read, loadMobileChapterBinding: read, loadMobileHandshakeDocuments: read, loadMobileHealthPortfolio: read });
      return null;
    }
    view = await render(h(Probe));
    let result: unknown;
    await act(async () => { result = await refresh(); }); expect(result).toBe<RefreshResult>('loaded');
    failing = true; await act(async () => { result = await refresh(); }); expect(result).toBe<RefreshResult>('failed');
    failing = false; holding = true; let older: Promise<unknown> = Promise.resolve();
    await act(async () => { older = refresh(); }); holding = false;
    await act(async () => { result = await refresh(); }); expect(result).toBe<RefreshResult>('loaded');
    await act(async () => { gate.release(); result = await older; }); expect(result).toBe<RefreshResult>('superseded');
  });

  it.each(partnerWrites)('partners %s confirms with the success haptic only after a loaded follow-up read', async (name, args) => {
    setPlatform(platform);
    for (const [refreshResult, notice, haptic] of [['loaded', 'The change was saved.', 1], ['failed', BUSINESS_SAVED_STALE, 0], ['superseded', 'The change was saved.', 0]] satisfies [RefreshResult, string, number][]) {
      const success = vi.fn(); const setNotice = vi.fn(); let run: Production = async () => undefined;
      const write = vi.fn(async () => undefined);
      function Probe() {
        const requests = useBusinessRequests({}); const [, setBusy] = useBusinessState<string | null>(null);
        const [operate] = useBusinessOperation<string | null>(setBusy, null);
        run = production(partnersRow(name), {
          requests, operate, unconfirmedWrite: false, writer: { check: async () => 'current' },
          handshakes: { transition: write, request: write, shareDocument: write }, requestMobileChapterBinding: write,
          partnerOrgID: 'org-b', title: 'Shared grievance files', purpose: 'Coordinate the joint filing', dataScope: 'docs_only',
          selectedOrganizationID: 'org-b', selectedDocumentID: 'document-a',
          setError: vi.fn(), setNotice, setUnconfirmedWrite: vi.fn(), setConfirming: vi.fn(), setTitle: vi.fn(), setPurpose: vi.fn(), setDataScope: vi.fn(), setComposing: vi.fn(),
          copy: { transitionError: 'x', requestError: 'x', bindingRequestError: 'x', bindingRequested: 'Binding requested', documentError: 'x', documentShared: 'Document shared' },
          refresh: async (): Promise<RefreshResult> => refreshResult, haptics: { success },
          settleBusinessWrite, checkBusinessContinuation, BUSINESS_SAVED_STALE,
          // #9240 pull request C: the held request the screen hands its send.
          partnership: retainedDraftStub({ open: true, partnerOrgID: 'org-b', title: 'Shared grievance files', purpose: 'Coordinate the joint filing', dataScope: 'docs_only' }),
          requestMobileHandshake: write, ...retainedDraftHandlerNames,
        });
        return null;
      }
      view = await render(h(Probe));
      await act(async () => { await run(...args); });
      expect(write).toHaveBeenCalledOnce();
      expect(setNotice).toHaveBeenLastCalledWith(notice);
      expect(success).toHaveBeenCalledTimes(haptic);
      await view.unmount(); view = null;
    }
  });

  it('the connections panel return does nothing once its workspace ticket retired', async () => {
    setPlatform(platform);
    for (const current of [false, true]) {
      const setNotice = vi.fn(), queueAnnouncement = vi.fn(), setShowConnections = vi.fn(), refresh = vi.fn(async (): Promise<RefreshResult> => 'loaded');
      const returned = production(partnersRow('handshakeReturned'), {
        handshakeTicket: { isCurrent: () => current }, setNotice, queueAnnouncement, setShowConnections, refresh, connectionTr: (key: string) => key,
      });
      await returned({ noticeKey: 'handshakeSent' });
      expect(setNotice).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(queueAnnouncement).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(setShowConnections).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(refresh).toHaveBeenCalledTimes(current ? 1 : 0);
    }
  });
});
