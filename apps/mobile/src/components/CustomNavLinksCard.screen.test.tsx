// @vitest-environment jsdom
// BUG-UG-PHONE-ACCOUNT-ORGANIZATION-LINKS-FAILED-READ-LOOKS-EMPTY-20261125
// (#9969, carved from #9465): when the organization's links failed to load, the
// Account screen's Links section vanished, exactly as for an organization with
// no links.
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, type Rendered } from '../testing/reactNativeStandIn';
import { nativeUiText } from '../lib/nativeUiCopy';

type Answer = { data: unknown; error: unknown };
const mocks = vi.hoisted(() => ({ rpc: vi.fn<(name: string) => Promise<{ data: unknown; error: unknown }>>(), language: 'en' as 'en' | 'es', mode: 'authenticated', focused: true, announced: [] as string[] }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The shared Notice announces when it mounts; this one records each mount.
vi.mock('./ui', async () => {
  const { useEffect } = await import('react');
  const { Text } = await import('../testing/reactNativeStandIn');
  const { createElement } = await import('react');
  return { ...await import('../testing/uiStandIn'), Notice: ({ children }: { children: string }) => {
    useEffect(() => { mocks.announced.push(children); }, [children]);
    return createElement(Text, null, children);
  } };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-linking', () => ({ openURL: vi.fn(async () => true) }));
vi.mock('expo-router', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: mocks.mode, organizationID: 'org-a', memberLanguage: mocks.language, dashboard: { member: { language: mocks.language } } }) }));
import { CustomNavLinksCard } from './CustomNavLinksCard';

const withLink: Answer = { data: { switches: {
  'text.navigation.custom_link_1_label': 'Fictional worker handbook',
  'text.navigation.custom_link_1_url': 'https://example.org/handbook',
} }, error: null };
let view: Rendered | null = null;
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const text = () => view?.container.textContent ?? '';
afterEach(async () => { await view?.unmount(); view = null; mocks.rpc.mockReset(); mocks.language = 'en'; mocks.mode = 'authenticated'; mocks.focused = true; mocks.announced.length = 0; });

const LINK_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(LINK_LANGUAGES)('the Account Links section, in %s', (language) => {
  const t = nativeUiText(language);
  const failed = t("Your organization's links could not be loaded.");
  const loading = t("Loading your organization's links.");

  it('keeps the Links heading on a failed read, shows a loading line while Try again runs, then the links', async () => {
    mocks.language = language;
    let release: (answer: Answer) => void = () => {};
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'fixture offline' } })
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => { release = resolve; }));
    view = await render(h(CustomNavLinksCard));
    await settle();
    expect(text()).toContain(t('Links'));
    expect(text()).toContain(failed);
    await press(getExposed(view.container, t('Try again')));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(text()).toContain(t('Links'));
    expect(text()).toContain(loading);
    expect(text()).not.toContain(failed);
    await act(async () => { release(withLink); });
    await settle();
    expect(text()).toContain('Fictional worker handbook');
    expect(text()).not.toContain(loading);
  });

  it('leaves no loading line or busy button after a retry cancelled by leaving the session', async () => {
    mocks.language = language;
    let release: (answer: Answer) => void = () => {};
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'fixture offline' } })
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => { release = resolve; }))
      .mockResolvedValue({ data: null, error: { code: 'XX000', message: 'fixture offline' } });
    view = await render(h(CustomNavLinksCard));
    await settle();
    await press(getExposed(view.container, t('Try again')));
    expect(text()).toContain(loading);
    mocks.mode = 'signedOut';
    await view.rerender(h(CustomNavLinksCard));
    expect(text()).toBe('');
    // The cancelled read answers late; nothing comes back.
    await act(async () => { release(withLink); });
    await settle();
    expect(text()).toBe('');
    mocks.mode = 'authenticated';
    await view.rerender(h(CustomNavLinksCard));
    await settle();
    expect(text()).toContain(failed);
    expect(text()).not.toContain(loading);
    expect(getExposed(view.container, t('Try again')).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('does not announce the earlier failure again while a refocus read runs', async () => {
    mocks.language = language;
    let release: (answer: Answer) => void = () => {};
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'fixture offline' } })
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => { release = resolve; }));
    view = await render(h(CustomNavLinksCard));
    await settle();
    expect(mocks.announced).toEqual([failed]);
    mocks.focused = false;
    await view.rerender(h(CustomNavLinksCard));
    mocks.focused = true;
    await view.rerender(h(CustomNavLinksCard));
    // The refocus read is in flight: the failure stays as plain text, not a new notice.
    expect(text()).toContain(failed);
    expect(mocks.announced).toEqual([failed]);
    await act(async () => { release({ data: null, error: { code: 'XX000', message: 'fixture offline' } }); });
    await settle();
    expect(mocks.announced).toEqual([failed, failed]);
  });

  it('shows nothing for a refusal (42501), as before', async () => {
    mocks.language = language;
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'membership required' } });
    view = await render(h(CustomNavLinksCard));
    await settle();
    expect(text()).toBe('');
  });

  it('shows no section for an organization with no links', async () => {
    mocks.language = language;
    mocks.rpc.mockResolvedValue({ data: { switches: {} }, error: null });
    view = await render(h(CustomNavLinksCard));
    await settle();
    expect(mocks.rpc).toHaveBeenCalledWith('get_member_organization_configuration');
    expect(text()).toBe('');
  });
});
