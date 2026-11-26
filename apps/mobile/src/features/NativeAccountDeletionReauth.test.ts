// BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: the native
// deletion card asks a member with no second factor for their password and
// tells each refusal apart instead of "complete two-step verification".
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ StyleSheet: { create: (styles: unknown) => styles }, TextInput: 'TextInput', View: 'View' }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading' }));
vi.mock('../components/SupportLink', () => ({ SupportLink: 'SupportLink' }));
vi.mock('../state/AppProvider', () => ({ useApp: vi.fn() }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, portalBaseUrl: 'https://portal.example.test' } }));

const { deletionIssueCopy } = await import('./NativeAccountDeletion');
const { deleteMobileAccount } = await import('../services/accountDeletion');

describe('native account deletion re-authentication', () => {
  it('names a wrong password, the throttle and the right next step for each worker', () => {
    expect(deletionIssueCopy('reauth-failed', true)).toMatch(/password didn't match/);
    expect(deletionIssueCopy('try-later', true)).toMatch(/Too many password attempts. Wait up to an hour/);
    // Union Ground signs in with email and password only, so no copy may
    // point a worker to a provider or passkey sign-in it does not offer.
    for (const issue of ['reauth-failed', 'try-later', 'not-permitted'] as const) {
      expect(deletionIssueCopy(issue, true)).not.toMatch(/Apple|Google|passkey/);
    }
    expect(deletionIssueCopy('not-permitted', true)).toBe("We couldn't confirm it's you. Enter your password and try again.");
    expect(deletionIssueCopy('not-permitted', false)).toMatch(/two-step code/);
    expect(deletionIssueCopy('not-permitted', true)).not.toMatch(/two-step/);
  });

  it('offers the password field to every worker with no verified TOTP factor', () => {
    const source = readFileSync(new URL('./NativeAccountDeletion.tsx', import.meta.url), 'utf8');
    // A phone or WebAuthn factor cannot be challenged in the app, so it must
    // not hide the password field (Codex P1 on #4620).
    expect(source).toContain("const passwordReauth = !(session?.user?.factors ?? []).some((factor) => factor.status === 'verified' && factor.factor_type === 'totp');");
    expect(source).toMatch(/passwordReauth \? <TextInput accessibilityLabel=\{t\("Your password"\)\}[\s\S]*?secureTextEntry/);
    expect(source).toContain('deleteAccount(confirmation, passwordReauth && password ? password : undefined)');
  });

  it('sends the re-entered password to the portal deletion route', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: { body: string }) => ({ ok: true, status: 200, json: async () => ({ deleted: true, audited: true }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const session = { access_token: 'token', user: { id: 'member' } } as Parameters<typeof deleteMobileAccount>[0];
    await expect(deleteMobileAccount(session, 'DELETE MY ACCOUNT', 'worker password')).resolves.toEqual({ deleted: true, audited: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://portal.example.test/api/account-lifecycle');
    expect(JSON.parse(init.body)).toEqual({ confirmation: 'DELETE MY ACCOUNT', password: 'worker password' });
    await deleteMobileAccount(session, 'DELETE MY ACCOUNT');
    expect(JSON.parse(fetchSpy.mock.calls[1]![1].body)).toEqual({ confirmation: 'DELETE MY ACCOUNT' });
    vi.unstubAllGlobals();
  });
});
