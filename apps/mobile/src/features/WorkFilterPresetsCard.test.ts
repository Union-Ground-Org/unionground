// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act, createElement, useState, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ values: new Map<string, string>(), getItemAsync: vi.fn(), setItemAsync: vi.fn(), announce: vi.fn(() => () => {}) }));
vi.mock('expo-secure-store', () => ({ ...native, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) => createHash('sha256').update(value).digest('hex'),
}));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => native.announce }));
vi.mock('../theme/ThemeProvider', async () => {
  const { themePalette } = await import('../theme/tokens');
  return { useTheme: () => themePalette['union-ground'] };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(value: T) => value },
  View: ({ children, accessibilityRole, accessibilityLabel }: PropsWithChildren<{ accessibilityRole?: string; accessibilityLabel?: string }>) =>
    createElement('div', { role: accessibilityRole, 'aria-label': accessibilityLabel }, children),
  Text: ({ children }: PropsWithChildren) => createElement('span', {}, children),
  TextInput: ({ value, onChangeText, accessibilityLabel, maxLength, editable, onFocus, onBlur }: {
    value: string; onChangeText: (value: string) => void; accessibilityLabel: string; maxLength?: number;
    editable: boolean; onFocus: () => void; onBlur: () => void;
  }) => createElement('input', { value, 'aria-label': accessibilityLabel, maxLength, disabled: !editable, onFocus, onBlur,
    onInput: (event) => onChangeText(event.currentTarget.value) }),
}));
vi.mock('../components/ui', () => ({
  Body: ({ children, accessibilityRole }: PropsWithChildren<{ accessibilityRole?: string }>) => createElement('p', { role: accessibilityRole }, children),
  Heading: ({ children }: PropsWithChildren) => createElement('h3', {}, children),
}));
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled, onFocus, onBlur }: PropsWithChildren<{
    accessibilityLabel: string; accessibilityRole: string; accessibilityState: { selected?: boolean }; onPress: () => void;
    disabled?: boolean; onFocus: () => void; onBlur: () => void;
  }>) => createElement('button', { 'aria-label': accessibilityLabel, role: accessibilityRole,
    'aria-checked': accessibilityState.selected, onClick: onPress, disabled, onFocus, onBlur }, children),
}));

import { WorkFilterButton, WorkFilterPresetsCard } from './WorkFilterPresetsCard';
import { workFilterScopeKey } from '../services/workFilterPresets';

const scope = workFilterScopeKey({ backend: 'https://test.example', account: 'test-account', organization: 'test-org', chapter: 'test-chapter' });
let host: HTMLDivElement;
let root: Root;

function Harness({ identity = scope }: { identity?: string }) {
  const [query, setQuery] = useState('');
  return createElement('div', {},
    createElement('input', { 'aria-label': 'Filter campaign work', value: query, onInput: (event) => setQuery(event.currentTarget.value) }),
    createElement(WorkFilterButton, { label: 'Reset filter', onPress: () => setQuery('') }),
    identity ? createElement(WorkFilterPresetsCard, { key: identity, scope: identity, query, onQuery: setQuery }) : null);
}
async function render(identity = scope) { await act(async () => { root.render(createElement(Harness, { identity })); }); }
function control(label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = control(label) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => { control(label).click(); }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.values.clear(); native.announce.mockClear();
  native.getItemAsync.mockReset().mockImplementation(async (key: string) => native.values.get(key) ?? null);
  native.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => { native.values.set(key, value); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('native saved-filter controls with the real preference store', () => {
  it('saves, resets, applies, renames, reloads and deletes through the English controls', async () => {
    await render();
    await type('Filter campaign work', 'todo'); await type('Saved filter name', 'Open');
    await click('Save current filter');
    expect(control('Selected: Open').getAttribute('aria-checked')).toBe('true');
    await click('Reset filter');
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('');
    await click('Apply Open');
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('todo');
    await click('Rename Open'); await type('New name for Open', 'Remaining'); await click('Save new name');
    expect(control('Selected: Remaining')).toBeTruthy();
    await render(''); expect(host.textContent).not.toContain('Remaining');
    await render(); expect(control('Selected: Remaining')).toBeTruthy();
    await click('Delete Remaining');
    expect(host.textContent).not.toContain('Selected: Remaining');
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('todo');
    expect(native.announce).toHaveBeenCalledWith('Filter deleted.');
  });

  it('never restores an active query over typing while a preference read is late', async () => {
    let finish!: (raw: string) => void;
    native.getItemAsync.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render(); await type('Filter campaign work', 'typed before load');
    expect((control('Save current filter') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'todo' }] })); });
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('typed before load');
    expect(control('Apply Open').getAttribute('aria-checked')).toBe('false');
  });

  it('clears the active list on sign-out/revocation and rejects a late result from another scope', async () => {
    let finish!: (raw: string) => void;
    native.getItemAsync.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render(); await render(`${scope}-other-chapter`);
    await act(async () => { finish(JSON.stringify({ version: 1, presets: [{ name: 'Old campaign', query: 'todo' }] })); });
    expect(host.textContent).not.toContain('Old campaign');
    await type('Filter campaign work', 'done'); await type('Saved filter name', 'New campaign'); await click('Save current filter');
    await render(''); expect(host.textContent).not.toContain('New campaign');
    expect(host.querySelector('[aria-label="Saved filter name"]')).toBeNull();
  });

  it('announces invalid storage and failed saves while preserving the current filter', async () => {
    native.getItemAsync.mockResolvedValueOnce('{obsolete');
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No saved filter was applied');
    await type('Filter campaign work', 'done'); await type('Saved filter name', 'Finished');
    native.setItemAsync.mockRejectedValueOnce(new Error('locked'));
    await click('Save current filter');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be updated');
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('done');
    expect(host.textContent).not.toContain('Filter saved.');
    expect(host.querySelector('[role="radio"]')).toBeNull();
  });

  it('keeps saving disabled after a read failure until Retry restores existing filters', async () => {
    native.getItemAsync.mockRejectedValueOnce(new Error('device locked'))
      .mockResolvedValueOnce(JSON.stringify({ version: 1, presets: [{ name: 'Existing', query: 'todo' }] }));
    await render();
    await type('Filter campaign work', 'done'); await type('Saved filter name', 'New');
    expect((control('Save current filter') as HTMLButtonElement).disabled).toBe(true);
    await click('Save current filter');
    expect(native.setItemAsync).not.toHaveBeenCalled();
    await click('Retry saved filters');
    expect(control('Apply Existing')).toBeTruthy();
    expect((control('Filter campaign work') as HTMLInputElement).value).toBe('done');
    expect((control('Save current filter') as HTMLButtonElement).disabled).toBe(false);
    await click('Save current filter');
    expect(JSON.parse([...native.values.values()][0]!)).toEqual({ version: 1,
      presets: [{ name: 'Existing', query: 'todo' }, { name: 'New', query: 'done' }] });
  });
});
