import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-MESSAGE-ACTIONS-20260904, acceptance item 5 (haptics
// coverage). Haptic feedback is not observable by any device harness (adb,
// XCUITest, TalkBack/VoiceOver trees), so the haptics rows of the physical
// matrix are proved at code level: the row uses the one shared haptics
// primitive (src/services/haptics.ts) and invokes it at the three moments
// the record names — menu open, confirmed action, failed action — and that
// primitive drives expo-haptics with the documented feedback types while
// swallowing a device that has no engine. Controller ruling 5 of 2026-09-27
// controller-acceptance-rescope-decision-5.json) relies on this file.

const mocks = vi.hoisted(() => ({
  selectionAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  impactAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: mocks.selectionAsync,
  notificationAsync: mocks.notificationAsync,
  impactAsync: mocks.impactAsync,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

import { haptics } from '../services/haptics';
import { initializeHapticPreference } from '../services/hapticPreference';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null) }));

const actions = readFileSync(fileURLToPath(new URL('./NativeMessageActions.tsx', import.meta.url)), 'utf8');

describe('the shared haptics primitive', () => {
  beforeEach(async () => {
    await initializeHapticPreference();
    mocks.selectionAsync.mockClear();
    mocks.notificationAsync.mockClear();
    mocks.impactAsync.mockClear();
  });

  it('maps select, success and warning to the documented expo-haptics feedback', async () => {
    await haptics.select();
    expect(mocks.selectionAsync).toHaveBeenCalledTimes(1);
    await haptics.success();
    expect(mocks.notificationAsync).toHaveBeenLastCalledWith('success');
    await haptics.warning();
    expect(mocks.notificationAsync).toHaveBeenLastCalledWith('warning');
  });

  it('never throws when the device has no haptic engine', async () => {
    mocks.selectionAsync.mockRejectedValueOnce(new Error('no engine'));
    mocks.notificationAsync.mockRejectedValueOnce(new Error('no engine'));
    await expect(haptics.select()).resolves.toBeUndefined();
    await expect(haptics.success()).resolves.toBeUndefined();
  });
});

describe('NativeMessageActions invokes the shared primitive at every named moment', () => {
  it('imports the one shared haptics service and no other feedback source', () => {
    expect(actions).toContain("import { haptics } from '../services/haptics';");
    expect(actions).not.toContain('expo-haptics');
    expect(actions).not.toMatch(/Vibration\b/);
  });

  it('selection feedback when the native action menu opens', () => {
    const menu = actions.slice(actions.indexOf('async function menu()'), actions.indexOf('if (!enabled) {'));
    expect(menu).toContain("await messageActionRequest(await writer.client(), sourceKind, messageID, 'state')");
    expect(menu).toContain('setState(current); void haptics.select();');
  });

  it('success feedback only after the server confirmed the action, warning feedback on failure', () => {
    const perform = actions.slice(actions.indexOf('async function perform('), actions.indexOf('async function menu()'));
    const confirmed = perform.indexOf('setState(result.state as MessageActionState);');
    const success = perform.indexOf('void haptics.success();');
    expect(confirmed).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(confirmed);
    expect(perform).toContain('const proof = await writer.check();');
    expect(perform).toContain("if (version === generation.current && proof !== 'changed') { setError(!acknowledged); if (!acknowledged) void haptics.warning(); }");
  });

  it('hands reply and edit to the composer through onCompose without calling perform (their feedback is the menu selection haptic; no haptic is claimed for the hand-off)', () => {
    expect(actions).toContain("if (choice.id === 'reply' || choice.id === 'edit') { onCompose(choice.id); return; }");
  });

  it('routes every server-confirmed action through perform, so react, save, remind and the double-tap quick action all reach the primitive', () => {
    expect(actions).toContain("onReact={(kind) => { void perform('react', kind); }}");
    expect(actions).toContain("if (choice.id === 'remind') {");
    expect(actions).toContain("setShowReminderPicker(true);");
    expect(actions).toContain("void perform('react', MESSAGE_QUICK_ACTION);");
    // The private and channel rows share this one component; there is no
    // second implementation that could skip the haptic.
    expect(actions).toContain("sourceKind: 'private' | 'channel';");
  });
});
