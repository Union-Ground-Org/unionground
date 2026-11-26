import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { beforeEach, expect, it, vi } from 'vitest';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const harness = vi.hoisted(() => ({ cursor: 0, rows: [] as Array<{ id: string; name: string; initials: string }>, presses: new Map<string, () => void>() }));
type ReactModule = typeof import('react');
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useState: () => [['', harness.rows, 'ready'][harness.cursor++], vi.fn()],
  useEffect: () => {},
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, View: 'section', Text: 'span', TextInput: 'input' }));
vi.mock('./ui', () => ({
  Body: 'p', Notice: 'p', SearchField: () => null,
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => { harness.presses.set(label, onPress); return createElement('button', { 'aria-label': label }, label); },
}));
vi.mock('../services/supabase', () => ({ captureSessionWriter: vi.fn() }));
vi.mock('../data/channelControls', () => ({ channelControlsApi: {} }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
import { MentionPickerPanel } from './ChannelControls';

beforeEach(() => { harness.cursor = 0; harness.presses.clear(); harness.rows = ['tamarack-east', 'tamarack-west'].map((id) => ({ id, name: 'Alex Rivera', initials: 'AR' })); });
it.each([0, 1])('visibly names and selects exact Tamarack namesake %s', (index) => {
  const onPick = vi.fn();
  const html = renderToStaticMarkup(createElement(MentionPickerPanel, { spaceID: 'tamarack-space', disabled: false, open: true, onClose: vi.fn(), onPick }));
  for (const person of harness.rows) expect(html).toContain(`aria-label="Mention Alex Rivera (${person.id})">Mention Alex Rivera (${person.id})`);
  harness.presses.get(`Mention Alex Rivera (${harness.rows[index]!.id})`)!();
  expect(onPick).toHaveBeenCalledWith(harness.rows[index]);
});
it('keeps a unique name unchanged', () => {
  harness.rows = [harness.rows[0]!];
  const html = renderToStaticMarkup(createElement(MentionPickerPanel, { spaceID: 'tamarack-space', disabled: false, open: true, onClose: vi.fn(), onPick: vi.fn() }));
  expect(html).toContain('aria-label="Mention Alex Rivera">Mention Alex Rivera');
  expect(html).not.toContain('tamarack-east');
});
