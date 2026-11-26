// @vitest-environment jsdom
import { act, createElement, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const rendered = vi.hoisted(() => ({
  mode: 'authenticated', session: { user: { id: 'person-a' }, access_token: 'test-a' } as Session | null,
  organizationID: 'org-a' as string | null,
  dashboard: { member: { chapterID: 'chapter-a' } } as { member: { chapterID: string } } | null,
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: ['admin'],
  assuranceUnavailable: false, resumeDraftReads: { dashboard: true, memberships: true, staff: true },
  organizationRoles: [] as string[],
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => rendered }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: Session | null) => ({ userId: session?.user.id ?? null }) }));
import { useBusinessRequests, useBusinessState, useBusinessSubjectState, useBusinessWriter } from './useBusinessWriter';

let root: Root;
let container: HTMLDivElement;
let value = '';
let setDraft: Dispatch<SetStateAction<string>>;
let writer: ReturnType<typeof useBusinessWriter>;
let requests: ReturnType<typeof useBusinessRequests>;
let scope = 'a';
function Probe() {
  [value, setDraft] = useBusinessState('');
  writer = useBusinessWriter();
  requests = useBusinessRequests(writer, scope);
  return createElement('input', { value, readOnly: true });
}
const render = async () => { await act(async () => root.render(createElement(Probe))); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rendered.mode = 'authenticated';
  scope = 'a';
  rendered.session = { user: { id: 'person-a' }, access_token: 'test-a' } as Session;
  rendered.organizationID = 'org-a'; rendered.dashboard = { member: { chapterID: 'chapter-a' } };
  rendered.chapterMemberships = [{ chapterID: 'chapter-a', selected: true }]; rendered.authorizedRoles = ['admin'];
  rendered.assuranceUnavailable = false; rendered.resumeDraftReads = { dashboard: true, memberships: true, staff: true };
  rendered.organizationRoles = [];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('retires permission-dependent continuations for a confirmed new grant, while retaining the composing person’s pending state', async () => {
  await render(); act(() => setDraft('write still pending'));
  const captured = requests.capture();
  rendered.organizationRoles = ['coordinator'];
  await render();
  expect(captured.isCurrent()).toBe(false);
  expect(value).toBe('write still pending');
});

it('settles a captured person and subject without clearing the next subject or replacement person', async () => {
  function Subject() { [value, setDraft] = useBusinessSubjectState(scope, ''); return null; }
  const show = async () => { await act(async () => root.render(createElement(Subject))); };
  await show(); act(() => setDraft('submitted in A')); const captured = setDraft;
  scope = 'b'; await show(); act(() => setDraft('next subject draft'));
  act(() => captured('')); expect(value).toBe('next subject draft');
  rendered.session = { user: { id: 'person-b' }, access_token: 'test-b' } as Session;
  await show(); act(() => setDraft('replacement draft')); act(() => captured('accepted in A'));
  expect(value).toBe('replacement draft');
  rendered.session = { user: { id: 'person-a' }, access_token: 'test-a' } as Session;
  scope = 'a'; await show(); expect(value).toBe('accepted in A');
  scope = 'b'; await show(); expect(value).toBe('next subject draft');
});

it.each(['booting', 'mfaRequired', 'authenticated'])('retains the confirmed person and workspace during a %s recheck', async (mode) => {
  await render(); act(() => setDraft('A is saving'));
  const first = requests.capture(); const originalWriter = writer;
  const ready = { ...rendered };
  Object.assign(rendered, { mode, assuranceUnavailable: mode === 'mfaRequired', organizationID: null, dashboard: null, chapterMemberships: [], authorizedRoles: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
  await render();
  expect(first.isCurrent()).toBe(true); expect(value).toBe('A is saving');
  if (mode !== 'authenticated') expect(writer).not.toBe(originalWriter);
  Object.assign(rendered, ready); await render(); expect(first.isCurrent()).toBe(true);
});

it.each(['other person', 'sign-out', 'confirmed workspace', 'confirmed empty membership'])('retires for %s even after an unresolved recheck', async (change) => {
  await render(); const first = requests.capture();
  rendered.mode = 'booting'; rendered.resumeDraftReads = { dashboard: false, memberships: false, staff: false };
  await render();
  if (change === 'other person') rendered.session = { user: { id: 'person-b' }, access_token: 'test-b' } as Session;
  if (change === 'sign-out') { rendered.mode = 'signed-out'; rendered.session = null; }
  if (change === 'confirmed workspace') { rendered.mode = 'authenticated'; rendered.chapterMemberships = [{ chapterID: 'chapter-b', selected: true }]; rendered.resumeDraftReads.memberships = true; }
  if (change === 'confirmed empty membership') { rendered.mode = 'authenticated'; rendered.chapterMemberships = []; rendered.resumeDraftReads.memberships = true; }
  await render(); expect(first.isCurrent()).toBe(false);
});

it('retires a captured scope on a subject change, return to the same subject, and unmount', async () => {
  await render(); const first = requests.capture();
  expect(first.isCurrent()).toBe(true);
  scope = 'b'; await render(); const second = requests.capture();
  expect(first.isCurrent()).toBe(false); expect(second.isCurrent()).toBe(true);
  scope = 'a'; await render(); const third = requests.capture();
  expect(first.isCurrent()).toBe(false); expect(second.isCurrent()).toBe(false); expect(third.isCurrent()).toBe(true);
  act(() => root.render(null)); expect(third.isCurrent()).toBe(false);
});

it('hides the previous person’s draft immediately and retains it for its owner', async () => {
  await render(); act(() => setDraft('Unsent draft for A'));
  const oldSetter = setDraft;
  const firstWriter = writer;
  rendered.session = { user: { id: 'person-b' }, access_token: 'test-b' } as Session;
  await render(); expect(value).toBe(''); expect(container.querySelector('input')?.value).toBe('');
  expect(writer).not.toBe(firstWriter);
  act(() => setDraft('Unsent draft for B'));
  act(() => oldSetter((old) => `${old}, retained`));
  expect(value).toBe('Unsent draft for B');
  rendered.session = { user: { id: 'person-a' }, access_token: 'renewed-a' } as Session;
  await render(); expect(value).toBe('Unsent draft for A, retained');
});

it('settles an acknowledged draft in its owner’s bucket without clearing the new draft', async () => {
  await render(); act(() => setDraft('A submitted this'));
  const settleA = setDraft;
  rendered.session = { user: { id: 'person-b' }, access_token: 'test-b' } as Session;
  await render(); act(() => setDraft('B is composing'));
  act(() => settleA('')); expect(value).toBe('B is composing');
  rendered.session = { user: { id: 'person-a' }, access_token: 'renewed-a' } as Session;
  await render(); expect(value).toBe('');
});

it('keeps factory identity across the same person’s refresh and separates signed-out state', async () => {
  await render(); const original = writer; act(() => setDraft('A retained'));
  rendered.session = { user: { id: 'person-a' }, access_token: 'renewed-a' } as Session;
  await render(); expect(writer).toBe(original); expect(value).toBe('A retained');
  rendered.mode = 'signed-out'; await render(); expect(value).toBe(''); expect(writer.userId).toBeNull();
  rendered.mode = 'authenticated'; await render(); expect(value).toBe('A retained');
});
