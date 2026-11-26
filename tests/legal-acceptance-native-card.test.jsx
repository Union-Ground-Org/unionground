import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { currentLegalVersions } from '../src/lib/legalInstruments.js';
import { PORTAL_ORIGIN } from './helpers/fictional-provider.js';

const state = vi.hoisted(() => ({ open: vi.fn(), load: vi.fn(), record: vi.fn() }));
vi.mock('react-native', () => ({
  Linking: { openURL: state.open },
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  View: ({ children }) => <div>{children}</div>,
  Modal: ({ children, visible }) => (visible ? <div role="dialog">{children}</div> : null),
  FlatList: ({ data, renderItem, keyExtractor, style }) => <div data-testid="region-list" data-flex={style?.flex}>{data.map((item) => <div key={keyExtractor(item)}>{renderItem({ item })}</div>)}</div>,
  Pressable: ({ children, accessibilityRole, accessibilityLabel, accessibilityState, onPress }) => (
    <button role={accessibilityRole} aria-label={accessibilityLabel} aria-checked={accessibilityState?.checked} onClick={onPress}>{children}</button>
  ),
}));
vi.mock('../apps/mobile/src/components/ui', () => ({
  Card: ({ children }) => <section>{children}</section>,
  Heading: ({ children }) => <h2>{children}</h2>,
  Body: ({ children, accessibilityRole }) => <p role={accessibilityRole}>{children}</p>,
  Button: ({ label, onPress, disabled }) => <button onClick={onPress} disabled={disabled}>{label}</button>,
}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({ primary: '#561b46' }) }));
// The age box's state-change sentence speaks through the app's announcement queue .
vi.mock('../apps/mobile/src/lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => () => {} }));
vi.mock('../apps/mobile/src/services/legalAcceptance', () => ({ loadLegalAcceptance: state.load, recordLegalAcceptance: state.record }));
// Union Ground publishes no legal site yet, so the shipped build links
// nowhere; a fictional site origin exercises the link behaviour.
vi.mock('../apps/mobile/src/lib/legalDocuments', async (original) => ({
  ...await original(),
  LEGAL_SITE_ORIGIN: PORTAL_ORIGIN,
}));
vi.mock('../apps/mobile/src/lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://live-project.example.test' } }));
const acceptanceSession = vi.hoisted(() => ({ user: { id: 'member-a' }, access_token: 'token-a' }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ session: acceptanceSession }) }));
vi.mock('../apps/mobile/src/services/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: acceptanceSession }, error: null }) } }),
}));
// The card reads the store age signal module; this node run has no native
// module, which the reader reports as an unavailable signal.
vi.mock('../apps/mobile/modules/store-age-signal/src/StoreAgeSignalModule', () => ({ default: null }));
vi.mock('../apps/mobile/src/lib/legalAcceptance', async (original) => ({
  ...await original(),
  legalAcceptanceRequirement: (loaded) => ({ reacceptanceRequired: loaded !== null, instruments: ['privacy-policy'] }),
}));

import { LegalAcceptanceCard } from '../apps/mobile/src/features/LegalAcceptanceCard';

beforeEach(() => {
  vi.resetAllMocks();
  state.load.mockResolvedValue({ versions: {} });
  state.open.mockResolvedValue(undefined);
  state.record.mockResolvedValue(true);
});

it('opens every versioned instrument and changelog, preserving consent and recording nothing while reading', async () => {
  render(<LegalAcceptanceCard />);
  const links = await screen.findAllByRole('link');
  expect(links).toHaveLength(6);
  const terms = screen.getByRole('checkbox', { name: 'I have read the current version and I agree to it.' });
  fireEvent.click(terms);
  for (const link of links) fireEvent.click(link);
  expect(state.open.mock.calls.map(([url]) => url)).toEqual([
    `${PORTAL_ORIGIN}/legal/privacy`, `${PORTAL_ORIGIN}/legal/terms`,
    `${PORTAL_ORIGIN}/legal/accessibility`, `${PORTAL_ORIGIN}/legal/ai-disclosure`,
    `${PORTAL_ORIGIN}/legal/retention`, `${PORTAL_ORIGIN}/legal/changelog`,
  ]);
  expect(terms).toHaveAttribute('aria-checked', 'true');
  expect(state.record).not.toHaveBeenCalled();
  // The terms box alone records nothing;
  // a state and the age attestation it selects come first.
  fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose the state where you live and check both boxes');
  expect(state.record).not.toHaveBeenCalled();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'State where you live: Choose your state' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Louisiana' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: "I'm 18 or older." }));
  // Another state changes the sentence and clears the answer.
  fireEvent.click(screen.getByRole('button', { name: 'State where you live: Louisiana' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Outside the United States' }));
  const band = screen.getByRole('checkbox', { name: "I'm 13 or older, and if I'm under 18, my organization authorized this account." });
  expect(band).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(band);
  fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));
  await waitFor(() => expect(state.record).toHaveBeenCalledWith(currentLegalVersions(), 'outside-us', true, acceptanceSession));
});

it('announces an opening failure and permits retry without recording acceptance', async () => {
  state.open.mockRejectedValueOnce(new Error('no browser'));
  render(<LegalAcceptanceCard />);
  const link = await screen.findByRole('link', { name: /Privacy — version/ });
  fireEvent.click(link);
  expect(await screen.findByRole('alert')).toHaveTextContent('The document could not be opened');
  expect(state.record).not.toHaveBeenCalled();
  fireEvent.click(link);
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(state.open).toHaveBeenCalledTimes(2);
});

it('bounds the state list between the heading and Cancel so it scrolls on a phone', async () => {
  render(<LegalAcceptanceCard />);
  fireEvent.click(await screen.findByRole('button', { name: /State where you live/ }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.querySelector('[data-testid="region-list"]').getAttribute('data-flex')).toBe('1');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
});
