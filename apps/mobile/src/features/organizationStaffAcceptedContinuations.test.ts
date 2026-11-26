vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: vi.fn() }));
import { retainedDraftHandlerNames, retainedDraftStub } from '../testing/retainedDraftStub';
import { businessHandlerContext } from '../testing/businessHandlerContext';
// Part B of record 9254: extracted without changing assertions from businessAcceptedContinuations.test.ts
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';

import { nativeUiText } from '../lib/nativeUiCopy';
import { createRequestGeneration } from '../lib/requestGeneration';

function callback(path: string, container: string, name: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let scope: ts.Node | undefined;
  function find(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === container) scope = node; else ts.forEachChild(node, find); }
  find(tree);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]!.getText(tree) : node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  }
  if (!scope) throw new Error(container);
  visit(scope);
  if (!expression) throw new Error(name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), businessHandlerContext({ mounted: { current: true }, confirmedOwner: { workspace: 'scope-a' }, requests: createRequestGeneration(), settleBusinessWrite, checkBusinessContinuation, BUSINESS_SAVED_STALE, workspaceReads: { current: 0 }, acceptedRequests: {}, setAcceptedRequests: vi.fn(), acceptedForms: {}, setAcceptedForms: vi.fn(), setNeedsRefresh: vi.fn(), needsRefresh: false, ...context }, container)) as (...args: unknown[]) => Promise<unknown>;
}
const writer = (proof: 'current' | 'changed' | 'unavailable') => ({ check: async () => proof, isCurrent: async () => proof === 'current' });
const identity = (text: string) => text;

function receipt(path: string, container: string, condition: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let scope: ts.Node | undefined; let expression = '';
  function find(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === container) scope = node; else ts.forEachChild(node, find); }
  find(tree); if (!scope) throw new Error(container);
  function visit(node: ts.Node) {
    if (ts.isConditionalExpression(node) && node.condition.getText(tree) === condition && node.getText(tree).includes('<')) expression = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(scope); if (!expression) throw new Error(condition);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }), {
    React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
    Body: 'Body', Text: 'Text', Failure: 'Failure', Card: 'Card', Notice: 'Notice',
    BUSINESS_SAVED_STALE, nativeUiText, t: nativeUiText('es'), language: 'es',
    theme: { primary: '#3D2A4F', destructive: '#9A1B1B' }, styles: { error: {} }, setActionError: () => {}, ...context,
  }) as unknown;
}

describe('stage 413 accepted writes and three-state proof', () => {
  it.each([
['./StewardDeskSectionsScreen.tsx', 'RequestsSection', 'actionError', { actionError: BUSINESS_SAVED_STALE }],
['./MemberSupportScreen.tsx', 'MemberSupportScreen', '!notice.message', { notice: { message: BUSINESS_SAVED_STALE, tone: 'success', attempt: 1 } }]
])('delta P3-3: %s %s renders a Spanish saved receipt without failure treatment', (path, owner, condition, context) => {
    const rendered = receipt(String(path), String(owner), String(condition), context as Record<string, unknown>);
    const text = JSON.stringify(rendered);
    expect(text).toContain(nativeUiText('es')(BUSINESS_SAVED_STALE)); expect(text).not.toContain('#9A1B1B'); expect(text).not.toContain('"Failure"');
  });

  it.each([
'triage'
])('%s never rereads the shared client after accepted/unavailable proof', async (family) => {
    const reload = vi.fn(); const notice = vi.fn();
    const context = { writer: writer('unavailable'), setReload: reload, setNotice: notice, setActionError: notice, setBusy: vi.fn(), setSending: vi.fn(), setBusyID: vi.fn(), setCategory: vi.fn(), setTitle: vi.fn(), setDetails: vi.fn(),
      campaignKey: () => 'campaign', changeCampaign: async () => {}, CAMPAIGN_CONFIRM: { publish: { done: 'Published' } },
      sendBeHeardReport: async () => {}, problem: null, sending: false, category: 'question', title: 'Question', details: 'Details',
      triageStewardRequest: async () => {}, haptics: { success: vi.fn() }, t: identity };
    const run = family === 'campaign' ? callback('./LiveFeatureScreens.tsx', 'LiveCampaignsScreen', 'run', context)
      : family === 'report' ? callback('./LiveFeatureScreens.tsx', 'LiveBeHeardScreen', 'send', context)
        : callback('./StewardDeskSectionsScreen.tsx', 'RequestsSection', 'triage', context);
    await run(...(family === 'campaign' ? ['publish', { id: 'campaign' }] : family === 'triage' ? [{ id: 'request' }, 'acknowledge'] : []));
    expect(reload).not.toHaveBeenCalled(); expect(notice.mock.calls.some(([line]) => JSON.stringify(line).includes('saved'))).toBe(true);
  });

  it.each([
'transition',
'sendRequest',
'saveSnapshot',
'saveCoaching'
])('r2s2: %s keeps a visible accepted receipt without shared reads', async (name) => {
    const refresh = vi.fn(); const notice = vi.fn();
    const run = callback('./FeatureScreen.tsx', name.startsWith('save') ? 'LiveHealthFeature' : 'LivePartnersFeature', name, {
      writer: writer('unavailable'), handshakes: { transition: async () => {}, request: async () => {} },
      partnerOrgID: 'org', title: 'Title', purpose: 'Purpose', dataScope: 'docs_only',
      setBusy: vi.fn(), setError: vi.fn(), setNotice: notice, setConfirming: vi.fn(), setTitle: vi.fn(), setPurpose: vi.fn(), setDataScope: vi.fn(), setComposing: vi.fn(),
      copy: { transitionError: 'failed', requestError: 'failed' }, refresh, haptics: { success: vi.fn() },
      snapshotChapter: 'chapter', chapters: [{ chapterId: 'chapter', databaseDate: '2026-11-20' }], snapshotMode: 'new', measuredOn: '2026-11-20', driverDraft: {},
      healthDriversFromDraft: () => ({}), validHealthDate: () => true, recordMobileHealthSnapshot: async () => {}, closeSnapshot: vi.fn(),
      coachingChapter: 'chapter', summary: 'Summary', nextAction: 'Next', attentionLevel: 'watch', addMobileHealthCoaching: async () => {}, closeCoaching: vi.fn(),
      // #9240 pull request C: the held drafts the screens hand their writes.
      partnership: retainedDraftStub({ open: true, partnerOrgID: 'partner', title: 'Title', purpose: 'Purpose', dataScope: 'docs_only' }), requestMobileHandshake: async () => {}, ...retainedDraftHandlerNames,
      snapshot: retainedDraftStub({ chapter: 'chapter', mode: 'new', measuredOn: '2026-11-20', drivers: {}, basis: null }), coaching: retainedDraftStub({ chapter: 'chapter', summary: 'Summary', nextAction: 'Next', attentionLevel: 'support' }), 
    });
    await run({ id: 'handshake' }, 'accept');
    expect(notice).toHaveBeenCalledWith(BUSINESS_SAVED_STALE); expect(refresh).not.toHaveBeenCalled();
  });

  it('r2s2: organization guide keeps the server-returned payload when proof is unavailable', async () => {
    const state = vi.fn(); const notice = vi.fn(); const payload = { milestone: 'done' }; const requests = createRequestGeneration();
    const run = callback('./guideLayers/GuideLayers.tsx', 'useOrganizationStartGuide', 'run', {
      writer: writer('unavailable'), epoch: { current: 0 }, setState: state, setNotice: notice, requests,
    });
    await run(async () => payload);
    expect(state).toHaveBeenCalledWith({ owner: requests, payload }); expect(notice).toHaveBeenCalledWith(BUSINESS_SAVED_STALE);
  });
});
