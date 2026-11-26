// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { act, createElement as h, type PropsWithChildren, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionCheckStatus } from './SessionCheckStatus';

vi.mock('react-native', () => ({
  View: (props: Parameters<typeof View>[0]) => View(props),
  ActivityIndicator: () => h('span', null, 'spinner'),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('./ui', () => ({ Body: (props: Parameters<typeof Body>[0]) => Body(props), Button: (props: Parameters<typeof Button>[0]) => Button(props) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ primary: '#14201c' }) }));

const View = ({ children, accessible, accessibilityRole, accessibilityLabel, accessibilityLiveRegion }: PropsWithChildren<{
  accessible?: boolean; accessibilityRole?: string; accessibilityLabel?: string; accessibilityLiveRegion?: 'polite';
}>) => h('div', { role: accessibilityRole, 'aria-label': accessible ? accessibilityLabel : undefined, 'aria-live': accessibilityLiveRegion }, children);
const Body = ({ children }: PropsWithChildren) => h('p', null, children);
const Modal = ({ children }: PropsWithChildren) => h('section', { role: 'dialog' }, children);
const Button = ({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) =>
  h('button', { 'aria-label': label, disabled: disabled || busy, onClick: onPress }, label);

const source = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
const tree = ts.createSourceFile('_layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let modal = '';
function visit(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'Modal'
    && node.getText(tree).includes('privacyCoverContent(appActive)')) modal = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
if (!modal) throw new Error('The production privacy-cover modal was not found');

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function render(onRetry: () => Promise<boolean>, appActive = true, sessionRetryBusy = false, demoExit = 'none') {
  const node = runInNewContext(ts.transpile(`(${modal})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }), {
    React, Modal,
    View, Body, Button, SessionCheckStatus, ActivityIndicator: () => h('span', null, 'spinner'),
    Heading: Body, Ionicons: () => null, Pressable: View, Text: Body,
    theme: {}, styles: {}, deletionOutcome: null, privacyCovered: true, locked: false,
    pathname: '/home', appActive, privacyCoverContent: (active: boolean) => active ? 'checking' : 'blank',
    coverLabel: 'Checking your secure session…', retrySessionAuthentication: onRetry, sessionRetryBusy,
    unlock: vi.fn(), signOut: vi.fn(), signOutError: null, router: { push: vi.fn() },
    demoExit, StoreDemoExit: ({ placement }: { placement: string }) => h('button', { 'aria-label': 'Exit demo', 'data-placement': placement }, 'DEMO · Exit demo'),
  }) as ReactNode;
  await act(async () => root.render(node));
}

it('shows an accessible Retry and honest delay status after five seconds', async () => {
  const retry = vi.fn(async () => true);
  await render(retry);
  expect(container.textContent).toContain('Checking your secure session…');
  expect(container.querySelector('button')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');
  expect(button).not.toBeNull();
  expect(button!.closest('[role="progressbar"]')).toBeNull();
  expect(container.textContent).toContain('longer than expected');
  await act(async () => button!.click());
  expect(retry).toHaveBeenCalledOnce();
});

it('keeps the background cover blank and cancels its delayed control on unmount', async () => {
  const retry = vi.fn(async () => true);
  await render(retry, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(container.textContent).toBe('');
  expect(retry).not.toHaveBeenCalled();
});

it('keeps Retry visibly busy while the provider owns an automatic check', async () => {
  const retry = vi.fn(async () => false);
  await render(retry);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await render(retry, true, true);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Retrying…"]');
  expect(button?.disabled).toBe(true);
  await act(async () => button!.click());
  expect(retry).not.toHaveBeenCalled();
  await render(retry, true, false);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')?.disabled).toBe(false);
});

it('exposes a disabled busy state and permits another retry after failure', async () => {
  let finish!: (result: boolean) => void;
  const retry = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  await render(retry);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  const busy = container.querySelector<HTMLButtonElement>('button[aria-label="Retrying…"]');
  expect(busy?.disabled).toBe(true);
  await act(async () => busy!.click());
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => finish(false));
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')?.disabled).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(retry).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => finish(false));
  expect(container.textContent).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

// Gate stage 122 on #8680 (r1s1/r2s1): a store-demo session check that never
// resolves (SAMPLE unreachable) still offers Exit demo inside the cover.
it('offers Exit demo inside the session check cover in the store demo, and only there', async () => {
  await render(vi.fn(async () => false), true, false, 'cover');
  const exit = container.querySelector('[aria-label="Exit demo"]');
  expect(exit?.getAttribute('data-placement')).toBe('inline');
  await act(async () => root.render(null));
  await render(vi.fn(async () => false), true, false, 'none');
  expect(container.querySelector('[aria-label="Exit demo"]')).toBeNull();
});
