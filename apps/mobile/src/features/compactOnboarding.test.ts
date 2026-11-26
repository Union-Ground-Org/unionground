import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { messageWorkflowDefault } from '../lib/messageWorkflow';
import { nativeUiText } from '../lib/nativeUiCopy';
import { readMessageWorkflowOnboarded, readMessageWorkflowPreference, saveMessageWorkflowPreference, subscribeMessageWorkflowPreference } from '../services/messageWorkflowPreference';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
}));
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('K8: optional choices leave working screens clear', () => {
  it('keeps Pulse setup and the optional About Home guide in Account, away from the Home feed', () => {
    const home = source('../../app/(tabs)/home.tsx');
    expect(home).not.toContain('<PulseOpeningPreferenceCard setup');
    expect(home).not.toContain('<NativeFeatureGuide feature="home"');
    const account = source('../../app/(tabs)/account.tsx');
    expect(account).toContain('<HomeGuidePreference');
    expect(account).toContain('<PulseOpeningPreferenceCard');
  });

  it('asks about Messages in a dismissible scrolling sheet with compact choices and stacked actions', () => {
    const messages = source('../../app/messages.tsx');
    const chooser = messages.slice(messages.indexOf('{!sharedDemoVisit && workflowOnboarded === false ?'), messages.indexOf('{recentItems.length > 0 ?'));
    expect(chooser).toContain('<Modal');
    expect(chooser).toContain('onRequestClose=');
    expect(chooser).toContain('skipWorkflowOnboarding');
    expect(chooser).toContain('accessibilityViewIsModal');
    expect(chooser).toContain('<ScrollView');
    expect(chooser).toMatch(/<MessageWorkflowPicker[^>]+compact/);
    expect(chooser).not.toContain('<Card>');
    // #9608: the actions are stacked full width below the scrolling choices
    // (messagesOrganizeSheet.screen.test.tsx renders the sheet).
    expect(messages).toContain('onboardingActions: { gap: spacing.sm }');
  });

  it('binds both Messages and Account to the signed-in account for every preference access', () => {
    for (const file of ['../../app/messages.tsx', '../../app/(tabs)/account.tsx']) {
      const content = source(file);
      expect(content).toContain('readMessageWorkflowPreference(session?.user.id)');
      expect(content).toMatch(/saveMessageWorkflowPreference\(value, session\?\.user.id\)/);
    }
    expect(source('../../app/messages.tsx')).toContain('readMessageWorkflowOnboarded(session?.user.id)');
  });

  it('persists a dismissal after a service reload without sharing it or its choice with another account', async () => {
    storage.clear();
    await saveMessageWorkflowPreference('attention', 'account-a');
    vi.resetModules();
    const relaunched = await import('../services/messageWorkflowPreference');
    expect(await relaunched.readMessageWorkflowOnboarded('account-a')).toBe(true);
    expect(await relaunched.readMessageWorkflowPreference('account-a')).toBe('attention');
    expect(await relaunched.readMessageWorkflowOnboarded('account-b')).toBe(false);
    expect(await relaunched.readMessageWorkflowPreference('account-b')).toBe(messageWorkflowDefault);
    await relaunched.saveMessageWorkflowPreference(messageWorkflowDefault, 'account-b');
    expect(await relaunched.readMessageWorkflowPreference('account-a')).toBe('attention');
  });

  it('does not publish one account’s save to another mounted account', async () => {
    const before = await readMessageWorkflowOnboarded('account-b');
    const listener = vi.fn();
    const stop = subscribeMessageWorkflowPreference(listener, 'account-b');
    try {
      await saveMessageWorkflowPreference('workstreams', 'account-a');
      expect(await readMessageWorkflowOnboarded('account-b')).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('never imports an unscoped legacy preference into a different account', async () => {
    storage.clear();
    storage.set('org.unionground.app.messaging-workflow-v1', 'workstreams');
    storage.set('org.unionground.app.messaging-workflow-onboarded-v1', 'complete');
    expect(await readMessageWorkflowPreference('new-account')).toBe(messageWorkflowDefault);
    expect(await readMessageWorkflowOnboarded('new-account')).toBe(false);
  });

  it('includes Spanish for the compact settings rows', () => {
    const t = nativeUiText('es');
    for (const label of ['About Home', 'Pulse opens with', 'How should Pulse open?', 'This week first', 'Charts first', 'Show Home guide', 'Hide Home guide'] as const) {
      expect(t(label)).not.toBe(label);
    }
  });
});
