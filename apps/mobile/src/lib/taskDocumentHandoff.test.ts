import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { TaskCameraPermissionError, TaskDocumentHandoff } from './taskDocumentHandoff';

type Candidate = { bytes: string };
const candidate: Candidate = { bytes: 'synthetic document' };

function setup(kind: 'document' | 'scan' = 'document') {
  const release = vi.fn(async (_value: Candidate) => undefined);
  const store = new TaskDocumentHandoff(release);
  store.observe('account-a:session-a', 'chapter-a', 'authorized');
  store.authorizeTasks(['task-a', 'task-b']);
  store.setQuery('fixture');
  store.setOpen('task-a', true);
  let resolve: (value: Candidate | null) => void = () => { throw new Error('picker not started'); };
  const picker = vi.fn(() => new Promise<Candidate | null>((done) => { resolve = done; }));
  const running = store.choose('task-a', picker, kind);
  return { store, release, picker, running, resolve: (value: Candidate | null) => resolve(value) };
}

const pickerKinds: Array<'document' | 'scan'> = ['document', 'scan'];
describe.each(pickerKinds)('authenticated task %s picker handoff', (kind) => {
  it.each(['before', 'after'] as const)('restores the task and result arriving %s fresh authorization', async (order) => {
    const s = setup(kind);
    // FeatureScreen removes its task subtree during bootstrapping. The route
    // remains mounted, so its owner survives with no protected public snapshot.
    s.store.observe('account-a:session-a', null, 'checking');
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, query: '', openTaskIDs: [] });
    if (order === 'before') { s.resolve(candidate); await s.running; }
    expect(s.store.take('task-a', candidate)).toBe(false);
    s.store.observe('account-a:session-a', 'chapter-a', 'authorized');
    expect(s.store.take('task-a', candidate)).toBe(false);
    s.store.authorizeTasks(['task-a']);
    if (order === 'after') { s.resolve(candidate); await s.running; }
    expect(s.store.getSnapshot()).toMatchObject({ query: 'fixture', openTaskIDs: ['task-a'], pending: { taskID: 'task-a', candidate, kind } });
    expect(s.store.take('another-task', candidate)).toBe(false);
    expect(s.store.take('task-a', candidate)).toBe(true);
    expect(s.store.take('task-a', candidate)).toBe(false);
    s.store.dispose();
    expect(s.release).not.toHaveBeenCalled(); // The mounted panel now owns it.
  });

  it.each([
    ['account-b:session-b', 'chapter-a', 'authorized'],
    ['account-a:another-session', 'chapter-a', 'authorized'],
    ['account-a:session-a', 'chapter-b', 'authorized'],
    ['account-a:session-a', 'chapter-a', 'denied'],
    [null, null, 'denied'],
  ] as const)('discards late results after identity, campaign, or role loss (%s / %s / %s)', async (identity, chapter, phase) => {
    const s = setup(kind);
    s.store.observe(identity, chapter, phase);
    s.resolve(candidate); await s.running;
    expect(s.release).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, query: '', openTaskIDs: [] });
    expect(s.store.take('task-a', candidate)).toBe(false);
  });

  it('releases an already returned candidate on identity loss while covered', async () => {
    const s = setup(kind); s.resolve(candidate); await s.running;
    s.store.observe('account-b:session-b', null, 'checking');
    expect(s.release).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(s.store.getSnapshot().pending).toBeNull();
  });

  it.each(['before', 'after'] as const)('cleans a task absent from fresh authorized history with a result %s that read', async (order) => {
    const s = setup(kind);
    if (order === 'before') { s.resolve(candidate); await s.running; }
    s.store.authorizeTasks(['different-task']);
    if (order === 'after') { s.resolve(candidate); await s.running; }
    expect(s.release).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, openTaskIDs: [] });
  });

  it.each(['route-exit', 'panel-close', 'target-read-failure'] as const)('cleans a late result after %s', async (action) => {
    const s = setup(kind);
    if (action === 'route-exit') s.store.dispose();
    else if (action === 'panel-close') s.store.setOpen('task-a', false);
    else s.store.discard('task-a');
    s.resolve(candidate); await s.running;
    expect(s.release).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(s.store.getSnapshot().pending).toBeNull();
  });

  it('does not open duplicate pickers and records conversion without publishing while covered', async () => {
    const s = setup(kind); await s.store.choose('task-b', s.picker, kind);
    expect(s.picker).toHaveBeenCalledTimes(1);
    s.resolve(null); await s.running;
    await s.store.choose('task-a', async (converted) => {
      converted(); s.store.observe('account-a:session-a', null, 'checking'); return candidate;
    }, kind);
    expect(s.store.getSnapshot().pending).toBeNull();
    s.store.observe('account-a:session-a', 'chapter-a', 'authorized');
    s.store.authorizeTasks(['task-a']);
    expect(s.store.getSnapshot().pending?.converted).toBe(true);
  });

  it('handles cancellation, producer failure, and deferred service cleanup without claiming upload', async () => {
    const s = setup(kind); s.resolve(null); await s.running;
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, failed: false });
    await s.store.choose('task-a', async () => { throw new Error('private producer detail'); }, kind);
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, failed: true, failure: { taskID: 'task-a', reason: kind } });
    expect(JSON.stringify(s.store.getSnapshot())).not.toContain('private producer detail');
    await s.store.choose('task-a', async () => candidate, kind);
    s.release.mockRejectedValueOnce(new Error('cleanup queued by service'));
    s.store.dispose(); await Promise.resolve();
    expect(s.store.getSnapshot().pending).toBeNull();
  });

  it('keeps the handoff above the real protected subtree and claims only after the exact target read', () => {
    const route = readFileSync(new URL('../../app/feature/[key].tsx', import.meta.url), 'utf8');
    const host = readFileSync(new URL('../features/TaskDocumentHandoffProvider.tsx', import.meta.url), 'utf8');
    const panel = readFileSync(new URL('../components/AttachmentPanel.tsx', import.meta.url), 'utf8');
    expect(route).toMatch(/key === 'tasks'[\s\S]*?<TaskDocumentHandoffProvider[^>]*>\{content\}/);
    expect(host).toContain('sessionIDFromAccessToken(session.access_token)');
    expect(host).toContain('await captureAuthorizedScan({');
    expect(host).toContain("}, 'scan');");
    expect(panel).toContain('documentHandoff?.scan');
    expect(panel).toContain('stageCandidate(kind, candidate, converted)');
    expect(host).toContain("canOpenFeature(mode, 'tasks', null, chapterRoles, organizationRoles)");
    expect(panel).toContain('!canWrite || attachments === null || busy || activeStaged');
    expect(panel).toContain('if (!documentHandoff.take(returnedDocument)) return;');
    expect(panel).toContain('selectionLifecycle.consume(requestGeneration, candidate');
    expect(panel).toContain('documentHandoff?.discard();');
    expect(panel).toContain('selectionLifecycle.invalidate();');
  });
});


describe('task camera permission outcomes', () => {
  it.each([true, false])('retains safe denial guidance across reauthorization (canAskAgain=%s)', async (canAskAgain) => {
    const release = vi.fn(async (_value: Candidate) => undefined);
    const store = new TaskDocumentHandoff(release);
    store.observe('account:session', 'chapter', 'authorized');
    store.authorizeTasks(['task']);
    await store.choose('task', async () => {
      store.observe('account:session', null, 'checking');
      throw new TaskCameraPermissionError(canAskAgain);
    }, 'scan');
    expect(store.getSnapshot()).toMatchObject({ pending: null, failed: false, failure: null });
    store.observe('account:session', 'chapter', 'authorized');
    store.authorizeTasks(['task']);
    expect(store.getSnapshot()).toMatchObject({ pending: null, failed: true,
      failure: { taskID: 'task', reason: canAskAgain ? 'camera-denied-retry' : 'camera-denied-settings' } });
    await store.choose('task', async () => null, 'scan');
    expect(store.getSnapshot()).toMatchObject({ pending: null, failed: false, failure: null });
    expect(release).not.toHaveBeenCalled();
  });

  it('drops a camera denial from a revoked session', async () => {
    const store = new TaskDocumentHandoff<Candidate>(async () => undefined);
    store.observe('account:session', 'chapter', 'authorized');
    store.authorizeTasks(['task']);
    await store.choose('task', async () => {
      store.observe(null, null, 'denied');
      throw new TaskCameraPermissionError(false);
    }, 'scan');
    expect(store.getSnapshot()).toMatchObject({ pending: null, failed: false, failure: null });
  });
});


describe('handoff review regressions', () => {
  it('retains producer phase and kind while hiding protected data until fresh authorization', async () => {
    const store = new TaskDocumentHandoff<Candidate>(async () => undefined);
    store.observe('account:session', 'chapter', 'authorized'); store.authorizeTasks(['task']);
    await store.choose('task', async (progress) => {
      progress('preparing');
      expect(store.getSnapshot().pending).toMatchObject({ kind: 'scan', producerPhase: 'preparing', converted: false });
      store.observe('account:session', null, 'checking');
      progress('converting');
      expect(store.getSnapshot().pending).toBeNull();
      return candidate;
    }, 'scan');
    store.observe('account:session', 'chapter', 'authorized');
    expect(store.getSnapshot().pending).toBeNull();
    store.authorizeTasks(['task']);
    const snapshot = store.getSnapshot();
    expect(snapshot.pending).toMatchObject({ kind: 'scan', producerPhase: 'converting', converted: true });
    expect(store.take('task', candidate)).toBe(true);
    expect(snapshot.pending?.kind).toBe('scan');
    expect(snapshot.pending?.converted).toBe(true);
  });

  it('binds safe failure feedback to the fresh authorized task and clears it on panel close', async () => {
    const store = new TaskDocumentHandoff<Candidate>(async () => undefined);
    store.observe('account:session', 'chapter', 'authorized'); store.authorizeTasks(['task']);
    await store.choose('task', async () => { throw new TaskCameraPermissionError(false); }, 'scan');
    store.observe('account:session', null, 'checking');
    store.observe('account:session', 'chapter', 'authorized');
    expect(store.getSnapshot().failure).toBeNull();
    store.authorizeTasks(['task']);
    expect(store.getSnapshot().failure).toEqual({ taskID: 'task', reason: 'camera-denied-settings' });
    store.setOpen('task', false);
    expect(store.getSnapshot().failure).toBeNull();
  });

  it('keeps only a generic discard notice after access loss, never the previous task or candidate', async () => {
    const s = setup('scan'); s.resolve(candidate); await s.running;
    s.store.observe('account-a:session-a', 'chapter-a', 'denied');
    expect(s.store.getSnapshot().discardedKind).toBeNull();
    s.store.observe('account-a:session-a', 'chapter-a', 'authorized');
    expect(s.store.getSnapshot()).toMatchObject({ pending: null, openTaskIDs: [], query: '', discardedKind: 'scan' });
    s.store.observe('another:session', 'chapter-a', 'authorized');
    expect(s.store.getSnapshot().discardedKind).toBeNull();
  });

  it('records late scan disposal without recording identity, task, candidate bytes, or exception text', async () => {
    const record = vi.fn();
    const store = new TaskDocumentHandoff<Candidate>(async () => undefined, record);
    store.observe('private-account:private-session', 'private-chapter', 'authorized');
    store.authorizeTasks(['private-task']);
    await store.choose('private-task', async () => {
      store.observe(null, null, 'denied'); return candidate;
    }, 'scan');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ step: 'handoff-started', outcome: 'scan' }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ step: 'handoff-settled', outcome: 'selected',
      detail: expect.objectContaining({ matched: false, isScan: true }) }));
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/private-|synthetic document/);
  });
});
