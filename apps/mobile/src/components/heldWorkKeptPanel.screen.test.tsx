// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

const port = vi.hoisted(() => ({ app: {} as Record<string, unknown> }));
vi.mock('react-native', async () => ({ ...await import('../testing/reactNativeStandIn') }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('./ui', async () => ({ ...await import('../testing/uiStandIn') }));

import { HeldWorkKeptPanel } from './HeldWorkKeptPanel';
import {
  noteResumeDraftReadFailure, readResumeDraft, resumeDraftKey, syncResumeDraftContext, writeResumeDraft,
} from '../lib/resumeDraftHolder';

const confirmed = () => ({ mode: 'authenticated', session: { user: { id: 'person-a' } }, organizationID: 'org-a',
  dashboard: { member: { chapterID: 'chapter-a' } }, chapterMemberships: [{ chapterID: 'chapter-a', selected: true }],
  authorizedRoles: [], chapterRoles: [], organizationRoles: [], resumeDraftReads: { dashboard: true, memberships: true, staff: true } });
let screen: Rendered | null = null;
const text = () => screen!.container.textContent ?? '';

beforeEach(() => {
  port.app = { session: { user: { id: 'person-a' } }, locked: false, privacyCovered: false, memberLanguage: 'en', dashboard: null };
  syncResumeDraftContext({ ...confirmed(), mode: 'signedOut', session: null });
  syncResumeDraftContext(confirmed());
  const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
  writeResumeDraft(key, { title: 'Picnic plan', body: 'Bring the banner', locale: 'en', audienceValue: 'chapter:chapter-a', warning: null,
    attempt: { title: 'Picnic plan', body: 'Bring the banner', locale: 'en', operationKey: 'hidden-operation-key' } });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

// #9369 on both phone platforms: after a no-answer read the shell panel shows
// only the person's own typed words, read-only, with Discard and no Send.
describe.each<'ios' | 'android'>(['ios', 'android'])('held-work panel on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('shows the typed words with Discard and no Send after status 0, and discard removes them', async () => {
    screen = await render(h(HeldWorkKeptPanel));
    expect(text()).not.toContain('Bring the banner');
    noteResumeDraftReadFailure({ status: 0, message: 'Failed to fetch' });
    syncResumeDraftContext({ ...confirmed(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
    screen = await render(h(HeldWorkKeptPanel));
    expect(text()).toContain('Picnic plan');
    expect(text()).toContain('Bring the banner');
    expect(text()).toContain('This may already have been sent.');
    expect(text()).not.toContain('hidden-operation-key');
    expect(text()).not.toContain('chapter:chapter-a');
    expect(screen.container.querySelector('textarea')).toBeNull();
    await press(getExposed(screen.container, 'Discard'));
    expect(text()).not.toContain('Bring the banner');
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).toBeNull();
  });

  // Ledger 681: a visible Discard the holder will refuse must read disabled.
  it('disables Discard while the item\u2019s send is pending, with the uncertainty line showing', async () => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    writeResumeDraft(sendKey, { failed: false, saved: false }, true);
    noteResumeDraftReadFailure({ status: 0, message: 'Failed to fetch' });
    syncResumeDraftContext({ ...confirmed(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
    screen = await render(h(HeldWorkKeptPanel));
    expect(text()).toContain('Call the committee member');
    expect(text()).toContain('This may already have been sent.');
    const discards = [...screen.container.querySelectorAll('[aria-label="Discard"]')];
    expect(discards.some(node => node.getAttribute('aria-disabled') === 'true')).toBe(true);
    // #9460: and says why.
    expect(discards.find(node => node.getAttribute('aria-disabled') === 'true')!.getAttribute('aria-description'))
      .toBe('Still sending. You can discard this once the send finishes or fails.');
    await press(discards.find(node => node.getAttribute('aria-disabled') === 'true')!);
    expect(text()).toContain('Call the committee member');
    expect(text()).toContain('Still sending. You can discard this once the send finishes or fails.');
  });

  it('stays empty after a real refusal', async () => {
    noteResumeDraftReadFailure({ status: 403, code: '42501' });
    syncResumeDraftContext({ ...confirmed(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
    screen = await render(h(HeldWorkKeptPanel));
    expect(text()).not.toContain('Bring the banner');
  });
});
