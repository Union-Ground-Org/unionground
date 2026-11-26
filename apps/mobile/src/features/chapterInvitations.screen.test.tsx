// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert, exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { canOpenFeature } from '../lib/featureCatalog';
import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import { nativeUiText } from '../lib/nativeUiCopy';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 4 of 4): working as Chapter Administrator or President, an
// officer invites a member and sees the invitation pending, then resends or
// revokes it. The stand-in answers get_member_invitations and the website's
// /api/admin-invitations route as the server does: one pending invitation per
// address, and a create for an address that already has one answers
// "accepted" and sends nothing.

type Row = { id: string; normalizedEmail: string; fullName: string; chapterName: string; status: string; expiresAt: string; acceptedAt: null; revokedAt: string | null };

const backend = vi.hoisted(() => ({
  rows: [] as Row[],
  requests: [] as { url: string; headers: Record<string, string>; body: Record<string, unknown> }[],
  emailsSent: 0,
  // The route stores the invitation, then its answer is lost.
  loseNextReply: false,
  routeError: null as null | { status: number; error: string },
  listRefused: false,
  origin: 'https://sample.unionground.example' as string | null,
  language: 'en' as 'en' | 'es',
  role: 'admin' as string,
  // The session the screen holds (useApp) and the shared client's current one.
  screenUser: 'officer-fixture',
  clientUser: 'officer-fixture',
}));

function rpc(name: string) {
  if (name === 'get_member_invitations') {
    if (backend.listRefused) return { data: null, error: { code: '42501', message: 'admin role required' } };
    return { data: { chapter: { id: 'chapter-fixture', name: 'Tamarack Valley Campaign' }, chapters: [], items: backend.rows.map((row) => ({ ...row })) }, error: null };
  }
  return { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } };
}

async function route(url: string, init: { headers: Record<string, string>; body: string }) {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  backend.requests.push({ url, headers: init.headers, body });
  const reply = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload });
  if (backend.routeError) return reply(backend.routeError.status, { error: backend.routeError.error });
  if (body.action === 'create') {
    const email = String(body.email).toLowerCase();
    if (!backend.rows.some((row) => row.normalizedEmail === email && row.status === 'pending')) {
      backend.rows.unshift({ id: `inv-${backend.rows.length + 1}`, normalizedEmail: email, fullName: String(body.fullName), chapterName: 'Tamarack Valley Campaign', status: 'pending', expiresAt: '2026-11-26T19:00:00Z', acceptedAt: null, revokedAt: null });
      backend.emailsSent += 1;
    }
  } else if (body.action === 'resend') {
    backend.emailsSent += 1;
  } else if (body.action === 'revoke') {
    const row = backend.rows.find((item) => item.id === body.invitationId);
    if (row) { row.status = 'revoked'; row.revokedAt = '2026-11-19T19:30:00Z'; }
  }
  if (backend.loseNextReply) { backend.loseNextReply = false; throw new TypeError('Network request failed'); }
  return reply(202, { accepted: true });
}

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-fixture' }));
// The provider syncs the memory-only resume holder before its children render
// (#9240 PR A); the officer's full scope is spelled here as the provider has it.
vi.mock('../state/AppProvider', async () => {
  const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
  return {
    useApp: () => {
      const app = {
        mode: 'authenticated', memberLanguage: backend.language,
        session: { access_token: 'member-session-fixture', user: { id: backend.screenUser } },
        dashboard: { member: { id: 'officer-fixture', chapterID: 'chapter-fixture', language: backend.language } },
        organizationID: 'org-fixture', chapterMemberships: [{ chapterID: 'chapter-fixture', organizationID: 'org-fixture', selected: true }],
        authorizedRoles: ['admin'], chapterRoles: ['admin'], organizationRoles: [] as string[],
        resumeDraftReads: { dashboard: true, memberships: true, staff: true },
      };
      syncResumeDraftContext(app);
      return app;
    },
  };
});
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => ({
    rpc: async (name: string) => rpc(name),
    auth: { getSession: async () => ({ data: { session: { access_token: `${backend.clientUser}-token`, user: { id: backend.clientUser } } }, error: null }) },
  }),
}));
// The bearer goes only to the issuing backend's own portal.
vi.mock('../services/privateFileAccess', () => ({
  privateFileApiOrigin: () => { if (!backend.origin) throw new Error('unavailable'); return backend.origin; },
}));

import { ChapterInvitationsScreen } from './ChapterInvitationsScreen';
import { syncResumeDraftContext } from '../lib/resumeDraftHolder';

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const text = (view: Rendered) => view.container.textContent ?? '';
const field = (view: Rendered, label: string) => getExposed(view.container, label) as HTMLInputElement;
const creates = () => backend.requests.filter((request) => request.body.action === 'create');
const unconfirmed = 'We could not confirm this invitation was sent. Check the invitations below first; sending it again does not send a second one while it is pending.';

let view: Rendered | null = null;

async function open(): Promise<Rendered> {
  view = await render(h(ChapterInvitationsScreen, { title: 'Invitations' }));
  await settle();
  return view;
}

async function invite(screen: Rendered, name = 'Robin Fixture', email = 'robin.fixture@example.org') {
  await type(field(screen, 'Full name'), name);
  await type(field(screen, 'Email'), email);
  await press(getExposed(screen.container, 'Send invitation'));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T19:00:00Z'));
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
  backend.rows = [];
  backend.requests = [];
  backend.emailsSent = 0;
  backend.loseNextReply = false;
  backend.routeError = null;
  backend.listRefused = false;
  backend.origin = 'https://sample.unionground.example';
  backend.language = 'en';
  backend.screenUser = 'officer-fixture';
  backend.clientUser = 'officer-fixture';
  vi.stubGlobal('fetch', vi.fn((url: string, init: { headers: Record<string, string>; body: string }) => route(url, init)));
  vi.spyOn(Alert, 'alert').mockImplementation((...args: unknown[]) => {
    const buttons: unknown = args[2];
    if (!Array.isArray(buttons)) return;
    const last: unknown = buttons[buttons.length - 1];
    const onPress: unknown = typeof last === 'object' && last !== null ? Reflect.get(last, 'onPress') : null;
    if (typeof onPress === 'function') onPress();
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setPlatform('ios');
});

describe.each<'ios' | 'android'>(['ios', 'android'])('inviting a worker on %s', (os) => {
  it('sends a plain invitation to the issuing portal and lists it as pending', async () => {
    setPlatform(os);
    const screen = await open();
    expect(text(screen)).toContain('No invitations yet.');
    expect(text(screen)).toContain('Tamarack Valley Campaign');
    await invite(screen);
    expect(creates()).toHaveLength(1);
    const [request] = creates();
    expect(request?.url).toBe('https://sample.unionground.example/api/admin-invitations');
    expect(request?.headers.Authorization).toBe('Bearer member-session-fixture');
    expect(request?.body).toEqual({ action: 'create', email: 'robin.fixture@example.org', fullName: 'Robin Fixture', chapterId: 'chapter-fixture', initialRole: null, locale: 'en' });
    expect(text(screen)).toContain('If that address can be invited, the invitation is on its way.');
    expect(text(screen)).toContain('Robin Fixture');
    expect(text(screen)).toContain('Pending · link works until');
    expect(field(screen, 'Full name').value).toBe('');
  });

  it('keeps an invitation whose answer was lost locked and unconfirmed, and sending it again sends no second email', async () => {
    setPlatform(os);
    backend.loseNextReply = true;
    const screen = await open();
    await invite(screen);
    expect(text(screen)).toContain(unconfirmed);
    expect(backend.emailsSent).toBe(1);
    expect(field(screen, 'Full name').disabled).toBe(true);
    await type(field(screen, 'Full name'), 'Someone else');
    expect(field(screen, 'Full name').value).toBe('Robin Fixture');
    expect(exposedNames(screen.container)).toEqual(expect.arrayContaining(['Check the invitations', 'Send again', 'Cancel']));
    // Checking the list shows the pending row and keeps the form.
    await press(getExposed(screen.container, 'Check the invitations'));
    await settle();
    expect(text(screen)).toContain('Pending · link works until');
    expect(field(screen, 'Full name').value).toBe('Robin Fixture');
    expect(text(screen)).toContain(unconfirmed);
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(creates()).toHaveLength(2);
    expect(creates()[1]?.body).toEqual(creates()[0]?.body);
    expect(backend.emailsSent).toBe(1);
    expect(backend.rows).toHaveLength(1);
    expect(text(screen)).not.toContain(unconfirmed);
    expect(field(screen, 'Full name').value).toBe('');
  });

  it('treats an email the server could not confirm as unconfirmed, and Cancel clears it', async () => {
    setPlatform(os);
    backend.routeError = { status: 502, error: 'delivery-status-unavailable' };
    const screen = await open();
    await invite(screen);
    expect(text(screen)).toContain(unconfirmed);
    await press(getExposed(screen.container, 'Cancel'));
    await settle();
    expect(field(screen, 'Full name').disabled).toBe(false);
    expect(field(screen, 'Full name').value).toBe('');
    expect(text(screen)).not.toContain(unconfirmed);
  });

  it('keeps the form editable after a refusal the server answered', async () => {
    setPlatform(os);
    backend.routeError = { status: 422, error: 'email-domain-blocked' };
    const screen = await open();
    await invite(screen, 'Robin Fixture', 'robin@agency.example.gov');
    expect(text(screen)).toContain("Use a personal email address. Government and employer email addresses can't be used for a Union Ground account.");
    expect(field(screen, 'Email').disabled).toBe(false);
    expect(exposedNames(screen.container)).not.toContain('Send again');
  });

  it('resends and revokes a pending invitation', async () => {
    setPlatform(os);
    backend.rows = [{ id: 'inv-9', normalizedEmail: 'casey@example.org', fullName: 'Casey Fixture', chapterName: 'Tamarack Valley Campaign', status: 'pending', expiresAt: '2026-11-25T19:00:00Z', acceptedAt: null, revokedAt: null }];
    const screen = await open();
    await press(getExposed(screen.container, 'Resend the invitation to Casey Fixture'));
    await settle();
    expect(backend.requests.at(-1)?.body).toEqual({ action: 'resend', invitationId: 'inv-9' });
    expect(text(screen)).toContain('Invitation sent again.');
    await press(getExposed(screen.container, 'Revoke the invitation to Casey Fixture'));
    await settle();
    expect(backend.requests.at(-1)?.body).toEqual({ action: 'revoke', invitationId: 'inv-9' });
    expect(text(screen)).toContain('Invitation revoked.');
    expect(text(screen)).toContain('Revoked');
    expect(exposedNames(screen.container)).not.toContain('Revoke the invitation to Casey Fixture');
  });
});

const statusRow = (id: string, fullName: string, status: string, expiresAt: string): Row => ({
  id, normalizedEmail: `${id}@example.org`, fullName, chapterName: 'Tamarack Valley Campaign', status, expiresAt, acceptedAt: null, revokedAt: null,
});

describe.each<'ios' | 'android'>(['ios', 'android'])('invitation statuses on %s (review R-9235 R2)', (os) => {
  it('shows a failed delivery, an acceptance in progress and an expired link as the server sends them, with the website\'s actions', async () => {
    setPlatform(os);
    // A failed delivery clears the link and sets its expiry to the failure time.
    backend.rows = [
      statusRow('inv-failed', 'Dana Failed', 'delivery_failed', '2026-11-19T18:00:00Z'),
      statusRow('inv-accepting', 'Ari Accepting', 'accepting', '2026-11-25T19:00:00Z'),
      statusRow('inv-expired', 'Eli Expired', 'expired', '2026-11-12T19:00:00Z'),
    ];
    const screen = await open();
    expect(text(screen)).toContain('Delivery failed');
    expect(text(screen)).toContain('Being accepted');
    expect(text(screen)).toContain('Expired');
    expect(text(screen)).not.toContain('Pending');
    const names = exposedNames(screen.container);
    for (const name of ['Dana Failed', 'Eli Expired']) {
      expect(names).toContain(`Resend the invitation to ${name}`);
      expect(names).toContain(`Revoke the invitation to ${name}`);
    }
    expect(names).not.toContain('Resend the invitation to Ari Accepting');
    expect(names).not.toContain('Revoke the invitation to Ari Accepting');
    await press(getExposed(screen.container, 'Revoke the invitation to Dana Failed'));
    await settle();
    expect(backend.requests.at(-1)?.body).toEqual({ action: 'revoke', invitationId: 'inv-failed' });
  });

  it('names those statuses in Spanish', async () => {
    setPlatform(os);
    backend.language = 'es';
    backend.rows = [statusRow('inv-failed', 'Dana Failed', 'delivery_failed', '2026-11-19T18:00:00Z'), statusRow('inv-accepting', 'Ari Accepting', 'accepting', '2026-11-25T19:00:00Z')];
    const screen = await open();
    expect(text(screen)).toContain('Falló la entrega');
    expect(text(screen)).toContain('En proceso de aceptación');
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('a change belongs to the account that started it on %s (review R-9235 R1)', (os) => {
  it('sends nothing when another account is signed in by the time a send, resend or revoke would leave', async () => {
    setPlatform(os);
    backend.rows = [statusRow('inv-9', 'Casey Fixture', 'pending', '2026-11-25T19:00:00Z')];
    const screen = await open();
    backend.clientUser = 'second-officer';
    await invite(screen);
    await press(getExposed(screen.container, 'Resend the invitation to Casey Fixture'));
    await settle();
    await press(getExposed(screen.container, 'Revoke the invitation to Casey Fixture'));
    await settle();
    expect(backend.requests).toHaveLength(0);
    expect(text(screen)).toContain('Your session ended. Sign in again, then try again.');
    expect(field(screen, 'Full name').value).toBe('Robin Fixture');
  });

  it('drops a Revoke confirmation answered after the screen closed for another account', async () => {
    setPlatform(os);
    let held: (() => void) | null = null;
    vi.mocked(Alert.alert).mockImplementation((...args: unknown[]) => {
      const buttons: unknown = args[2];
      const last: unknown = Array.isArray(buttons) ? buttons[buttons.length - 1] : null;
      const onPress: unknown = typeof last === 'object' && last !== null ? Reflect.get(last, 'onPress') : null;
      if (typeof onPress === 'function') held = () => { onPress(); };
    });
    backend.rows = [statusRow('inv-9', 'Casey Fixture', 'pending', '2026-11-25T19:00:00Z')];
    const screen = await open();
    await press(getExposed(screen.container, 'Revoke the invitation to Casey Fixture'));
    expect(held).not.toBeNull();
    // Another officer signs in: the keyed screen closes, the dialog's answer arrives later.
    backend.screenUser = 'second-officer';
    backend.clientUser = 'second-officer';
    await screen.unmount();
    view = null;
    await act(async () => { held?.(); await Promise.resolve(); });
    await settle();
    expect(backend.requests).toHaveLength(0);
  });
});

describe('invitation guards', () => {
  it('names a missing name or a bad email and sends nothing', async () => {
    const screen = await open();
    await invite(screen, '', 'robin.fixture@example.org');
    expect(text(screen)).toContain('Add the name of the person you are inviting.');
    await invite(screen, 'Robin Fixture', 'not-an-address');
    expect(text(screen)).toContain('Check the name and email address, then try again.');
    expect(creates()).toHaveLength(0);
  });

  it('sends nothing when the backend has no trusted portal', async () => {
    backend.origin = null;
    const screen = await open();
    await invite(screen);
    expect(backend.requests).toHaveLength(0);
    expect(text(screen)).toContain('The invitation could not be sent. Try again.');
    expect(field(screen, 'Full name').disabled).toBe(false);
  });

  it('says plainly when the account may not read the invitations', async () => {
    backend.listRefused = true;
    const screen = await open();
    expect(text(screen)).toContain('Invitations could not be loaded. This account may not invite workers to this campaign.');
  });

  it('reads in Spanish and sends a Spanish invitation when chosen', async () => {
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    expect(t('Invite a worker')).not.toBe('Invite a worker');
    expect(text(screen)).toContain(t('Invite a worker'));
    // The screen's title reads in Spanish too, never the raw English feature title.
    expect(text(screen)).not.toContain('Invitations');
    await type(field(screen, t('Full name')), 'Robin Fixture');
    await type(field(screen, t('Email')), 'robin.fixture@example.org');
    await press(getExposed(screen.container, t('Send invitation')));
    await settle();
    expect(creates()[0]?.body.locale).toBe('es');
  });

  it('is on the Campaign Administrator and Campaign chair lists and opens only for those hats', () => {
    expect(STAFF_HAT_FUNCTIONS.admin.some((row) => row.href === '/feature/chapter-invitations')).toBe(true);
    expect(STAFF_HAT_FUNCTIONS.vp.some((row) => row.href === '/feature/chapter-invitations')).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-invitations', null, ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-invitations', null, ['vp'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-invitations', null, ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-invitations', null, [])).toBe(false);
  });
});
