vi.mock('react', async () => await import('react'));
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ language: 'en', load: vi.fn(), scimReleased: vi.fn() }));

vi.mock('../apps/mobile/src/state/AppProvider', () => ({
  useApp: () => ({ memberLanguage: mock.language, dashboard: null }),
}));

vi.mock('react-native', () => ({
  View: ({ children }) => <div>{children}</div>,
}));
vi.mock('../apps/mobile/src/components/ui', () => ({
  Screen: ({ children }) => <div>{children}</div>,
  Heading: ({ children }) => <h2>{children}</h2>,
  Body: ({ children }) => <p>{children}</p>,
  Card: ({ children }) => <article>{children}</article>,
  Button: ({ label, onPress }) => <button type="button" onClick={onPress}>{label}</button>,
  StateMessage: ({ title, body, action }) => (
    <section>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  ),
}));
vi.mock('../apps/mobile/src/components/StatusPill', () => ({
  StatusPill: ({ label }) => <span data-testid="status-pill">{label}</span>,
}));
vi.mock('../apps/mobile/src/services/supabase', () => ({
  isMfaRequiredRpcError: (error) => Boolean(error) && error.code === '42501' && /mfa required/i.test(String(error.message ?? '')),
  isNotAuthorizedRpcError: (error) => {
    if (!error || error.code !== '42501') return false;
    const message = String(error.message ?? '');
    if (/mfa required/i.test(message)) return false;
    return /not authorized|authentication required|active organization membership required/i.test(message);
  },
  loadMobileIntegrationProviders: (...args) => mock.load(...args),
  loadMobileScimReleased: (...args) => mock.scimReleased(...args),
}));

import { IntegrationControlsScreen } from '../apps/mobile/src/features/mi1/IntegrationControlsScreen';
import { buildNativeActor } from '../apps/mobile/src/lib/mi1Shared';

const manager = buildNativeActor({
  userId: 'member-1',
  organizationId: '11111111-1111-4111-8111-111111111111',
  chapterId: 'wor',
  roles: ['admin'],
  organizationRoles: ['admin'],
  selectedHat: 'admin',
  authenticated: true,
  mfaSatisfied: true,
});
const connected = [{ id: 'row-1', provider: 'twilio', status: 'connected', allowChapterOverrides: false }];

beforeEach(() => {
  mock.language = 'en';
  mock.load.mockReset();
  mock.scimReleased.mockReset();
  mock.scimReleased.mockResolvedValue(false);
});

function mount(actor = manager, persisted = true) {
  return render(<IntegrationControlsScreen actor={actor} persisted={persisted} />);
}

it('hides provider cards while a live status read is in flight', async () => {
  let finish;
  mock.load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount();
  expect(screen.getByText('Loading setup')).toBeInTheDocument();
  expect(screen.queryByText('SMS (Twilio)')).not.toBeInTheDocument();
  expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  expect(mock.load).toHaveBeenCalledTimes(1);
  await act(async () => finish(connected));
  expect(await screen.findByText('SMS (Twilio)')).toBeInTheDocument();
  expect(screen.getAllByTestId('status-pill').map((node) => node.textContent)).toContain('Connected');
});

it('retries a rejected load from the rendered Try again control', async () => {
  mock.load.mockRejectedValueOnce(new Error('backend unavailable'));
  mount();
  expect(await screen.findByText('Setup unavailable')).toBeInTheDocument();
  expect(screen.queryByText('SMS (Twilio)')).not.toBeInTheDocument();
  expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  expect(mock.load).toHaveBeenCalledTimes(1);
  mock.load.mockResolvedValueOnce(connected);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('SMS (Twilio)')).toBeInTheDocument();
  expect(mock.load).toHaveBeenCalledTimes(2);
});

it.each([
  ['mfa required', 'Two-step required'],
  ['not authorized', 'Admin or campaign chair only'],
  ['authentication required', 'Admin or campaign chair only'],
  ['active organization membership required', 'Admin or campaign chair only'],
])('keeps %s off the retry surface', async (message, title) => {
  mock.load.mockRejectedValueOnce({ code: '42501', message });
  mount();
  expect(await screen.findByText(title)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(screen.queryByText('SMS (Twilio)')).not.toBeInTheDocument();
  expect(mock.load).toHaveBeenCalledTimes(1);
});

it('lists the preview catalog without status pills and without a live read', () => {
  mount(manager, false);
  expect(screen.getByText('Preview catalog')).toBeInTheDocument();
  expect(screen.getByText('SMS (Twilio)')).toBeInTheDocument();
  expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  expect(mock.load).not.toHaveBeenCalled();
  // Directory sync is held with single sign-on (#9037): the preview never names it.
  expect(screen.queryByText('SCIM provisioning')).not.toBeInTheDocument();
  expect(mock.scimReleased).not.toHaveBeenCalled();
});

// REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117 (#9037).
it.each([
  ['held', () => Promise.resolve(false)],
  ['unreadable', () => Promise.reject(new Error('offline'))],
])('leaves the directory sync card out while its release read is %s', async (_state, answer) => {
  mock.load.mockResolvedValue(connected);
  mock.scimReleased.mockImplementation(answer);
  mount();
  expect(await screen.findByText('SMS (Twilio)')).toBeInTheDocument();
  await act(async () => {});
  expect(mock.scimReleased).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('SCIM provisioning')).not.toBeInTheDocument();
  expect(screen.queryByText(/SCIM directory provisioning/)).not.toBeInTheDocument();
});

// Round 1 of #9064 (r1s2): Try again reads the release again, so a transient
// failure does not keep a released card hidden until the screen remounts.
it('reads the directory sync release again from Try again', async () => {
  mock.load.mockRejectedValueOnce(new Error('backend unavailable'));
  mock.scimReleased.mockRejectedValueOnce(new Error('backend unavailable'));
  mount();
  expect(await screen.findByText('Setup unavailable')).toBeInTheDocument();
  expect(mock.scimReleased).toHaveBeenCalledTimes(1);
  mock.load.mockResolvedValueOnce(connected);
  mock.scimReleased.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('SCIM provisioning')).toBeInTheDocument();
  expect(mock.scimReleased).toHaveBeenCalledTimes(2);
});

it('shows the directory sync card once the server answers released', async () => {
  mock.load.mockResolvedValue(connected);
  mock.scimReleased.mockResolvedValue(true);
  mount();
  expect(await screen.findByText('SCIM provisioning')).toBeInTheDocument();
  expect(screen.getByText(/SCIM directory provisioning is set up by an organization admin/)).toBeInTheDocument();
});


it.each([
  ['en', ['Setup requested', 'Connected', 'Configured', 'Disabled', 'Not set up', 'Needs attention', 'Connection status unavailable'], 'Revoked'],
  ['es', ['Configuración solicitada', 'Conectada', 'Configurada', 'Deshabilitada', 'Sin configurar', 'Necesita atención', 'Estado de la conexión no disponible'], 'Revocada'],
])('uses plain connection states in %s after a successful read', async (language, labels, revoked) => {
  mock.language = language;
  const cards = [
    ['google_calendar', 'Google Calendar', 'requested'],
    ['twilio', 'SMS (Twilio)', 'connected'],
    ['microsoft_calendar', 'Microsoft Calendar', 'configured'],
    ['constant_contact', 'Constant Contact', 'disabled'],
    ['google_drive', 'Google Drive', null],
    ['customer_webhooks', 'Webhooks', 'degraded'],
    ['customer_api', 'API keys', 'future_state'],
  ];
  mock.load.mockResolvedValue(cards.flatMap(([provider, , status]) => status === null ? [] : [
    { id: provider, provider, status, allowChapterOverrides: false },
  ]));
  mount();

  await screen.findByRole('heading', { name: 'Webhooks' });
  for (const [index, [, name]] of cards.entries()) {
    const card = screen.getByRole('heading', { name }).closest('article');
    expect(within(card).getByTestId('status-pill').textContent).toBe(labels[index]);
  }
  // The contract-ingest card is left out of this edition; the revoked state is
  // read on another provider instead.
  cleanup();
  mock.load.mockResolvedValue([{ id: 'constant_contact', provider: 'constant_contact', status: 'revoked', allowChapterOverrides: false }]);
  mount();
  const revokedCard = (await screen.findByRole('heading', { name: 'Constant Contact' })).closest('article');
  expect(within(revokedCard).getByTestId('status-pill').textContent).toBe(revoked);
});
