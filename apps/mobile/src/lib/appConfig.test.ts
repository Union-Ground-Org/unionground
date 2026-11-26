import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackedEnvironment = [
  'EAS_BUILD_PROFILE',
  'EAS_BUILD_PLATFORM',
  'GOOGLE_SERVICES_JSON',
  'EAS_BUILD_PROJECT_ID',
  'EAS_PROJECT_ID',
  'EXPO_OWNER',
  'MOBILE_APPLICATION_ID',
  'MOBILE_RELEASE_ENV',
  'MOBILE_BUILD_PROFILE',
  'EXPO_PUBLIC_PORTAL_BASE_URL',
  'EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF',
  'EXPO_PUBLIC_SHARE_RECOVERY_TEST_HOOK',
  'EXPO_PUBLIC_PREVIEW_ENABLED',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_SUPABASE_URL',
  'BRAND_NAME',
  'OFFICIAL_BRANDING',
  'SOURCE_CODE_URL',
] as const;
const originalEnvironment = Object.fromEntries(
  trackedEnvironment.map((key) => [key, process.env[key]]),
);
const sampleBackend = JSON.parse(
  readFileSync(new URL('../../../../config/sample-backend.json', import.meta.url), 'utf8'),
) as { sampleSupabaseRef: string; sampleSupabaseOrigin: string; forbiddenSupabaseRefSha256: string[]; forbiddenIdentityTokenSha256: string[] };
const denyListDigest = (value: string) => createHash('sha256').update(`union-ground/deny-list/v1:${value}`).digest('hex');
// Fictional stand-ins on the digest deny list (tests/helpers/denied-identity-fixtures.js);
// the real sibling projects are listed only as digests.
const DENIED_SUPABASE_REFS = ['productionprojectref', 'sampledemoprojectref'];
const easConfig = JSON.parse(
  readFileSync(new URL('../../eas.json', import.meta.url), 'utf8'),
) as {
  cli: Record<string, unknown>;
  build: Record<string, Record<string, unknown>>;
  submit?: Record<string, unknown>;
};
// A fictional self-hosted release identity; the committed one is a placeholder.
const OWN_EAS_PROJECT = '00000000-0000-4000-8000-000000000001';
const OWN_OWNER = 'tamarack-organizing';
const OWN_APPLICATION_ID = 'org.tamarack.organizing';
const PLACEHOLDER_APPLICATION_ID = 'org.example.unionground';
function setOwnIdentity() {
  process.env.MOBILE_APPLICATION_ID = OWN_APPLICATION_ID;
  process.env.EXPO_OWNER = OWN_OWNER;
  process.env.EAS_PROJECT_ID = OWN_EAS_PROJECT;
}

beforeEach(() => {
  for (const key of trackedEnvironment) delete process.env[key];
  // Like the web suite, these cases describe Union Ground LLC's official
  // build (branding/official/); the unbranded default is pinned below.
  process.env.OFFICIAL_BRANDING = '1';
  vi.resetModules();
});

afterEach(() => {
  for (const key of trackedEnvironment) {
    const originalValue = originalEnvironment[key];
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  }
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import('../../app.config')).default;
}

describe('Expo client-bundle configuration', () => {
  it('pins the Union Ground product with the phone-only platform contract and a placeholder application identity', async () => {
    const config = await loadConfig();

    expect(config.name).toBe('Union Ground');
    expect(config.slug).toBe('union-ground-mobile');
    expect(config.scheme).toBe('unionground');
    expect(config.version).toBe('0.3.0');
    expect(config.owner).toBeUndefined();
    expect(config.userInterfaceStyle).toBe('light');
    expect(config.backgroundColor).toBe('#F6F2E9');
    expect(config.ios).toMatchObject({
      bundleIdentifier: PLACEHOLDER_APPLICATION_ID,
      buildNumber: '3',
      icon: '../../branding/official/mark-tile-1024.png',
      supportsTablet: false,
      config: { usesNonExemptEncryption: false },
    });
    expect(config.android).toMatchObject({
      icon: '../../branding/official/mark-tile-1024.png',
      package: PLACEHOLDER_APPLICATION_ID,
      versionCode: 2,
      adaptiveIcon: {
        backgroundColor: '#0A2F26',
        foregroundImage: '../../branding/official/mark-tile-1024.png',
      },
    });
    expect(config.icon).toBeUndefined();
    const splashPlugin = config.plugins?.find((plugin) => (
      Array.isArray(plugin) && plugin[0] === 'expo-splash-screen'
    ));
    expect(splashPlugin).toEqual([
      'expo-splash-screen',
      {
        backgroundColor: '#F6F2E9',
        image: '../../branding/official/mark-tile-1024.png',
        imageWidth: 148,
        android: { imageWidth: 144 },
      },
    ]);
    expect(config.extra).toMatchObject({
      productName: 'Union Ground',
      compassNetworkEnabled: false,
      releaseEnvironment: 'development',
      previewEnabled: true,
      supabaseUrl: '',
      portalBaseUrl: 'https://unionground.invalid',
      appLinksEnabled: false,
    });
    expect(config.extra?.eas).toBeUndefined();
  });

  it('takes the application id, Expo owner and EAS project from the environment', async () => {
    setOwnIdentity();
    const config = await loadConfig();
    expect(config.owner).toBe(OWN_OWNER);
    expect(config.ios?.bundleIdentifier).toBe(OWN_APPLICATION_ID);
    expect(config.android?.package).toBe(OWN_APPLICATION_ID);
    expect(config.extra?.eas).toEqual({ projectId: OWN_EAS_PROJECT });
  });

  it('carries no sibling-product identity, provider, sign-in client, or push entitlement', async () => {
    const config = await loadConfig();
    const serialized = JSON.stringify(config);
    for (const forbidden of [
      'sibling-saas.example', 'net.unionground', 'unionbase', 'Union Base',
      'GIDClientID', 'usesAppleSignIn', 'remote-notification', 'webcredentials', 'googleServicesFile',
      'expo-apple-authentication', 'native-auth',
    ]) expect(serialized, forbidden).not.toContain(forbidden);
    // The sibling product's names and account identifiers, by digest.
    const deniedTokens = (serialized.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
      .flatMap((token) => [token, ...token.split('-')])
      .filter((token) => sampleBackend.forbiddenIdentityTokenSha256.includes(denyListDigest(token)));
    expect(deniedTokens).toEqual([]);
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.plugins).toContain('./plugins/with-local-notifications-only.js');
  });

  it.each([
    'sb_secret_service-role-value',
    'eyJhbGciOiJIUzI1NiJ9.legacy-service-role.jwt',
  ])('rejects a privileged credential before config generation: %s', async (credential) => {
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = credential;
    await expect(loadConfig()).rejects.toThrow(/must be a Supabase publishable key/i);
  });

  it('keeps the media-playback foreground service out of the Android build', async () => {
    const config = await loadConfig();
    expect(config.android?.blockedPermissions).toEqual(expect.arrayContaining([
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    ]));
    expect(config.android?.permissions).toContain('RECORD_AUDIO');
    const audioPlugin = config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-audio');
    expect(audioPlugin?.[1]).toMatchObject({ enableBackgroundPlayback: false });
    // Union Ground declares no background audio on iOS either.
    expect(config.ios?.infoPlist?.UIBackgroundModes ?? []).not.toContain('audio');
  });

  it('embeds only a normalized publishable credential', async () => {
    // An unbranded build: an official one refuses any backend input off the official list.
    delete process.env.OFFICIAL_BRANDING;
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '  sb_publishable_example  ';
    expect((await loadConfig()).extra?.supabasePublishableKey).toBe('sb_publishable_example');
  });

  it('does not embed an environment-supplied bearer-token destination', async () => {
    process.env.EXPO_PUBLIC_PORTAL_BASE_URL = 'https://attacker.example';
    expect((await loadConfig()).extra?.portalBaseUrl).toBe('https://unionground.invalid');
  });

  it.each([
    ['EAS_PROJECT_ID', 'not-a-project', /EAS_PROJECT_ID must be a lowercase EAS project UUID/i],
    ['EAS_PROJECT_ID', '123E4567-E89B-42D3-A456-426614174000', /EAS_PROJECT_ID must be a lowercase EAS project UUID/i],
    ['EXPO_OWNER', 'Owner Name', /EXPO_OWNER must be an Expo account name/i],
    ['MOBILE_APPLICATION_ID', 'Not.An.Id', /MOBILE_APPLICATION_ID must be a lowercase reverse-DNS/i],
    ['MOBILE_APPLICATION_ID', 'single', /MOBILE_APPLICATION_ID must be a lowercase reverse-DNS/i],
  ] as const)('rejects a malformed %s (%s)', async (name, value, message) => {
    process.env[name] = value;
    await expect(loadConfig()).rejects.toThrow(message);
  });

  it('accepts the EAS worker project only when it matches the configured project', async () => {
    setOwnIdentity();
    process.env.EAS_BUILD_PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
    await expect(loadConfig()).rejects.toThrow(/EAS_BUILD_PROJECT_ID must exactly match/i);

    process.env.EAS_BUILD_PROJECT_ID = OWN_EAS_PROJECT;
    expect((await loadConfig()).extra?.eas).toEqual({ projectId: OWN_EAS_PROJECT });

    delete process.env.EAS_PROJECT_ID;
    process.env.EAS_BUILD_PROFILE = 'preview';
    expect((await loadConfig()).extra).toMatchObject({
      eas: { projectId: OWN_EAS_PROJECT },
      releaseEnvironment: 'preview',
    });
  });

  it.each(['staging', 'production'])('refuses a %s store build on the placeholder identity', async (profile) => {
    process.env.EAS_BUILD_PROFILE = profile;
    await expect(loadConfig()).rejects.toThrow(/Store builds need your own MOBILE_APPLICATION_ID, EXPO_OWNER and EAS_PROJECT_ID/);
    setOwnIdentity();
    delete process.env.MOBILE_APPLICATION_ID;
    await expect(loadConfig()).rejects.toThrow(/Store builds need your own/);
  });

  it.each(['preview', 'staging', 'production'])('builds the preview-only %s app with no backend', async (profile) => {
    setOwnIdentity();
    process.env.EAS_BUILD_PROFILE = profile;
    const config = await loadConfig();
    expect(config.extra).toMatchObject({
      supabaseUrl: '',
      supabasePublishableKey: '',
      compassNetworkEnabled: false,
      previewEnabled: true,
    });
  });

  it('pins no backend at all while Union Ground is unprovisioned', () => {
    expect(sampleBackend.sampleSupabaseRef).toBe('');
    expect(sampleBackend.sampleSupabaseOrigin).toBe('');
  });

  it('lists the sibling Supabase projects only as digests', () => {
    expect(sampleBackend.forbiddenSupabaseRefSha256.length).toBeGreaterThanOrEqual(DENIED_SUPABASE_REFS.length);
    for (const digest of sampleBackend.forbiddenSupabaseRefSha256) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(DENIED_SUPABASE_REFS)('refuses the sibling Supabase project %s by digest', async (ref) => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = `https://${ref}.supabase.co`;
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_example';
    await expect(loadConfig()).rejects.toThrow(/cannot use a sibling product's Supabase project/i);
  });

  it.each(['development', 'preview', 'staging', 'production'])('refuses any backend input in a managed %s build until one is pinned in source', async (profile) => {
    setOwnIdentity();
    process.env.EAS_BUILD_PROFILE = profile;
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://unionground-candidate.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_example';
    await expect(loadConfig()).rejects.toThrow(/cannot configure a backend until its exact owner-approved origin is pinned in source/i);

    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    await expect(loadConfig()).rejects.toThrow(/cannot configure a backend until/i);
  });

  it('uses the explicit profile environment during local EAS config evaluation', async () => {
    process.env.MOBILE_RELEASE_ENV = 'preview';
    process.env.EXPO_PUBLIC_PREVIEW_ENABLED = '1';
    const config = await loadConfig();
    expect(config.extra?.releaseEnvironment).toBe('preview');
    expect(config.extra?.previewEnabled).toBe(true);
  });

  it('rejects disagreement between local profile config and the remote builder profile', async () => {
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.MOBILE_RELEASE_ENV = 'staging';
    await expect(loadConfig()).rejects.toThrow(/cannot use mobile release environment staging/i);
  });

  it.each(['unreviewed-profile', 'unionground-development', 'unionground-preview'])('rejects the unknown profile %s', async (profile) => {
    process.env.EAS_BUILD_PROFILE = profile;
    await expect(loadConfig()).rejects.toThrow(/Unsupported EAS build profile/i);
  });

  it.each(['0', 'true'])('rejects a value that would compile out the demo entry: %s', async (value) => {
    process.env.EXPO_PUBLIC_PREVIEW_ENABLED = value;
    await expect(loadConfig()).rejects.toThrow(/must be 1 or unset/i);
  });

  it('keeps share-recovery instrumentation off, and refuses it without an approved backend', async () => {
    expect((await loadConfig()).extra).toMatchObject({ shareRecoveryTestHook: false });
    process.env.EXPO_PUBLIC_SHARE_RECOVERY_TEST_HOOK = '1';
    await expect(loadConfig()).rejects.toThrow(/requires a development build on the approved backend/);
    setOwnIdentity();
    process.env.EAS_BUILD_PROFILE = 'production';
    await expect(loadConfig()).rejects.toThrow(/requires a development build on the approved backend/);
  });

  it.each(['0', 'true'])('rejects an ambiguous share-recovery hook flag: %s', async (value) => {
    process.env.EXPO_PUBLIC_SHARE_RECOVERY_TEST_HOOK = value;
    await expect(loadConfig()).rejects.toThrow(/SHARE_RECOVERY_TEST_HOOK must be 1 or unset/);
  });

  it('allows native deep-link instrumentation only in an explicit development proof build', async () => {
    process.env.MOBILE_RELEASE_ENV = 'development';
    process.env.EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF = '1';
    expect((await loadConfig()).name).toBe('Union Ground');

    process.env.EAS_BUILD_PROFILE = 'production';
    delete process.env.MOBILE_RELEASE_ENV;
    await expect(loadConfig()).rejects.toThrow(/forbidden in store builds/i);
  });

  it.each(['0', 'true'])('rejects an ambiguous native proof flag: %s', async (value) => {
    process.env.EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF = value;
    await expect(loadConfig()).rejects.toThrow(/NATIVE_DEEP_LINK_PROOF must be 1 or unset/i);
  });

  it('maps build profiles to explicit EAS environments and remote versioning', () => {
    expect(easConfig.cli).toEqual({
      version: '22.0.0',
      requireCommit: true,
      appVersionSource: 'remote',
    });
    expect(Object.keys(easConfig.build).sort()).toEqual(['ci-ios-simulator', 'development', 'preview', 'production', 'staging']);
    for (const [name, environment, distribution] of [
      ['development', 'preview', 'internal'],
      ['preview', 'preview', 'internal'],
      ['staging', 'preview', 'store'],
      ['production', 'production', 'store'],
    ] as const) {
      expect(easConfig.build[name]).toMatchObject({
        distribution,
        environment,
        autoIncrement: true,
        env: { MOBILE_RELEASE_ENV: name, EXPO_PUBLIC_PREVIEW_ENABLED: '1' },
      });
    }
    // ci-ios-simulator extends preview but must not consume a build number.
    expect(easConfig.build['ci-ios-simulator']).toMatchObject({
      extends: 'preview',
      environment: 'preview',
      autoIncrement: false,
      ios: { simulator: true },
    });
    expect(easConfig.submit).toEqual({ production: {} });
  });
});
