import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AccountDeletionCompletion from '../src/components/AccountDeletionCompletion.jsx';
import { deletionCompletion } from '../src/lib/accountDeletionCompletion.js';

const source = readFileSync(resolve('src/App.jsx'), 'utf8');
const handler = source.match(/async function handleDeleteAccount\([\s\S]*?\n {2}\}/)[0];
function setup() {
  const captured = { user: { id: 'deleted-user' }, access_token: 'old-token' };
  const events = [];
  const state = {
    sessionRestricted: false, demoActive: false, sessionRef: { current: captured },
    deletionAccountRef: { current: null }, deletionLineageRef: { current: null }, deletionSessionRef: { current: null }, deletionReceiptRef: { current: null }, deletionCleanupRef: { current: null },
    outboxStoreRef: { current: {} }, appAuthStorageKey: 'test',
    sameAuthSessionLineage: (a, b) => a?.access_token === b?.access_token,
    sessionIDFromAccessToken: token => token,
    requestAccountDeletion: vi.fn(async () => ({ deleted: true, audited: true })), deletionCompletion,
    lang: 'en', setDeletionLang: vi.fn(),
    setDeletionHold: vi.fn(), setDeletionOutcome: vi.fn(value => events.push(['outcome', value])),
    setDeletionCleanup: vi.fn(),
    beginSessionGeneration: vi.fn(value => events.push(['clear', value])),
    setSession: vi.fn(), setLoading: vi.fn(), setDeletionAuditPendingNotice: vi.fn(), tr: value => value,
    clearCapturedAppSessionLocally: vi.fn(async () => true), appAuthStorageSessionLineage: () => null,
    deleteSnapshot: vi.fn(async () => undefined), purgeSensitiveEntries: vi.fn(async () => undefined),
    supabase: { realtime: { setAuth: vi.fn(async () => undefined) } },
  };
  return { state, events, run: runInNewContext(`(${handler})`, state) };
}

describe('web deletion completion across session teardown', () => {
  it.each([true, false, undefined])('keeps truthful completion for audited=%s after an early SIGNED_OUT', async audited => {
    const f = setup();
    f.state.requestAccountDeletion.mockImplementation(async () => {
      f.state.sessionRef.current = null;
      return { deleted: true, audited };
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.events[0]).toEqual(['outcome', { audited: audited === true }]);
    expect(f.state.setSession).toHaveBeenCalledWith(null);
    expect(f.state.clearCapturedAppSessionLocally).toHaveBeenCalledOnce();
    expect(f.state.purgeSensitiveEntries).toHaveBeenCalledWith({}, 'deleted-user');
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.state.setDeletionHold).toHaveBeenLastCalledWith(true);
  });
  it('clears the protected view before waiting for local cleanup', async () => {
    const f = setup(); let finish; let entered;
    const cleanupStarted = new Promise(resolve => { entered = resolve; });
    f.state.clearCapturedAppSessionLocally.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const pending = f.run('DELETE MY ACCOUNT');
    await cleanupStarted;
    expect(f.state.setSession).toHaveBeenCalledWith(null);
    expect(f.state.setDeletionOutcome).toHaveBeenCalledWith({ audited: true });
    finish(true); await pending;
  });
  it('waits for the sensitive outbox purge before clearing either session', async () => {
    const f = setup(); let finish; let entered;
    const purgeStarted = new Promise(resolve => { entered = resolve; });
    f.state.purgeSensitiveEntries.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const pending = f.run('DELETE MY ACCOUNT');
    await purgeStarted;
    expect(f.state.setDeletionOutcome).toHaveBeenCalledWith({ audited: true });
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
    finish(); await pending;
    expect(f.state.setSession).toHaveBeenCalledWith(null);
    expect(f.state.clearCapturedAppSessionLocally).toHaveBeenCalledOnce();
  });
  it('holds teardown on purge failure and retries the purge before credentials', async () => {
    const f = setup();
    f.state.purgeSensitiveEntries.mockRejectedValueOnce(new Error('storage'));
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('failed');
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
    await f.state.deletionCleanupRef.current();
    expect(f.state.purgeSensitiveEntries).toHaveBeenCalledTimes(2);
    expect(f.state.clearCapturedAppSessionLocally).toHaveBeenCalledOnce();
    expect(f.state.requestAccountDeletion).toHaveBeenCalledOnce();
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('done');
  });
  it('does not restart a stale boot loader while the deletion purge is pending', async () => {
    const f = setup(); let finish; let entered;
    const purgeStarted = new Promise(resolve => { entered = resolve; });
    f.state.purgeSensitiveEntries.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const pending = f.run('DELETE MY ACCOUNT');
    await purgeStarted;
    const start = source.indexOf('  useEffect(() => {\n    if (!session?.user || demoActive) return;');
    const end = source.indexOf('  }, [session?.user?.id, demoActive, sessionGeneration]);', start);
    expect(start).toBeGreaterThan(-1);
    const load = vi.fn();
    const boot = runInNewContext(`(${source.slice(start + '  useEffect('.length, end)}\n  })`, {
      ...f.state, session: f.state.sessionRef.current,
      guardRef: { current: { captureOperation: () => ({ isCurrent: () => false }) } },
      mfaClearedRef: { current: false }, loadShellRef: { current: load },
    });
    boot();
    expect(f.state.setLoading).not.toHaveBeenCalledWith(true);
    expect(load).not.toHaveBeenCalled();
    finish(); await pending;
    expect(f.state.setLoading).toHaveBeenLastCalledWith(false);
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('done');
  });
  it('does not run the member loader subscription against the nulled session after deletion', async () => {
    // SAMPLE, Oct 17 2026: the render that still names the deleted member in
    // `session` committed after the deletion nulled sessionRef, and this effect
    // read `.user` of null into the error boundary instead of the completion.
    const f = setup();
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.sessionRef.current).toBeNull();
    const deps = '  }, [demoActive, loaderFor, memberScopeRevision, session?.user?.id, sessionGeneration]);';
    const end = source.indexOf(deps);
    const start = source.lastIndexOf('  useEffect(() => {', end);
    expect(start).toBeGreaterThan(-1);
    const realLoaderFor = source.match(/const loaderFor = useCallback\((\(activeSession\) => \{[\s\S]*?\n {2}\}), \[\]\);/)[1];
    const subscribe = vi.fn(() => () => {});
    const context = {
      ...f.state, session: { user: { id: 'deleted-user' }, access_token: 'old-token' }, sessionGeneration: 2,
      memberLoaderRef: { current: null },
      guardRef: { current: { captureOperation: () => ({ isCurrent: () => false }) } },
      createMemberSessionLoader: () => ({ subscribe }), setResourceRevision: vi.fn(),
    };
    context.loaderFor = runInNewContext(`(${realLoaderFor})`, context);
    const effect = runInNewContext(`(${source.slice(start + '  useEffect('.length, end)}\n  })`, context);
    expect(() => effect()).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it('does not retry guide resources against the nulled session after deletion', async () => {
    const f = setup();
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.sessionRef.current).toBeNull();
    const deps = '  }, [assistantOpen, demoActive, loaderFor, session?.user?.id]);';
    const end = source.indexOf(deps);
    const start = source.lastIndexOf('  useEffect(() => {', end);
    expect(end).toBeGreaterThan(-1);
    const realLoaderFor = source.match(/const loaderFor = useCallback\((\(activeSession\) => \{[\s\S]*?\n {2}\}), \[\]\);/)[1];
    const retryFailedResources = vi.fn();
    const context = {
      ...f.state, session: { user: { id: 'deleted-user' }, access_token: 'old-token' }, assistantOpen: true,
      MEMBER_GUIDE_RESOURCES: ['guide'], memberLoaderRef: { current: null },
      guardRef: { current: { captureOperation: () => ({ isCurrent: () => false }) } },
      createMemberSessionLoader: () => ({ retryFailedResources }),
    };
    context.loaderFor = runInNewContext(`(${realLoaderFor})`, context);
    const effect = runInNewContext(`(${source.slice(start + '  useEffect('.length, end)}\n  })`, context);
    expect(() => effect()).not.toThrow();
    expect(retryFailedResources).not.toHaveBeenCalled();
  });
  it('preserves a replacement login that arrives while the purge is pending', async () => {
    const f = setup();
    f.state.purgeSensitiveEntries.mockImplementation(async () => {
      f.state.sessionRef.current = { user: { id: 'new-user' }, access_token: 'new-token' };
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
    expect(f.state.deletionReceiptRef.current).toBeNull();
    expect(f.state.setDeletionOutcome).toHaveBeenLastCalledWith(null);
    expect(f.state.setDeletionHold).toHaveBeenLastCalledWith(false);
  });
  it('finishes confirmed deletion cleanup after a same-account lineage write during purge', async () => {
    const f = setup();
    const lateSession = { user: { id: 'deleted-user' }, access_token: 'late-token' };
    f.state.purgeSensitiveEntries.mockImplementation(async () => {
      f.state.sessionRef.current = lateSession;
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setSession).toHaveBeenCalledWith(null);
    expect(f.state.clearCapturedAppSessionLocally).toHaveBeenCalledWith(lateSession, { explicitSignOut: true });
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.state.setDeletionOutcome).not.toHaveBeenCalledWith(null);
  });
  it('preserves a new same-account login after an uncertain deletion', async () => {
    const f = setup();
    f.state.requestAccountDeletion.mockRejectedValue(Object.assign(new Error('unknown'), { code: 'account-delete-indeterminate' }));
    f.state.purgeSensitiveEntries.mockImplementation(async () => {
      f.state.sessionRef.current = { user: { id: 'deleted-user' }, access_token: 'new-token' };
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
    expect(f.state.setDeletionOutcome).toHaveBeenLastCalledWith(null);
  });
  it('does not overwrite replacement state when the auth listener retires cleanup during purge', async () => {
    const f = setup();
    f.state.purgeSensitiveEntries.mockImplementation(async () => {
      f.state.deletionReceiptRef.current = null;
      f.state.setDeletionOutcome(null);
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
    expect(f.state.setDeletionCleanup).not.toHaveBeenCalledWith('done');
  });
  it.each(['account-delete-failed'])('never publishes completion for %s', async code => {
    const f = setup(); f.state.requestAccountDeletion.mockRejectedValue(new Error(code));
    await expect(f.run('DELETE MY ACCOUNT')).rejects.toThrow(code);
    expect(f.state.setDeletionOutcome).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
  });
  it('holds an uncertain response without claiming deletion or restarting SAMPLE', async () => {
    const f = setup();
    f.state.requestAccountDeletion.mockRejectedValue(Object.assign(new Error('unknown'), { code: 'account-delete-indeterminate' }));
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setDeletionOutcome).toHaveBeenCalledWith({ uncertain: true });
    expect(f.state.setDeletionHold).toHaveBeenLastCalledWith(true);
    expect(f.state.setSession).toHaveBeenCalledWith(null);
  });
  it('preserves a replacement login when the deletion response arrives late', async () => {
    const f = setup(); f.state.requestAccountDeletion.mockImplementation(async () => {
      f.state.sessionRef.current = { user: { id: 'new-user' }, access_token: 'new-token' };
      return { deleted: true, audited: true };
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setSession).not.toHaveBeenCalled();
    expect(f.state.clearCapturedAppSessionLocally).not.toHaveBeenCalled();
  });
  it('retries only local cleanup after a cleanup failure', async () => {
    const f = setup(); f.state.clearCapturedAppSessionLocally.mockRejectedValueOnce(new Error('storage'));
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('failed');
    await f.state.deletionCleanupRef.current();
    expect(f.state.requestAccountDeletion).toHaveBeenCalledOnce();
    expect(f.state.setDeletionCleanup).toHaveBeenLastCalledWith('done');
  });
  it.each([
    { deletionHold: true, authRestorePending: false },
    { deletionHold: false, authRestorePending: true },
  ])('defers SAMPLE retirement while deletion or restoration holds the session: %s', (hold) => {
    const start = source.indexOf('  useEffect(() => {\n    if (!sampleLive || deletionHold || authRestorePending)');
    const end = source.indexOf(', [sampleLive,', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = source.slice(start + '  useEffect('.length, end);
    const setLoading = vi.fn();
    const setDataError = vi.fn();
    runInNewContext(`(${callback})()`, { sampleLive: true, session: null, ...hold, setLoading, setDataError });
    expect(setLoading).not.toHaveBeenCalled();
    expect(setDataError).not.toHaveBeenCalled();
    expect(callback).not.toContain('mintSamplePersonaSession');
    // The completion renders before the shell's signed-out branch.
    expect(source.indexOf('if (deletionOutcome) return')).toBeLessThan(source.indexOf('\n  if (!session) {\n'));
  });
});

describe('indeterminate deletion and a replacement login', () => {
  const start = source.indexOf('      // A late refresh for the deleted identity');
  const end = source.indexOf('      // Auth-js converts an initial storage read failure', start);
  function receive({ uncertain = true, user = 'deleted-user', lineage = 'new-session' } = {}) {
    const state = {
      deletionReceiptRef: { current: { uncertain } }, deletionAccountRef: { current: 'deleted-user' },
      deletionSessionRef: { current: null }, deletionLineageRef: { current: 'old-session' },
      deletionCleanupRef: { current: () => {} }, setDeletionOutcome: vi.fn(), setDeletionHold: vi.fn(),
      sessionIDFromAccessToken: token => token,
    };
    const callback = runInNewContext(`(nextSession => { ${source.slice(start, end)}; return 'adopt'; })`, state);
    return { state, result: callback({ user: { id: user }, access_token: lineage }) };
  }
  it('accepts a fresh same-account lineage and retires the old cleanup after an uncertain result', () => {
    const { state, result } = receive();
    expect(result).toBe('adopt');
    expect(state.deletionCleanupRef.current).toBeNull();
    expect(state.setDeletionOutcome).toHaveBeenCalledWith(null);
    expect(state.setDeletionHold).toHaveBeenCalledWith(false);
  });
  it.each(['old-session', null])('does not accept a late or unknown lineage (%s)', lineage => {
    const { state, result } = receive({ lineage });
    expect(result).toBeUndefined();
    expect(state.setDeletionOutcome).not.toHaveBeenCalled();
  });
  it('still refuses the deleted account after a confirmed deletion', () => {
    expect(receive({ uncertain: false }).result).toBeUndefined();
  });
  it('allows a different account to replace either outcome', () => {
    expect(receive({ uncertain: false, user: 'another-user' }).result).toBe('adopt');
  });
});

// BUG-UG-KEEP-WEB-ACCOUNT-DELETION-CONFIRMATION-MEMBER-S-OWN-20261013:
// a Spanish account on an English-booted device, with no language toggle.
describe("the member's own language", () => {
  it('snapshots the language before the session generation is cleared', async () => {
    const f = setup();
    f.state.lang = 'es';
    await f.run('DELETE MY ACCOUNT');
    expect(f.state.setDeletionLang.mock.calls).toEqual([['es']]);
    const cleared = f.state.beginSessionGeneration.mock.calls.findIndex(([value]) => value === null);
    expect(f.state.setDeletionLang.mock.invocationCallOrder[0]).toBeLessThan(f.state.beginSessionGeneration.mock.invocationCallOrder[cleared]);
    // Sign-out later drops the account's preference; the snapshot is not retaken.
    f.state.lang = 'en';
    await f.state.deletionCleanupRef.current?.();
    expect(f.state.setDeletionLang.mock.calls).toEqual([['es']]);
  });

  it('renders the completion from the snapshot, not the live shell language', () => {
    expect(source).toContain('const completionLang = deletionLang || lang;');
    const render = source.match(/if \(deletionOutcome\) return <LanguageProvider lang=\{([^}]+)\}>[\s\S]*?<AccountDeletionCompletion\s+outcome=\{deletionOutcome\} lang=\{([^}]+)\}/);
    expect(render?.slice(1)).toEqual(['completionLang', 'completionLang']);
  });

  it('keeps the completion copy in Spanish through cleanup and acknowledgement', () => {
    const onContinue = vi.fn();
    const view = render(<AccountDeletionCompletion outcome={{ audited: true }} lang="es" cleanup="pending" onContinue={onContinue} />);
    const title = screen.getByRole('heading').textContent;
    expect(title).not.toBe('Your account has been deleted');
    expect(screen.getByRole('button')).toBeDisabled();
    view.rerender(<AccountDeletionCompletion outcome={{ audited: true }} lang="es" cleanup="done" onContinue={onContinue} />);
    expect(screen.getByRole('heading').textContent).toBe(title);
    fireEvent.click(screen.getByRole('button'));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

describe('accessible terminal screen', () => {
  it('focuses the completion title and requires acknowledgement after cleanup', () => {
    const onContinue = vi.fn();
    const view = render(<AccountDeletionCompletion outcome={{ audited: true }} cleanup="pending" onContinue={onContinue} />);
    expect(screen.getByRole('heading')).toHaveFocus();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your account has been deleted' })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
    view.rerender(<AccountDeletionCompletion outcome={{ audited: true }} cleanup="done" onContinue={onContinue} sample />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to SAMPLE demo' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
  it('distinguishes missing audit confirmation and cleanup failure from ordinary completion', () => {
    render(<AccountDeletionCompletion outcome={{ audited: false }} cleanup="failed" onRetry={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('still being recorded');
    expect(screen.getByRole('alert')).toHaveTextContent('could not finish clearing');
    expect(screen.getByRole('button')).toHaveTextContent('Retry device cleanup');
  });
  it('does not manufacture success from an unconfirmed result', () => {
    expect(deletionCompletion({ deleted: false, audited: true })).toBeNull();
    expect(deletionCompletion({ deleted: true })).toEqual({ audited: false });
  });
});
