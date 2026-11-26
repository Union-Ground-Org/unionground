// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn<typeof fetch>(), focused: true }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// Metro gives the cross-root hook native React. CI installs only the mobile
// package before this suite, so bind that lifecycle adapter to native React
// here while retaining the real shared request-generation implementation.
// tests/request-generation.test.jsx exercises the shared hook itself.
vi.mock('../lib/useRequestGeneration', async () => {
  const { useLayoutEffect, useMemo } = await import('react');
  const { createRequestGeneration } = await import('../lib/requestGeneration');
  return { useRequestGeneration(scope: unknown) {
    const requests = useMemo(() => createRequestGeneration(), [scope]);
    useLayoutEffect(() => { requests.activate(); return requests.dispose; }, [requests]);
    return requests;
  } };
});
vi.mock('expo-router', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://unionground-live.supabase.co', portalBaseUrl: 'https://app.unionground.example' } }));
vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#21152C', input: '#FFFFFF', border: '#827486', mutedForeground: '#615568' }) }));
vi.mock('./ui', async () => {
  const { Text, View, Pressable } = await import('../testing/reactNativeStandIn');
  return {
    Card: View, Body: Text, Heading: Text,
    Notice: ({ children }: PropsWithChildren) => h(Text, { accessibilityRole: 'alert' }, children),
    Button: ({ label, onPress, disabled, busy, selected }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; selected?: boolean }) => h(Pressable, { accessibilityLabel: label, onPress, disabled: disabled || busy, accessibilityRole: selected === undefined ? 'button' : 'radio', accessibilityState: { disabled: disabled || busy, busy, selected } }),
  };
});

const session = { access_token: 'session-a', user: { id: 'member-a' } } as Session;
const initialApp = () => ({ mode: 'authenticated', session: session as Session | null, organizationID: 'org-a', dashboard: { member: { chapterID: 'chapter-a' } } as { member: { chapterID: string } } | null, chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], memberLanguage: 'en', authorizedRoles: [] as string[], resumeDraftReads: undefined as ResumeDraftReads | undefined });
let app = initialApp();
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(app); return app; } }));
import { MemberInvitationCard } from './MemberInvitationCard';

let screen: Rendered | null = null;
const platforms: ('ios' | 'android')[] = ['ios', 'android'];
const languages: ('en' | 'es')[] = ['en', 'es'];
const enabled = { data: { switches: { 'features.member_invitations.enabled': true } }, error: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fill(label: string, value: string) {
  const input = getExposed(screen!.container, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function fillForm() {
  await fill('Their name', 'Alex Worker');
  await fill('Their email address', 'alex@example.test');
}
beforeEach(() => {
  vi.clearAllMocks();
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  app = initialApp();
  mocks.focused = true;
  mocks.rpc.mockResolvedValue(enabled);
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); vi.unstubAllGlobals(); });

describe.each(platforms)('worker invitation card on %s', (os) => {
  it('offers a labelled form only after the switch read, posts the chosen language and speaks a private answer', async () => {
    setPlatform(os);
    const permission = deferred<typeof enabled>();
    mocks.rpc.mockReturnValue(permission.promise);
    screen = await render(h(MemberInvitationCard));
    expect(screen.container.textContent).not.toContain('Invite someone');
    await act(async () => permission.resolve(enabled));
    expect(screen.container.textContent).toContain('Invite someone to your campaign');
    expect(mocks.rpc).toHaveBeenCalledWith('get_member_organization_configuration');
    expect(getExposed(screen.container, 'Send invitation').getAttribute('aria-disabled')).toBe('true');
    await fillForm();
    expect(getExposed(screen.container, 'English').getAttribute('aria-selected')).toBe('true');
    await press(getExposed(screen.container, 'Español'));
    expect(getExposed(screen.container, 'Español').getAttribute('aria-selected')).toBe('true');
    expect(getExposed(screen.container, 'English').getAttribute('aria-selected')).toBe('false');
    await press(getExposed(screen.container, 'Send invitation'));
    expect(JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body))).toEqual({ action: 'member-send', fullName: 'Alex Worker', email: 'alex@example.test', locale: 'es' });
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toBe('If that address can be invited, the invitation is on its way. It works for 15 minutes.');
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('');
  });
});

it.each([{ data: null, error: null }, { data: { switches: {} }, error: null }, { data: enabled.data, error: { message: 'offline' } }])('offers no form for absent, off or unreadable configuration: %j', async (answer) => {
  mocks.rpc.mockResolvedValue(answer);
  screen = await render(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each(['anonymous', 'preview', 'mfaRequired'])('offers no form in %s mode', async (mode) => {
  app.mode = mode;
  screen = await render(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('does not offer a form without a current home campaign', async () => {
  app.dashboard!.member.chapterID = '';
  screen = await render(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
});

it.each([
  ['not-permitted', 403, "Your account can't send invitations right now."],
  ['email-domain-blocked', 400, 'Use a personal email address.'],
  ['service-unavailable', 503, 'The invitation could not be sent.'],
  ['rate-limited', 429, 'You can send more after Nov 11, 2026 · 8:30 PM ET.'],
] as const)('shows the %s answer without an account or invitation lookup', async (error, status, text) => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error, retryAt: '2026-11-12T01:30:00Z', limit: 'member_daily', message: 'existing account' }), { status }));
  screen = await render(h(MemberInvitationCard));
  await fillForm();
  await press(getExposed(screen.container, 'Send invitation'));
  expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(text);
  expect(screen.container.textContent).not.toContain('existing account');
  expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Alex Worker');
});

it('blocks a second tap while sending and retires the old account’s late answer', async () => {
  const sending = deferred<Response>();
  mocks.fetch.mockReturnValue(sending.promise);
  screen = await render(h(MemberInvitationCard));
  await fillForm();
  await press(getExposed(screen.container, 'Send invitation'));
  const button = getExposed(screen.container, 'Send invitation');
  expect(button.getAttribute('aria-busy')).toBe('true');
  await press(button);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const permission = deferred<typeof enabled>();
  mocks.rpc.mockReturnValue(permission.promise);
  app.session = { ...session, access_token: 'session-b', user: { ...session.user, id: 'member-b' } };
  await screen.rerender(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  await act(async () => { sending.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202 })); permission.resolve(enabled); });
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('');
});

it('retires a prior campaign’s permission and form when the worker changes campaigns', async () => {
  screen = await render(h(MemberInvitationCard));
  await fillForm();
  const permission = deferred<typeof enabled>();
  mocks.rpc.mockReturnValue(permission.promise);
  app = { ...app, dashboard: { member: { chapterID: 'chapter-b' } }, chapterMemberships: [{ chapterID: 'chapter-b', selected: true }] };
  await screen.rerender(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  await act(async () => permission.resolve({ data: { switches: { 'features.member_invitations.enabled': false } }, error: null }));
  expect(screen.container.textContent).toBe('');
});

it('ignores the old account’s late switch read', async () => {
  const oldPermission = deferred<typeof enabled>();
  mocks.rpc.mockReturnValue(oldPermission.promise);
  screen = await render(h(MemberInvitationCard));
  mocks.rpc.mockResolvedValue({ data: { switches: {} }, error: null });
  app.session = { ...session, access_token: 'session-b', user: { ...session.user, id: 'member-b' } };
  await screen.rerender(h(MemberInvitationCard));
  await act(async () => oldPermission.resolve(enabled));
  expect(screen.container.textContent).toBe('');
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('requires a new switch read when the same worker’s session changes', async () => {
  screen = await render(h(MemberInvitationCard));
  await fillForm();
  const permission = deferred<typeof enabled>();
  mocks.rpc.mockReturnValue(permission.promise);
  app.session = { ...session, access_token: 'refreshed-session-a' };
  await screen.rerender(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  await act(async () => permission.resolve(enabled));
  expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Alex Worker');
  await fillForm();
  await press(getExposed(screen.container, 'Send invitation'));
  expect(mocks.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer refreshed-session-a' });
});

it('re-reads the switch on return instead of offering a revoked form', async () => {
  screen = await render(h(MemberInvitationCard));
  mocks.focused = false;
  await screen.rerender(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  mocks.rpc.mockResolvedValue({ data: { switches: {} }, error: null });
  mocks.focused = true;
  await screen.rerender(h(MemberInvitationCard));
  expect(screen.container.textContent).toBe('');
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

async function leaveApp() {
  app = { ...app, mode: 'booting', dashboard: null, resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
  await screen!.rerender(h(MemberInvitationCard));
  expect(screen!.container.textContent).toBe('');
  expect(screen!.container.querySelector('input,button')).toBeNull();
}
async function returnToApp() {
  app = { ...app, mode: 'authenticated', dashboard: { member: { chapterID: 'chapter-a' } }, resumeDraftReads: { dashboard: true, memberships: true, staff: true } };
  await screen!.rerender(h(MemberInvitationCard));
}

describe.each(platforms)('invitation resume on %s', (os) => {
  beforeEach(() => setPlatform(os));
  it.each(languages)('keeps the editor and private completion in %s', async (language) => {
    app.memberLanguage = language;
    const copy = language === 'es' ? {
      title: 'Invite a alguien a su sección', name: 'Su nombre', email: 'Su dirección de correo electrónico', send: 'Enviar invitación',
      success: 'Si esa dirección puede recibir una invitación, ya va en camino. Es válida durante 15 minutos.',
    } : {
      title: 'Invite someone to your campaign', name: 'Their name', email: 'Their email address', send: 'Send invitation',
      success: 'If that address can be invited, the invitation is on its way. It works for 15 minutes.',
    };
    screen = await render(h(MemberInvitationCard));
    expect(screen.container.textContent).toContain(copy.title);
    await fill(copy.name, 'María Núñez');
    await fill(copy.email, 'maria@example.test');
    await press(getExposed(screen.container, 'Español'));
    await leaveApp();
    await returnToApp();
    expect((getExposed(screen.container, copy.name) as HTMLInputElement).value).toBe('María Núñez');
    expect((getExposed(screen.container, copy.email) as HTMLInputElement).value).toBe('maria@example.test');
    expect(getExposed(screen.container, 'Español').getAttribute('aria-selected')).toBe('true');
    expect(mocks.fetch).not.toHaveBeenCalled();
    await press(getExposed(screen.container, copy.send));
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toBe(copy.success);
    expect(JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ fullName: 'María Núñez', email: 'maria@example.test', locale: 'es' });
  });

  it('keeps exact text and invitee language through boot, remount and fresh access, without sending', async () => {
    screen = await render(h(MemberInvitationCard));
    await fill('Their name', '  María Núñez  ');
    await fill('Their email address', '  maria@example.test  ');
    await press(getExposed(screen.container, 'Español'));
    await leaveApp();
    await screen.unmount();
    screen = await render(h(MemberInvitationCard));
    const permission = deferred<typeof enabled>();
    mocks.rpc.mockReturnValue(permission.promise);
    await returnToApp();
    expect(screen.container.textContent).toBe('');
    await act(async () => permission.resolve(enabled));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('  María Núñez  ');
    expect((getExposed(screen.container, 'Their email address') as HTMLInputElement).value).toBe('  maria@example.test  ');
    expect(getExposed(screen.container, 'Español').getAttribute('aria-selected')).toBe('true');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['account', 'organization', 'chapter', 'permissions', 'signout'])('retires the draft on %s change, even if the previous scope returns', async (change) => {
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await press(getExposed(screen.container, 'Español'));
    await leaveApp();
    app = { ...initialApp(),
      ...(change === 'account' ? { session: { ...session, user: { ...session.user, id: 'member-b' } } } : {}),
      ...(change === 'organization' ? { organizationID: 'org-b' } : {}),
      ...(change === 'chapter' ? { dashboard: { member: { chapterID: 'chapter-b' } }, chapterMemberships: [{ chapterID: 'chapter-b', selected: true }] } : {}),
      ...(change === 'permissions' ? { authorizedRoles: ['steward'] } : {}),
      ...(change === 'signout' ? { mode: 'anonymous', session: null } : {}),
    };
    await screen.rerender(h(MemberInvitationCard));
    app = initialApp();
    await screen.rerender(h(MemberInvitationCard));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('');
    expect((getExposed(screen.container, 'Their email address') as HTMLInputElement).value).toBe('');
    expect(getExposed(screen.container, 'English').getAttribute('aria-selected')).toBe('true');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([{ data: { switches: {} }, error: null }, { data: null, error: { code: '42501' } }])('retires held work on confirmed lost access: %j', async (refusal) => {
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await leaveApp();
    mocks.rpc.mockResolvedValue(refusal);
    await returnToApp();
    expect(screen.container.textContent).toBe('');
    mocks.focused = false;
    await screen.rerender(h(MemberInvitationCard));
    mocks.rpc.mockResolvedValue(enabled);
    mocks.focused = true;
    await screen.rerender(h(MemberInvitationCard));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('conceals retained work through unconfirmed provider reads and a temporary invitation read failure', async () => {
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await leaveApp();
    app = { ...app, mode: 'authenticated', dashboard: { member: { chapterID: 'chapter-a' } } };
    await screen.rerender(h(MemberInvitationCard));
    expect(screen.container.textContent).toBe('');
    mocks.rpc.mockRejectedValue(new Error('offline'));
    await returnToApp();
    expect(screen.container.textContent).toBe('');
    mocks.focused = false;
    await screen.rerender(h(MemberInvitationCard));
    mocks.rpc.mockResolvedValue(enabled);
    mocks.focused = true;
    await screen.rerender(h(MemberInvitationCard));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Alex Worker');
  });

  it.each([true, false])('settles a pending send across remount (accepted=%s) without a duplicate', async (accepted) => {
    const sending = deferred<Response>();
    mocks.fetch.mockReturnValue(sending.promise);
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await press(getExposed(screen.container, 'Send invitation'));
    await leaveApp();
    await returnToApp();
    expect(getExposed(screen.container, 'Send invitation').getAttribute('aria-busy')).toBe('true');
    await press(getExposed(screen.container, 'Send invitation'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await act(async () => sending.resolve(new Response(JSON.stringify(accepted ? { accepted: true } : { error: 'service-unavailable' }), { status: accepted ? 202 : 503 })));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe(accepted ? '' : 'Alex Worker');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('settles while concealed (accepted=%s) before fresh access returns', async (accepted) => {
    const sending = deferred<Response>();
    mocks.fetch.mockReturnValue(sending.promise);
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await press(getExposed(screen.container, 'Send invitation'));
    await leaveApp();
    await act(async () => sending.resolve(new Response(JSON.stringify(accepted ? { accepted: true } : { error: 'service-unavailable' }), { status: accepted ? 202 : 503 })));
    expect(screen.container.textContent).toBe('');
    await returnToApp();
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe(accepted ? '' : 'Alex Worker');
    expect(getExposed(screen.container, 'Send invitation').getAttribute('aria-busy')).toBe('false');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a pending send when the fresh switch read is disabled, then consumes its acknowledgement', async () => {
    const sending = deferred<Response>(); mocks.fetch.mockReturnValueOnce(sending.promise);
    screen = await render(h(MemberInvitationCard)); await fillForm();
    await press(getExposed(screen.container, 'Send invitation')); await leaveApp();
    mocks.rpc.mockResolvedValueOnce({ data: { switches: {} }, error: null });
    await returnToApp();
    const { readResumeDraft, resumeDraftKey } = await import('../lib/resumeDraftHolder');
    expect(readResumeDraft(resumeDraftKey(app, 'invitation', 'member-invitation'))?.pending).toBe(true);
    await act(async () => sending.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202 })));
    expect(readResumeDraft(resumeDraftKey(app, 'invitation', 'member-invitation'))).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('translates a retained invitation failure after the worker changes language', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'service-unavailable' }), { status: 503 }));
    screen = await render(h(MemberInvitationCard)); await fillForm();
    await press(getExposed(screen.container, 'Send invitation')); await leaveApp();
    app.memberLanguage = 'es'; await returnToApp();
    expect(screen.container.textContent).toContain('No se pudo enviar la invitación. Revísela e inténtelo de nuevo.');
    expect(screen.container.textContent).not.toContain('The invitation could not be sent.');
  });

  it.each(['account', 'permissions', 'revoked'])('keeps the correct pending owner after a %s decision', async (change) => {
    const sending = deferred<Response>();
    mocks.fetch.mockReturnValue(sending.promise);
    screen = await render(h(MemberInvitationCard));
    await fillForm();
    await press(getExposed(screen.container, 'Send invitation'));
    await leaveApp();
    if (change === 'account') app.session = { ...session, user: { ...session.user, id: 'member-b' } };
    if (change === 'permissions') app.authorizedRoles = ['steward'];
    if (change === 'revoked') mocks.rpc.mockResolvedValue({ data: { switches: {} }, error: null });
    await returnToApp();
    if (change === 'revoked') {
      expect(screen.container.textContent).toBe('');
      mocks.focused = false;
      await screen.rerender(h(MemberInvitationCard));
      mocks.rpc.mockResolvedValue(enabled);
      mocks.focused = true;
      await screen.rerender(h(MemberInvitationCard));
      expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Alex Worker');
      expect(getExposed(screen.container, 'Send invitation').getAttribute('aria-busy')).toBe('true');
      await act(async () => sending.resolve(new Response(JSON.stringify({ error: 'service-unavailable' }), { status: 503 })));
      expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Alex Worker');
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain('The invitation could not be sent.');
      return;
    }
    await fill('Their name', 'Replacement draft');
    await fill('Their email address', 'replacement@example.test');
    await act(async () => sending.resolve(new Response(JSON.stringify({ error: 'service-unavailable' }), { status: 503 })));
    expect((getExposed(screen.container, 'Their name') as HTMLInputElement).value).toBe('Replacement draft');
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
