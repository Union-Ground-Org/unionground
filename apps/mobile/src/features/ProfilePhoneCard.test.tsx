import { stubSessionWriter } from '../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-IOS-ACCOUNT-HAS-NO-PHONE-NUMBER-FIELD-20261117 (#9084):
// a member changes their own phone number and who sees it on Account, and the
// save goes through the website's own profile-details RPCs with every other
// detail sent back unchanged.
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc: mocks.rpc }), session?.user?.id ?? 'member-a'),  getSupabaseClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#21152C', input: '#FFFFFF', border: '#827486', mutedForeground: '#615568', primary: '#3D2A4F', primaryForeground: '#FFFFFF', destructive: '#9A1B1B', appearance: 'light' }) }));
vi.mock('../components/ui', async () => {
  const { Text, View, Pressable } = await import('../testing/reactNativeStandIn');
  return {
    Card: View, Body: Text, Heading: Text,
    Button: ({ label, onPress, disabled, busy, selected }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; selected?: boolean }) => h(Pressable, { accessibilityLabel: label, onPress, disabled: disabled || busy, accessibilityRole: selected === undefined ? 'button' : 'radio', accessibilityState: { disabled: disabled || busy, busy, selected } }),
  };
});

type App = { mode: string; session: { user: { id: string } } | null; sessionRestricted: boolean; memberLanguage: 'en' | 'es'; dashboard: null };
let app: App;
vi.mock('../state/AppProvider', () => ({ useApp: () => app }));
import { ProfilePhoneCard } from './ProfilePhoneCard';
import { PROFILE_PHONE_MAX_LENGTH, PROFILE_PHONE_MIN_LENGTH } from '../services/profileDetails';

const savedRow = {
  pronouns: 'they/them', jobTitle: 'Clerk', worksite: 'North office', shift: 'Days', classification: 'Clerk II',
  workplaceOptions: { worksite: ['North office'], shift: ['Days'], classification: ['Clerk II'] },
  phone: '555 0100', detailsVisibility: 'admins', phoneVisibility: 'only_me',
};

let screen: Rendered | null = null;
async function fill(label: string, value: string) {
  const input = getExposed(screen!.container, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function answer(name: string, data: unknown, error: unknown = null) {
  mocks.rpc.mockImplementation(async (called: string) => (called === name ? { data, error } : { data: savedRow, error: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  app = { mode: 'authenticated', session: { user: { id: 'member-a' } }, sessionRestricted: false, memberLanguage: 'en', dashboard: null };
  mocks.rpc.mockResolvedValue({ data: savedRow, error: null });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('Account phone number on %s', (os) => {
  it('changes the phone number and its visibility and keeps every other saved detail', async () => {
    setPlatform(os);
    screen = await render(h(ProfilePhoneCard));
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_profile_details');
    expect((getExposed(screen.container, 'Phone number') as HTMLInputElement).value).toBe('555 0100');
    expect(getExposed(screen.container, 'Only me').getAttribute('aria-selected')).toBe('true');

    const saved = { ...savedRow, phone: '+1 (508) 555-0123', phoneVisibility: 'admins' };
    answer('set_my_profile_details_v2', saved);
    await fill('Phone number', '  +1 (508) 555-0123 ');
    await press(getExposed(screen.container, 'Me and administrators, in the worker directory'));
    expect(getExposed(screen.container, 'Me and administrators, in the worker directory').getAttribute('aria-selected')).toBe('true');
    await press(getExposed(screen.container, 'Save phone number'));

    expect(mocks.rpc).toHaveBeenCalledWith('set_my_profile_details_v2', {
      p_details: {
        pronouns: 'they/them', jobTitle: 'Clerk', worksite: 'North office', shift: 'Days', classification: 'Clerk II',
        phone: '+1 (508) 555-0123', detailsVisibility: 'admins', phoneVisibility: 'admins',
      },
    });
    expect(screen.container.textContent).toContain('Phone number saved.');
    expect((getExposed(screen.container, 'Phone number') as HTMLInputElement).value).toBe('+1 (508) 555-0123');
  });
});

it('clears the number through the six-field save when the server has no workplace fields', async () => {
  const { shift: _shift, classification: _classification, workplaceOptions: _options, ...older } = savedRow;
  mocks.rpc.mockResolvedValue({ data: older, error: null });
  screen = await render(h(ProfilePhoneCard));
  await fill('Phone number', '   ');
  await press(getExposed(screen.container, 'Save phone number'));
  expect(mocks.rpc).toHaveBeenLastCalledWith('set_my_profile_details', {
    p_pronouns: 'they/them', p_job_title: 'Clerk', p_worksite: 'North office', p_phone: null, p_details_visibility: 'admins', p_phone_visibility: 'only_me',
  });
});

it("names the phone rule only when the server refuses the number's format", async () => {
  screen = await render(h(ProfilePhoneCard));
  answer('set_my_profile_details_v2', null, { code: '22023', message: 'invalid phone number' });
  await fill('Phone number', 'call me');
  await press(getExposed(screen.container, 'Save phone number'));
  expect(screen.container.textContent).toContain('Check it: 7 to 40 characters');

  answer('set_my_profile_details_v2', null, { code: '57014', message: 'canceling statement due to statement timeout' });
  await press(getExposed(screen.container, 'Save phone number'));
  expect(screen.container.textContent).toContain('Your phone number was not saved. Try again in a moment.');
  expect(screen.container.textContent).not.toContain('Check it: 7 to 40 characters');
});

it('offers a retry when the profile cannot be read, and saves nothing', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'authentication required' } });
  screen = await render(h(ProfilePhoneCard));
  expect(screen.container.textContent).toContain('Your phone number could not be loaded.');
  expect(() => getExposed(screen!.container, 'Save phone number')).toThrow();
  await press(getExposed(screen.container, 'Retry'));
  expect((getExposed(screen.container, 'Phone number') as HTMLInputElement).value).toBe('555 0100');
});

it('asks a PIN session to sign in with the password and reads nothing', async () => {
  app.sessionRestricted = true;
  screen = await render(h(ProfilePhoneCard));
  expect(screen.container.textContent).toContain('Sign in with your password to change your phone number.');
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it.each(['anonymous', 'preview', 'mfaRequired'])('draws nothing in %s mode', async (mode) => {
  app.mode = mode;
  screen = await render(h(ProfilePhoneCard));
  expect(screen.container.textContent).toBe('');
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('speaks Spanish for a Spanish profile', async () => {
  app.memberLanguage = 'es';
  screen = await render(h(ProfilePhoneCard));
  expect(screen.container.textContent).toContain('Número de teléfono');
  expect(getExposed(screen.container, 'Guardar número de teléfono')).toBeTruthy();
  expect(getExposed(screen.container, 'Quién ve su número de teléfono')).toBeTruthy();
});

// UX-UG-LIMITS-NEVER-STATED-BEFORE-THEY-ARE-TRIPPED-20261122 (#9467,
// M2-5): the save's phone rule is said under the field, and read with the
// field, before any save, not only after the server refuses the number.
const phoneHints: Array<[App['memberLanguage'], string]> = [
  ['en', 'Digits, spaces and + ( ) . - only, 7 to 40 characters.'],
  ['es', 'Solo dígitos, espacios y + ( ) . -, de 7 a 40 caracteres.'],
];
it.each(phoneHints)('states the phone number rule before a save and ties it to the field in %s', async (language: App['memberLanguage'], hint: string) => {
  app = { ...app, memberLanguage: language };
  screen = await render(h(ProfilePhoneCard));
  expect(screen.container.textContent).toContain(hint);
  const field = getExposed(screen.container, language === 'en' ? 'Phone number' : 'Número de teléfono');
  expect(field.getAttribute('aria-description')).toBe(hint);
  const saves: unknown[][] = mocks.rpc.mock.calls.filter((call: unknown[]) => call[0] === 'set_my_profile_details_v2');
  expect(saves).toHaveLength(0);
});

it('states the same rule the server checks a saved phone number against', () => {
  const sql = readFileSync(fileURLToPath(new NodeURL('../../../../supabase/migrations/20261104113000_learning_period_membership_roles_settings.sql', import.meta.url)), 'utf8');
  const rule = sql.match(/char_length\(clean_phone\) not between ([0-9]+) and ([0-9]+) or clean_phone !~ '\^\[([^\]]+)\]\+\$'/);
  expect(rule).not.toBeNull();
  expect([PROFILE_PHONE_MIN_LENGTH, PROFILE_PHONE_MAX_LENGTH]).toEqual([Number(rule?.[1]), Number(rule?.[2])]);
  // Digits, space, and exactly + ( ) . - besides: the characters the hint lists.
  const allowed = rule?.[3] ?? '';
  expect([...allowed.replace('0-9', '').replace('\\-', '-')].sort()).toEqual([' ', '(', ')', '+', '-', '.'].sort());
});
