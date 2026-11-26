import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createHomeWidgetController, HOME_WIDGET_TTL_MS, widgetSnapshot, widgetSnapshotIsFresh, type HomeWidgetScope } from './homeWidgetSnapshot';
import { nativeQuickActionDestinationPath, nativeQuickActionIDFromSystemPath } from './nativeQuickActionRoutes';

const A: HomeWidgetScope = { userID: 'a', sessionID: 'session-a', organizationID: 'org-a', chapterID: 'chapter-a' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup() {
  let nonce = 0;
  const stored: { value: unknown } = { value: null };
  let generation = '';
  const adapter = {
    resetAsync: vi.fn(async (next: string) => { generation = next; stored.value = null; }),
    publishAsync: vi.fn(async (expected: string, today: number, unread: number, updatedAt: number, expiresAt: number) => {
      if (expected === generation) stored.value = { today, unread, updatedAt, expiresAt };
    }),
  };
  return { controller: createHomeWidgetController(adapter, () => `generation-${++nonce}`), stored, adapter };
}

// Execute the real gate transition effect so the resume regression covers its
// provider wiring as well as the controller's consent state machine.
const gateSource = readFileSync(new URL('../components/HomeWidgetGate.tsx', import.meta.url), 'utf8');
const gateTree = ts.createSourceFile('HomeWidgetGate.tsx', gateSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let transitionSource = '';
function findTransition(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(gateTree) === 'useLayoutEffect') transitionSource = node.arguments[0]!.getText(gateTree);
  ts.forEachChild(node, findTransition);
}
findTransition(gateTree);
function applyWidgetScope(controller: ReturnType<typeof setup>['controller'], mode: string, scope: HomeWidgetScope | null, error: string | null = null, refreshing = false, sessionRestrictionPending = false) {
  const effect = runInNewContext(ts.transpile(`(${transitionSource})`, { target: ts.ScriptTarget.ES2022 }), {
    homeWidgets: controller, mode, scope, error, refreshing, sessionRestrictionPending,
  }) as () => void;
  effect();
  return tick();
}
afterEach(() => vi.useRealTimers());

describe('home-screen minimized snapshots', () => {
  it('publishes only counts and timestamps, including a real zero', () => {
    const now = new Date(2026, 9, 29, 12).getTime();
    expect(widgetSnapshot(0, 0, now)).toEqual({ today: 0, unread: 0, updatedAt: now, expiresAt: now + HOME_WIDGET_TTL_MS });
    for (const invalid of [-1, 0.5, NaN, Infinity, 2_147_483_648]) expect(() => widgetSnapshot(invalid, 0, now)).toThrow();
  });
  it('expires at five minutes or local midnight and fails closed after a clock rollback', () => {
    const now = new Date(2026, 9, 29, 23, 59).getTime();
    const snapshot = widgetSnapshot(7, 2, now);
    expect(snapshot.expiresAt).toBe(new Date(2026, 9, 30).getTime());
    expect(widgetSnapshotIsFresh(snapshot, now)).toBe(true);
    expect(widgetSnapshotIsFresh(snapshot, now - 1)).toBe(false);
    expect(widgetSnapshotIsFresh(snapshot, snapshot.expiresAt)).toBe(false);
    expect(widgetSnapshotIsFresh({ ...snapshot, expiresAt: now + HOME_WIDGET_TTL_MS + 1 }, now)).toBe(false);
  });
  it('requires a deliberate opt-in; cold start and sign-out expose no counts', async () => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    const read = vi.fn(async () => widgetSnapshot(3, 1));
    await controller.refresh(A, read);
    expect(read).not.toHaveBeenCalled();
    await controller.enable(A);
    await controller.refresh(A, read);
    expect(stored.value).toMatchObject({ today: 3, unread: 1 });
    await controller.disable();
    expect(stored.value).toBeNull();
    expect(controller.enabled()).toBe(false);
  });
  it.each([
    { ...A, userID: 'b', sessionID: 'session-b' },
    { ...A, organizationID: 'org-b' },
    { ...A, chapterID: 'chapter-b' },
    { ...A, sessionID: 'new-session-same-user' },
  ])('purges on scope replacement and discards the previous read: %j', async (next) => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    let resolve!: (value: ReturnType<typeof widgetSnapshot>) => void;
    const pending = controller.refresh(A, () => new Promise((done) => { resolve = done; }));
    await tick();
    await controller.setScope(next);
    resolve(widgetSnapshot(99, 99));
    await pending;
    expect(stored.value).toBeNull();
    expect(controller.enabled()).toBe(false);
    await expect(controller.enable(A)).rejects.toThrow();
  });
  it('does not let a delayed opt-in cross an account or organization transition', async () => {
    const { controller } = setup();
    await controller.setScope(A);
    const enable = controller.enable(A);
    await controller.setScope({ ...A, organizationID: 'other' });
    await enable;
    expect(controller.enabled()).toBe(false);
  });
  it('purges and blocks during foreground revalidation, then refreshes the identical scope without a second opt-in', async () => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await controller.refresh(A, async () => widgetSnapshot(3, 1));
    await applyWidgetScope(controller, 'booting', null);
    expect(stored.value).toBeNull();
    expect(controller.enabled()).toBe(false);
    const forbiddenRead = vi.fn(async () => widgetSnapshot(99, 99));
    await controller.refresh(A, forbiddenRead);
    expect(forbiddenRead).not.toHaveBeenCalled();
    await expect(controller.enable(A)).rejects.toThrow();
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(true);
    await controller.refresh(A, async () => widgetSnapshot(2, 0));
    expect(stored.value).toMatchObject({ today: 2, unread: 0 });
  });
  it.each([null, { ...A, organizationID: 'other' }, { ...A, sessionID: 'new-session' }])('revokes suspended consent after failed authorization or a changed scope: %j', async (next) => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await controller.suspend();
    await controller.setScope(next);
    await controller.setScope(A);
    expect(controller.enabled()).toBe(false);
    expect(stored.value).toBeNull();
  });
  it('revokes consent on a failed foreground authorization and does not revive it on a later retry', async () => {
    const { controller } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await applyWidgetScope(controller, 'booting', null);
    await applyWidgetScope(controller, 'booting', null, 'Authentication unavailable');
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(false);
  });
  it('preserves consent through TOKEN_REFRESHED with authenticated mode before campaign authorization finishes', async () => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await controller.refresh(A, async () => widgetSnapshot(3, 1));
    // establishSession clears protected rows, then commits authenticated mode
    // before awaiting fetchDashboard. Exercise every intermediate real frame.
    await applyWidgetScope(controller, 'booting', null);
    await applyWidgetScope(controller, 'authenticated', null, null, true);
    await applyWidgetScope(controller, 'authenticated', A, null, true);
    expect(controller.enabled()).toBe(false);
    expect(stored.value).toBeNull();
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(true);
    await controller.refresh(A, async () => widgetSnapshot(2, 0));
    expect(stored.value).toMatchObject({ today: 2, unread: 0 });
  });
  it('revokes consent when the authenticated dashboard reload fails', async () => {
    const { controller } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await applyWidgetScope(controller, 'authenticated', null, null, true);
    await applyWidgetScope(controller, 'authenticated', A, 'Workspace authorization failed');
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(false);
  });
  it('preserves unrestricted PIN-session consent while the restriction lookup is pending after resume', async () => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await controller.refresh(A, async () => widgetSnapshot(3, 1));
    await applyWidgetScope(controller, 'booting', null);
    await applyWidgetScope(controller, 'authenticated', null, null, true, true);
    // Dashboard finished, but the restriction RPC has not yet confirmed access.
    await applyWidgetScope(controller, 'authenticated', null, null, false, true);
    expect(controller.enabled()).toBe(false);
    expect(stored.value).toBeNull();
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(true);
    await controller.refresh(A, async () => widgetSnapshot(1, 0));
    expect(stored.value).toMatchObject({ today: 1, unread: 0 });
  });
  it('revokes PIN-session consent on confirmed restriction or a fail-closed lookup result', async () => {
    const { controller } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await applyWidgetScope(controller, 'authenticated', null, null, false, true);
    // A restricted/error result settles the lookup without an authorized scope.
    await applyWidgetScope(controller, 'authenticated', null);
    await applyWidgetScope(controller, 'authenticated', A);
    expect(controller.enabled()).toBe(false);
  });
  it('cancels an opt-in interrupted by foreground suspension', async () => {
    const { controller } = setup();
    await controller.setScope(A);
    const enable = controller.enable(A);
    await controller.suspend();
    await enable;
    await controller.setScope(A);
    expect(controller.enabled()).toBe(false);
  });
  it('failed refresh purges a prior valid count instead of presenting a stale zero', async () => {
    const { controller, stored } = setup();
    await controller.setScope(A);
    await controller.enable(A);
    await controller.refresh(A, async () => widgetSnapshot(3, 1));
    await expect(controller.refresh(A, async () => { throw new Error('offline'); })).rejects.toThrow('unavailable');
    expect(stored.value).toBeNull();
  });
  it('routes both generic taps through the existing foreground handoff', () => {
    expect(nativeQuickActionDestinationPath(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/work'))).toBe('/work');
    expect(nativeQuickActionDestinationPath(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/messages'))).toBe('/messages');
    for (const bad of ['unionground://os-quick-action/work?member=a', 'unionground://os-quick-action/messages#org', 'unionground://os-quick-action/work/case']) {
      expect(nativeQuickActionIDFromSystemPath(bad)).toBeNull();
    }
  });
});
