// @vitest-environment jsdom
// REQ-UG-NATIVE-HELP-AND-SUPPORT-ENTRY-20261018: the Help and support
// link opens a new email to the support mailbox and keeps the address on
// screen when the OS refuses the mailto URL.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTheme } from '../theme/tokens';

const mocks = vi.hoisted(() => ({ openURL: vi.fn<(url: string) => Promise<boolean>>() }));

vi.mock('react-native', () => ({
  Linking: { openURL: mocks.openURL },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, accessibilityRole, accessibilityLabel, accessibilityHint, disabled, onPress }: {
    children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string; accessibilityHint?: string; disabled?: boolean; onPress?: () => void;
  }) => createElement('button', { role: accessibilityRole, 'aria-label': accessibilityLabel, 'aria-description': accessibilityHint, disabled, onClick: onPress }, children),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('./ui', () => ({
  Body: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  Notice: ({ children }: { children?: ReactNode }) => createElement('p', { role: 'alert' }, children),
}));

const { SupportLink } = await import('./SupportLink');
const { supportEmail } = await import('../lib/supportContact');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.openURL.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function link(): HTMLButtonElement {
  const element = container.querySelector('button');
  if (!element) throw new Error('SupportLink rendered no control');
  return element;
}

describe.skipIf(supportEmail !== null)('SupportLink with no published mailbox', () => {
  it('renders nothing, so no control points at a mailbox that does not exist', () => {
    act(() => { root.render(createElement(SupportLink, { description: 'Help and support' })); });
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

// The mailbox cases run once this edition publishes a support address.
describe.skipIf(supportEmail === null)('SupportLink', () => {
  it('is a link named Help and support that opens a new email to the support mailbox', async () => {
    mocks.openURL.mockResolvedValue(true);
    act(() => { root.render(createElement(SupportLink, { description: 'Email support@unionground.example about the app.' })); });

    expect(link().getAttribute('role')).toBe('link');
    expect(link().getAttribute('aria-label')).toBe('Help and support');
    expect(link().getAttribute('aria-description')).toContain('support@unionground.example');
    expect(container.textContent).toContain('Email support@unionground.example about the app.');

    await act(async () => { link().click(); });

    expect(mocks.openURL).toHaveBeenCalledOnce();
    expect(mocks.openURL).toHaveBeenCalledWith('mailto:support@unionground.example');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(link().disabled).toBe(false);
  });

  it('shows the address in an in-app notice when no mail app opens, and stays usable', async () => {
    mocks.openURL.mockRejectedValue(new Error('No Activity found to handle Intent'));
    act(() => { root.render(createElement(SupportLink, {})); });

    await act(async () => { link().click(); });

    const notice = container.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain('support@unionground.example');
    expect(notice?.textContent).toContain('could not open a mail app');
    expect(link().disabled).toBe(false);
  });

  // The sign-in footer's quiet link: the same named
  // link and mailbox, plain text without the envelope.
  it('drops the envelope in the footer variant and still opens the support mailbox', async () => {
    mocks.openURL.mockResolvedValue(true);
    act(() => { root.render(createElement(SupportLink, {})); });
    expect(container.querySelector('[data-icon="mail-outline"]')).not.toBeNull();

    act(() => { root.render(createElement(SupportLink, { variant: 'footer' })); });
    expect(container.querySelector('[data-icon]')).toBeNull();
    expect(link().getAttribute('role')).toBe('link');
    expect(link().textContent).toBe('Help and support');
    await act(async () => { link().click(); });
    expect(mocks.openURL).toHaveBeenCalledWith('mailto:support@unionground.example');
  });

  it('speaks Spanish copy when asked', () => {
    act(() => { root.render(createElement(SupportLink, { language: 'es' })); });
    expect(link().getAttribute('aria-label')).toBe('Ayuda y soporte');
  });
});
