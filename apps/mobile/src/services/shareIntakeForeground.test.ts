import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { SecureShareCleanupBoundary } from './secureShareIntake';
import { nativeCatalogLabel, nativeUiText } from '../lib/nativeUiCopy';

it('localizes the exact-upload retry busy label in Spanish', () => {
  const label = screen.match(/label=\{busy \? (.*?) : 'Check exact upload again'\}/)?.[1];
  expect(label).toBeTruthy();
  expect(runInNewContext(label!, { t: nativeUiText('es') })).toBe('Comprobando…');
  expect(nativeCatalogLabel('en', 'Checking…')).toBe('Checking…');
});

function shareCallback(name: string) {
  const tree = ts.createSourceFile('share-intake.tsx', screen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      callback = node.initializer.arguments[0]?.getText(tree) ?? '';
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!callback) throw new Error(`Missing share callback ${name}`);
  return ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 });
}

function operationPort(setBusy: (value: boolean) => void = vi.fn()) {
  const source = readFileSync(new URL('../lib/useBusinessWriter.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('operation.ts', source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find((value: ts.Statement) => ts.isFunctionDeclaration(value) && value.name?.text === 'completeBusinessOperation');
  if (!node) throw new Error('Missing shared operation');
  const complete = runInNewContext(ts.transpile(`${node.getText(tree).replace(/^export /, '')}; completeBusinessOperation;`, { target: ts.ScriptTarget.ES2022 })) as
    (lock: { current: boolean }, active: boolean, idle: boolean, setBusy: (value: boolean) => void, work: () => Promise<void>) => Promise<void>;
  const lock = { current: false };
  return { lock, runOperation: (active: boolean, work: () => Promise<void>) => complete(lock, active, false, setBusy, work) };
}

it('runs a successor load after a foreground request cancels an older pending read', async () => {
  const tree = ts.createSourceFile('share.tsx', screen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let requested = ''; let worker = '';
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect') {
      const source = node.arguments[0]?.getText(tree) ?? '';
      if (source.includes('readPendingSharedAttachmentUploadRecovery')) worker = source;
      else if (source.includes('setLoadRequested(true)')) requested = source;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const held = deferred();
  const recovery = vi.fn().mockImplementationOnce(async () => { await held.promise; return null; }).mockResolvedValue(null);
  const targets = [{ kind: 'case', id: 'new-case', title: 'New record' }];
  const setTargets = vi.fn(); const loadTargets = vi.fn(async () => targets);
  let env: Record<string, unknown>;
  const operation = operationPort(value => { env.busy = value; });
  env = {
    ...operation, busy: false, loadRequested: true, mode: 'authenticated', locked: false, privacyCovered: false, foregroundReady: true,
    interrupted: { current: false }, loadGeneration: { current: 0 }, mounted: { current: true }, session: { user: { id: 'member-a' } },
    recoveredUpload: { current: null }, recoveryInFlight: { current: 0 }, recoveryBlocked: { current: false },
    committed: { current: false }, uploadCompleted: { current: false }, uploadAttempted: { current: false }, liveStaffHat: null,
    setLoadRequested: (value: boolean) => { env.loadRequested = value; },
    setTargets, setSelectedKey: vi.fn(), setQuery: vi.fn(), setLoadingError: vi.fn(), setUploadError: vi.fn(), setCurrentPending: vi.fn(),
    setCleanupRequired: vi.fn(), setRemoteCleanupUnconfirmed: vi.fn(), setRetryRequiresReshare: vi.fn(), setReauthRequired: vi.fn(),
    getPendingSharedAttachmentUpload: () => null, captureSecureShareCleanupBoundary: vi.fn(),
    captureSessionWriter: () => ({ check: async () => 'current' }), t: (text: string) => text,
    readPendingSharedAttachmentUploadRecovery: recovery, readPendingSharedAttachment: async () => ({ token: 'new-file' }),
    loadAuthorizedShareTargets: loadTargets,
  };
  const run = runInNewContext(ts.transpile(`(${worker})`, { target: ts.ScriptTarget.ES2022 }), env) as () => void;
  const request = runInNewContext(ts.transpile(`(${requested})`, { target: ts.ScriptTarget.ES2022 }), env) as () => void;
  run(); await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1));
  request(); run();
  expect(env.loadRequested).toBe(true);
  held.resolve(); await vi.waitFor(() => expect(operation.lock.current).toBe(false));
  run(); await vi.waitFor(() => expect(setTargets).toHaveBeenCalledWith(targets));
  expect(recovery).toHaveBeenCalledTimes(2);
  expect(loadTargets).toHaveBeenCalledTimes(1);
  expect(env.loadRequested).toBe(false);
});

// Execute the screen's actual callback, as the provider-handler tests do.
// Controlled native completions are unit evidence, not physical-device proof.
const screen = readFileSync(new URL('../../app/share-intake.tsx', import.meta.url), 'utf8');
const callback = screen.match(/function observeAppState\(state: AppStateStatus \| null\) \{([\s\S]*?)\n    \}\n    const subscription/)?.[0]
  .replace(/\n    const subscription$/, '');
if (!callback) throw new Error('Share screen AppState callback was not found');
const executable = ts.transpile(`${callback}; observeAppState;`, { target: ts.ScriptTarget.ES2022 });

function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('share result belongs to its presenting screen', () => {
  function presentation() {
    const acknowledgement = deferred();
    const env = {
      ...operationPort(),
      mounted: { current: true }, busy: false, loadingError: null,
      pendingRef: { current: { token: 'share-a' } },
      committed: { current: false }, recoveryBlocked: { current: true },
      recoveredUpload: { current: null }, uploadCompleted: { current: true }, uploadAttempted: { current: true },
      acknowledgePendingSharedAttachmentUpload: vi.fn(async () => { await acknowledgement.promise; return true; }),
      discardPendingSharedAttachment: vi.fn(async () => acknowledgement.promise),
      captureSecureShareCleanupBoundary: vi.fn(), discardPendingSharedAttachmentCreatedAtOrBefore: vi.fn(),
      setCleanupRequired: vi.fn(), setUploadError: vi.fn(), setLoadingError: vi.fn(),
      setRemoteCleanupUnconfirmed: vi.fn(), setRetryRequiresReshare: vi.fn(), setCurrentPending: vi.fn(),
      queueAccessibilityAnnouncement: vi.fn(), haptics: { success: vi.fn(), warning: vi.fn() },
      router: { replace: vi.fn() },
    };
    const complete = runInNewContext(shareCallback('completePresentedUpload'), env) as (operation: { attachmentID: string; target: { kind: string; id: string }; token: string }) => Promise<boolean>;
    const abandon = runInNewContext(shareCallback('abandon'), env) as () => Promise<void>;
    return { env, acknowledgement, complete, abandon };
  }

  it.each([false, true])('suppresses completed upload navigation after its screen retires: %s', async (retired) => {
    const run = presentation();
    const pending = run.complete({ attachmentID: 'attachment-a', target: { kind: 'case', id: 'case-a' }, token: 'share-a' });
    run.env.mounted.current = !retired;
    run.acknowledgement.resolve();
    await pending;
    expect(run.env.router.replace.mock.calls).toEqual(retired ? [] : [['/issue/case-a']]);
    expect(run.env.queueAccessibilityAnnouncement).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(run.env.acknowledgePendingSharedAttachmentUpload).toHaveBeenCalledTimes(1);
  });

  it('does not navigate after the owner leaves while abandoning staged bytes', async () => {
    const run = presentation();
    const pending = run.abandon();
    run.env.mounted.current = false;
    run.acknowledgement.resolve();
    await pending;
    expect(run.env.discardPendingSharedAttachment).toHaveBeenCalledWith('share-a');
    expect(run.env.router.replace).not.toHaveBeenCalled();
  });

  it('holds the shared lock through staged cleanup and refuses a retained duplicate discard', async () => {
    const run = presentation();
    const first = run.abandon(); const second = run.abandon();
    expect(run.env.discardPendingSharedAttachment).toHaveBeenCalledTimes(1);
    expect(run.env.lock.current).toBe(true);
    run.acknowledgement.resolve(); await Promise.all([first, second]);
    expect(run.env.lock.current).toBe(false);
    expect(run.env.router.replace).toHaveBeenCalledTimes(1);
  });
});

function fixture() {
  const staged = new Set(['share-A']);
  let sequence = 0;
  const pendingRef: { current: { token: string } | null } = { current: { token: 'share-A' } };
  const interruptedCleanupBoundary: { current: SecureShareCleanupBoundary | null } = { current: null };
  const captureSecureShareCleanupBoundary = vi.fn(() => ({
    sequence: ++sequence,
    capturedTokens: Promise.resolve([...staged]),
  }));
  const discardPendingSharedAttachment = vi.fn(async (token: string) => { staged.delete(token); });
  const discardPendingSharedAttachmentCreatedAtOrBefore = vi.fn(async (boundary: SecureShareCleanupBoundary) => {
    for (const token of await boundary.capturedTokens) staged.delete(token);
  });
  const env = {
    session: { user: { id: 'member-a' } },
    Error,
    observedActive: { current: true }, committed: { current: false },
    interrupted: { current: false }, interruptedCleanupBoundary, pendingRef,
    mounted: { current: true }, loadGeneration: { current: 0 },
    recoveryInFlight: { current: 0 }, recoveryBlocked: { current: false },
    uploadPresentationGate: { setReady: vi.fn() },
    setForegroundReady: vi.fn(), setForegroundEpoch: vi.fn(), setLoadingError: vi.fn(),
    setCurrentPending: (next: { token: string } | null) => { pendingRef.current = next; },
    getPendingSharedAttachmentUpload: () => null,
    captureSecureShareCleanupBoundary, discardPendingSharedAttachment,
    discardPendingSharedAttachmentCreatedAtOrBefore,
  };
  const handle = runInNewContext(executable, env) as (state: 'active' | 'background') => void;
  return { staged, env, handle };
}

describe('share intake foreground cleanup ownership', () => {
  it('retains the old boundary after background cleanup so a newly shared item survives return', async () => {
    const { staged, env, handle } = fixture();
    handle('background');
    const oldBoundary = env.interruptedCleanupBoundary.current;
    await flush();
    expect(staged.has('share-A')).toBe(false);
    staged.add('share-B');
    handle('active');
    await flush();
    expect(staged.has('share-B')).toBe(true);
    expect(env.captureSecureShareCleanupBoundary).toHaveBeenCalledTimes(1);
    expect(env.discardPendingSharedAttachmentCreatedAtOrBefore).toHaveBeenCalledWith(oldBoundary);
    expect(env.interrupted.current).toBe(false);
    expect(env.setForegroundReady).toHaveBeenLastCalledWith(true);
  });

  it.each<'resolve' | 'reject'>(['resolve', 'reject'])(
    'ignores an old background completion (%s) after a new interruption owns cleanup', async (completion) => {
      const { staged, env, handle } = fixture();
      const oldCleanup = deferred();
      const newerCleanup = deferred();
      env.discardPendingSharedAttachment
        .mockImplementationOnce(async () => oldCleanup.promise)
        .mockImplementationOnce(async () => newerCleanup.promise);
      handle('background');
      handle('active');
      await flush();
      staged.add('share-B');
      env.pendingRef.current = { token: 'share-B' };
      env.committed.current = false;
      handle('background');
      const newerBoundary = env.interruptedCleanupBoundary.current;
      const messages = env.setLoadingError.mock.calls.length;
      if (completion === 'resolve') oldCleanup.resolve();
      else oldCleanup.reject(new Error('old cleanup failure'));
      await flush();
      expect(env.interruptedCleanupBoundary.current).toBe(newerBoundary);
      expect(env.committed.current).toBe(false);
      expect(env.setLoadingError).toHaveBeenCalledTimes(messages);
      newerCleanup.resolve();
      await flush();
    },
  );

  it('does not publish an old foreground completion over a newer background boundary', async () => {
    const { staged, env, handle } = fixture();
    const oldReturn = deferred();
    const newerCleanup = deferred();
    handle('background');
    await flush();
    env.discardPendingSharedAttachmentCreatedAtOrBefore
      .mockImplementationOnce(async () => oldReturn.promise)
      .mockImplementationOnce(async () => newerCleanup.promise);
    handle('active');
    staged.add('share-B');
    handle('background');
    const newerBoundary = env.interruptedCleanupBoundary.current;
    oldReturn.resolve();
    await flush();
    expect(env.interruptedCleanupBoundary.current).toBe(newerBoundary);
    expect(env.interrupted.current).toBe(true);
    expect(env.setForegroundReady).toHaveBeenLastCalledWith(false);
    expect(env.setForegroundEpoch).not.toHaveBeenCalled();
    newerCleanup.resolve();
    await flush();
  });

  it('does not publish a foreground completion after the screen unmounts', async () => {
    const { env, handle } = fixture();
    const returning = deferred();
    handle('background');
    await flush();
    env.discardPendingSharedAttachmentCreatedAtOrBefore.mockImplementationOnce(async () => returning.promise);
    handle('active');
    env.mounted.current = false;
    returning.resolve();
    await flush();
    expect(env.setForegroundReady).toHaveBeenLastCalledWith(false);
    expect(env.setForegroundEpoch).not.toHaveBeenCalled();
  });
});
