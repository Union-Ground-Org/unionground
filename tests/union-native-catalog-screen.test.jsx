vi.mock('react', async () => await import('react'));
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ mode: 'authenticated', session: null, profile: vi.fn(), search: vi.fn(), client: vi.fn(), profileClient: vi.fn(), push: vi.fn(), openURL: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('react-native', () => ({ Linking: { openURL: state.openURL } }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ mode: state.mode, session: state.session, dashboard: { member: { language: 'en' } } }) }));
vi.mock('../apps/mobile/src/services/unionCatalog', () => ({ getCatalogProfileClient: state.profileClient, getPublicCatalogClient: state.client, readUnionProfile: state.profile, readUnionSearch: state.search }));
vi.mock('../apps/mobile/src/components/ui', () => ({
  Screen: ({ children }) => <main>{children}</main>,
  Card: ({ children }) => <section>{children}</section>,
  Heading: ({ children }) => <h2>{children}</h2>,
  Body: ({ children, accessibilityRole }) => <p role={accessibilityRole}>{children}</p>,
  Button: ({ label, onPress, disabled }) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  SearchField: ({ value, onChangeText, accessibilityLabel }) => <input aria-label={accessibilityLabel} value={value} onChange={(e) => onChangeText(e.target.value)} />,
  StateMessage: ({ title, body, action }) => <section><h2>{title}</h2><p>{body}</p>{action}</section>,
}));
import { UnionCatalogScreen } from '../apps/mobile/src/features/UnionCatalogScreen';
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
const fixture = { found: true, organization: { name: 'Test Example Council', researchedOn: '2026-09-29' }, parents: [], children: [], childrenTotal: 0, subunits: [], seats: [], contacts: [], sources: [], documents: [{ key: 'test-doc', title: 'Test form', link: { href: 'https://example.org/form.pdf', host: 'example.org' } }] };
beforeEach(() => { vi.resetAllMocks(); state.mode = 'authenticated'; state.session = null; state.client.mockReturnValue({}); state.profileClient.mockReturnValue(null); state.openURL.mockResolvedValue(undefined); });
it('shows loading, retries a failed profile read and opens the original source', async () => {
  let reject;
  state.profile.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<UnionCatalogScreen catalogKey="olms-900000001" />);
  expect(screen.getByRole('alert')).toHaveTextContent('Loading');
  await act(async () => reject(new Error('offline')));
  expect(await screen.findByText('Unable to load public records')).toBeInTheDocument();
  state.profile.mockResolvedValue(fixture);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Test Example Council')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Test form · example.org' }));
  expect(state.openURL).toHaveBeenCalledWith('https://example.org/form.pdf');
});
it('reports an unknown exact identity without a guessed profile', async () => {
  state.profile.mockResolvedValue({ found: false }); render(<UnionCatalogScreen catalogKey="olms-900000001" />);
  expect(await screen.findByText('No published profile')).toBeInTheDocument();
});
it('does not let an old profile response replace a newly selected identity', async () => {
  let finish;
  state.profile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ...fixture, organization: { name: 'Test New Council' } });
  const view = render(<UnionCatalogScreen catalogKey="olms-900000001" />);
  view.rerender(<UnionCatalogScreen catalogKey="olms-900000002" />);
  expect(await screen.findByText('Test New Council')).toBeInTheDocument();
  await act(async () => finish(fixture));
  expect(screen.queryByText('Test Example Council')).not.toBeInTheDocument();
});
it('searches explicitly, shows empty results and disables unsupported paging', async () => {
  state.search.mockResolvedValue({ rows: [], total: 0, hasNext: false, source: 'catalog' });
  render(<UnionCatalogScreen />);
  expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'test-example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('No matching unions')).toBeInTheDocument();
  expect(state.search).toHaveBeenCalledWith({}, 'test-example', 0);
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
});
it('announces an original-source opening failure', async () => {
  state.profile.mockResolvedValue(fixture); state.openURL.mockRejectedValue(new Error('no browser'));
  render(<UnionCatalogScreen catalogKey="olms-900000001" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test form · example.org' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to open this source.');
});
// Document links are for members (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).
const visitorFixture = { ...fixture, documentLinks: 'members', documents: [{ key: 'test-doc', kind: 'contract', title: 'Test contract', asOf: '2026-01-15', link: null }] };
it("reads a member's profile in the member's session and opens a document link", async () => {
  const session = { access_token: 'member-token', user: { id: 'member-1' } };
  const memberClient = { member: true };
  state.session = session; state.profileClient.mockReturnValue(memberClient);
  state.profile.mockResolvedValue({ ...fixture, documentLinks: 'included' });
  render(<UnionCatalogScreen catalogKey="olms-900000001" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test form · example.org' }));
  expect(state.profileClient).toHaveBeenCalledWith(session);
  expect(state.profile).toHaveBeenCalledWith(memberClient, 'olms-900000001');
  expect(state.openURL).toHaveBeenCalledWith('https://example.org/form.pdf');
  expect(screen.queryByText('Document links are for Union Ground members.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Request an invite' })).not.toBeInTheDocument();
});
