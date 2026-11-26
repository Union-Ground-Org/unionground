vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: vi.fn() }));
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { businessHandlerContext } from '../testing/businessHandlerContext';
// Part B of record 9254: extracted without changing assertions from businessScopeContinuations.test.ts
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createRequestGeneration } from '../lib/requestGeneration';

// Run the actual source callbacks with held transport replies. Scope retirement
// is the same request generation used by the mounted components; no duplicate
// implementation of their continuation rules is under test.
function callback(path: string, container: string, name: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === container);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]!.getText(tree) : node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  if (!scope) throw new Error(container);
  visit(scope);
  if (!expression) throw new Error(name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), businessHandlerContext({ reads: { current: 0 }, checkBusinessContinuation, requests: createRequestGeneration(), setNeedsRefresh: vi.fn(), ...context }, container)) as (...args: unknown[]) => Promise<void>;
}
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('confirmed census continuation families', () => {

  it.each([false, true])('connection run drops retired reload and feedback, retired=%s', async (retired) => {
    const held = deferred(); const requests = createRequestGeneration(); const load = vi.fn(async () => ({})); const notice = vi.fn();
    const run = callback('./mi1/ConnectionSuggestionsPanel.tsx', 'ConnectionSession', 'run', {
      requests, reloadControllers: { current: new Set<AbortController>() }, writer: { check: async () => 'current' }, lifetime: { current: new AbortController() }, AbortController, operationActive: { current: false }, allowed: true, data: { workspace: { canPublish: true } },
      setBusy: vi.fn(), setNotice: notice, setData: vi.fn(), setState: vi.fn(), adapter: { load }, tr: (key: string) => key,
      connectionFailureState: () => 'error',
    });
    const pending = run('publish', () => held.promise, 'saved', 'failed');
    if (retired) requests.dispose(); held.resolve(); await pending;
    expect(load).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(notice.mock.calls.some(([value]) => value === 'saved')).toBe(true);
  });

  it.each(['review', 'restore', 'requestHandshake'])('connection %s never adopts the replacement lifetime', async (name) => {
    const held = deferred(); const requests = createRequestGeneration(); const clear = vi.fn(); const setData = vi.fn(); const sent = vi.fn();
    const hide = vi.fn(() => held.promise);
    const context = {
      preview: false, requests, lifetime: { current: new AbortController() }, allowed: true, requestTarget: { id: 'target', handshake: { eligible: true } },
      data: { workspace: { chapterId: 'chapter-A', canRequestHandshake: true, hiddenChapterIds: ['one', 'two'] } },
      adapter: { hide, reviewSource: () => held.promise, requestHandshake: () => held.promise }, setData, setNotice: vi.fn(),
      connectionHandshakeOutcome: () => 'sent', tr: (key: string) => key, onHandshakeRequested: sent,
      run: async (_key: string, operation: (current: () => boolean) => Promise<void>) => operation(requests.capture().isCurrent),
    };
    const action = callback('./mi1/ConnectionSuggestionsPanel.tsx', 'ConnectionSession', name, context);
    // review/restore fire-and-forget; drain the same held operation afterwards.
    const pending = action({ sourceKind: 'topic', sourceId: 'id', topicKeys: [] }, clear);
    requests.dispose(); held.resolve({}); await pending; await Promise.resolve();
    expect(clear).not.toHaveBeenCalled(); expect(setData).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
    if (name === 'restore') expect(hide).toHaveBeenCalledOnce();
  });

  it.each(['current', 'unavailable', 'changed'])('operations distinguish accepted writes from %s continuation proof', async (proof) => {
    const refresh = vi.fn(); const error = vi.fn();
    const run = callback('./mi1/OperationsHealthScreen.tsx', 'OperationsHealthScreen', 'remediate', {
      writer: { check: async () => proof, isCurrent: async () => proof === 'current' }, mounted: { current: true }, setBusyJobName: vi.fn(), setError: error,
      acknowledgeMobileOperationsJob: async () => {}, refresh, isMfaRequiredRpcError: () => false,
    });
    await run('job', 'run', 'acknowledge');
    expect(refresh).toHaveBeenCalledTimes(proof === 'current' ? 1 : 0);
    expect(error.mock.calls.some(([value]) => typeof value === 'string' && value.includes('saved'))).toBe(proof === 'unavailable');
  });
});
