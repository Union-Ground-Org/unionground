// @brand-literal
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVELOPMENT_BRAND_NAME,
  applyBrandName as sharedApplyBrandName,
  resolveBrand,
} from '../../../../src/lib/shared-core/brand.js';
import { TEST_BACKENDS } from '../test/backends';
import { backendAllowedForBrand, parsePhoneBrand, showsOfficialServiceMark } from './brandPolicy';
import { parseMobileConfig } from './configPolicy';

const require = createRequire(import.meta.url);
const babelPlugin = require('../../plugins/babel-brand-name.js') as {
  phoneBrandName: (env: Record<string, string | undefined>, officialAssetsPresent?: boolean) => string;
  phoneBrandInfo: (env: Record<string, string | undefined>) => Record<string, unknown>;
  applyBrandName: (text: string, name: string) => string;
};
const officialDomains = JSON.parse(readFileSync(new URL('../../../../config/official-domains.json', import.meta.url), 'utf8')) as {
  webHosts: string[];
  supabaseOrigins: string[];
};

// process.env is typed loosely by the Expo environment typings; this view keeps
// every read and write in the tests a string or undefined.
const processEnv = process.env as Record<string, string | undefined>;
const brandEnvironment: readonly string[] = ['BRAND_NAME', 'OFFICIAL_BRANDING', 'SOURCE_CODE_URL', 'EAS_BUILD_PROFILE', 'MOBILE_RELEASE_ENV',
  'MOBILE_APPLICATION_ID', 'EXPO_OWNER', 'EAS_PROJECT_ID', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
const saved = Object.fromEntries(brandEnvironment.map((key) => [key, processEnv[key]]));

beforeEach(() => {
  for (const key of brandEnvironment) delete processEnv[key];
  vi.resetModules();
});
afterEach(() => {
  for (const key of brandEnvironment) {
    if (saved[key] === undefined) delete processEnv[key];
    else processEnv[key] = saved[key];
  }
  vi.resetModules();
});

/** The free-form `extra` and `infoPlist` maps of an Expo config, read as unknown values. */
function loose(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

async function loadConfig() {
  vi.resetModules();
  return (await import('../../app.config')).default;
}

function storeIdentity() {
  processEnv.EAS_BUILD_PROFILE = 'production';
  processEnv.MOBILE_APPLICATION_ID = 'org.tamarack.organizing';
  processEnv.EXPO_OWNER = 'tamarack-organizing';
  processEnv.EAS_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
}

// @babel/core ships no type declarations; this is the one call the tests make.
type BabelCore = {
  transformSync(code: string, options: Record<string, unknown>): { code?: string | null } | null;
};

describe('phone app brand (app.config.ts)', () => {
  it('is unbranded by default, with the development name and the neutral icons', async () => {
    const config = await loadConfig();
    expect(config.name).toBe(DEVELOPMENT_BRAND_NAME);
    expect(config.ios?.icon).toBe('./assets/icon.png');
    expect(config.android?.adaptiveIcon?.foregroundImage).toBe('./assets/android-icon-foreground.png');
    expect(JSON.stringify(config.plugins)).toContain('./assets/splash-icon.png');
    expect(JSON.stringify(config)).not.toContain('branding/official');
    expect(loose(config.extra).productName).toBe(DEVELOPMENT_BRAND_NAME);
  });

  it("uses the operator's BRAND_NAME everywhere the app names itself", async () => {
    processEnv.BRAND_NAME = 'Harbor Workspace';
    processEnv.SOURCE_CODE_URL = 'https://git.example.org/harbor/app';
    const config = await loadConfig();
    expect(config.name).toBe('Harbor Workspace');
    expect(loose(config.extra).productName).toBe('Harbor Workspace');
    expect(loose(config.ios?.infoPlist).NSMicrophoneUsageDescription).toBe('Harbor Workspace records voice notes only while you are actively recording in the shortcuts panel.');
    expect(JSON.stringify(config)).not.toContain('Union Ground');
  });

  it('fails a store build without its own name, or with the Union Ground name', async () => {
    storeIdentity();
    await expect(loadConfig()).rejects.toThrow(/BRAND_NAME is not set\. A store build needs a product name/);
    processEnv.BRAND_NAME = 'Union  ground';
    await expect(loadConfig()).rejects.toThrow(/reserved for Union Ground LLC's official builds/);
    processEnv.BRAND_NAME = 'Harbor Workspace';
    expect((await loadConfig()).name).toBe('Harbor Workspace');
  });

  it('uses the official name, icons and mark only with OFFICIAL_BRANDING=1 and branding/official/', async () => {
    processEnv.OFFICIAL_BRANDING = '1';
    storeIdentity();
    const config = await loadConfig();
    expect(config.name).toBe('Union Ground');
    expect(config.ios?.icon).toBe('../../branding/official/mark-tile-1024.png');
    processEnv.BRAND_NAME = 'Harbor Workspace';
    await expect(loadConfig()).rejects.toThrow(/always uses the Union Ground name/);
    delete processEnv.BRAND_NAME;
    processEnv.OFFICIAL_BRANDING = 'yes';
    await expect(loadConfig()).rejects.toThrow(/OFFICIAL_BRANDING must be 1 or unset/);
  });

  it('refuses, in an official build, a backend that is not on the official list, and accepts it unbranded', async () => {
    // A local build (no EAS profile): the managed-build source pins do not apply.
    processEnv.EXPO_PUBLIC_SUPABASE_URL = 'https://operatorproject.supabase.co';
    processEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_operator';
    processEnv.OFFICIAL_BRANDING = '1';
    await expect(loadConfig()).rejects.toThrow(/Official Union Ground builds talk only to the official service/);
    delete processEnv.OFFICIAL_BRANDING;
    processEnv.BRAND_NAME = 'Harbor Workspace';
    expect(loose((await loadConfig()).extra).supabaseUrl).toBe('https://operatorproject.supabase.co');
  });
});

describe('phone app brand at run time (configPolicy, brandPolicy)', () => {
  const backend = { supabaseUrl: TEST_BACKENDS.live.supabaseUrl, supabasePublishableKey: 'sb_publishable_live', portalBaseUrl: TEST_BACKENDS.live.portal };

  it("accepts the operator's configured backend in an unbranded build", () => {
    const config = parseMobileConfig(backend, parsePhoneBrand({ name: 'Harbor Workspace', official: false }));
    expect(config).toMatchObject({ supabaseUrl: TEST_BACKENDS.live.supabaseUrl, backendConfigured: true });
  });

  it('refuses, in an official build, a backend that is not on the official list', () => {
    const official = { name: 'Union Ground', official: true, officialHosts: officialDomains.webHosts, officialSupabaseOrigins: officialDomains.supabaseOrigins };
    expect(officialDomains.supabaseOrigins).not.toContain(TEST_BACKENDS.live.supabaseUrl);
    expect(parseMobileConfig(backend, parsePhoneBrand(official))).toMatchObject({ supabaseUrl: null, backendConfigured: false });
    const listed = { ...official, officialSupabaseOrigins: [TEST_BACKENDS.live.supabaseUrl] };
    expect(parseMobileConfig(backend, parsePhoneBrand(listed))).toMatchObject({ supabaseUrl: TEST_BACKENDS.live.supabaseUrl, backendConfigured: true });
    expect(backendAllowedForBrand(parsePhoneBrand(official), null)).toBe(true);
  });

  it('shows the official service mark only for an official build on an official backend and portal', () => {
    const brand = parsePhoneBrand({ name: 'Union Ground', official: true, officialHosts: ['app.unionground.org'], officialSupabaseOrigins: ['https://official.supabase.co'] });
    const official = { supabaseUrl: 'https://official.supabase.co', portalBaseUrl: 'https://app.unionground.org', backendConfigured: true };
    expect(showsOfficialServiceMark(brand, official)).toBe(true);
    expect(showsOfficialServiceMark({ ...brand, official: false }, official)).toBe(false);
    for (const portalBaseUrl of ['https://app.unionground.org.evil.example', 'https://union-ground.org', 'https://xn--unionground-xyz.org', 'https://app.unionground.org:8443']) {
      expect(showsOfficialServiceMark(brand, { ...official, portalBaseUrl }), portalBaseUrl).toBe(false);
    }
    expect(showsOfficialServiceMark(brand, { ...official, supabaseUrl: 'https://other.supabase.co' })).toBe(false);
    expect(showsOfficialServiceMark(brand, { ...official, backendConfigured: false })).toBe(false);
  });
});

describe('phone build-time name substitution (plugins/babel-brand-name.js)', () => {
  it('resolves the name the way the shared brand rules do', () => {
    for (const env of [
      {}, { BRAND_NAME: 'Harbor Workspace' }, { BRAND_NAME: '  Harbor   Hall ' }, { BRAND_NAME: 'Union Ground' },
      { BRAND_NAME: "Harbor's" }, { OFFICIAL_BRANDING: '1' }, { BRAND_NAME: 'x' },
    ] as Record<string, string>[]) {
      let expected: string;
      try {
        expected = resolveBrand({ brandName: env.BRAND_NAME, officialBranding: env.OFFICIAL_BRANDING, officialAssetsPresent: true }).name;
      } catch {
        expected = DEVELOPMENT_BRAND_NAME;
      }
      expect(babelPlugin.phoneBrandName(env, true), JSON.stringify(env)).toBe(expected);
    }
    expect(babelPlugin.phoneBrandName({ OFFICIAL_BRANDING: '1' }, false)).toBe(DEVELOPMENT_BRAND_NAME);
  });

  it('rewrites text exactly as the shared helper does', () => {
    const text = 'Open Union Ground · UNION GROUND · UNION&nbsp;GROUND · Based on Union Ground (https://unionground.org) · Union Ground LLC';
    expect(babelPlugin.applyBrandName(text, 'Harbor')).toBe(sharedApplyBrandName(text, 'Harbor'));
    expect(babelPlugin.applyBrandName(text, 'Union Ground')).toBe(text);
  });

  it("rewrites the app's strings, templates and JSX text at build time", () => {
    const { transformSync } = require('@babel/core') as BabelCore;
    const plugin: unknown = require('../../plugins/babel-brand-name.js');
    const source = "const a = 'Open Union Ground'; const b = `Welcome to Union Ground, ${name}`; const c = <Text>Union Ground</Text>; const d = 'Based on Union Ground (https://unionground.org)';";
    const run = (filename: string, code = source) => transformSync(code, {
      filename, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] },
      plugins: [[plugin, { brandName: 'Harbor Workspace' }]],
    })?.code ?? '';
    const out = run('/app/src/screen.tsx');
    expect(out).toContain('"Open Harbor Workspace"');
    expect(out).toContain('`Welcome to Harbor Workspace, ${name}`');
    expect(out).toContain('<Text>Harbor Workspace</Text>');
    expect(out).toContain("'Based on Union Ground (https://unionground.org)'");
    expect(run('/app/node_modules/pkg/index.js')).toContain("'Open Union Ground'");
    expect(run('/app/src/brand.ts', `// @brand-literal\n${source}`)).toContain("'Open Union Ground'");
  });

  it('writes the resolved brand into the bundle, with the official mark only in an official build', () => {
    const { transformSync } = require('@babel/core') as BabelCore;
    const plugin: unknown = require('../../plugins/babel-brand-name.js');
    const source = "const injected = typeof __UNIONGROUND_PHONE_BRAND__ === 'undefined' ? undefined : __UNIONGROUND_PHONE_BRAND__; export default injected;";
    const evaluate = (env: Record<string, string>) => {
      const code = transformSync(source, {
        filename: '/app/src/lib/brand.ts', babelrc: false, configFile: false,
        plugins: [[plugin, { brandInfo: babelPlugin.phoneBrandInfo(env) }], '@babel/plugin-transform-modules-commonjs'],
      })?.code ?? '';
      const module = { exports: {} as { default?: Record<string, unknown> } };
      new Function('module', 'exports', code)(module, module.exports);
      return parsePhoneBrand(module.exports.default);
    };
    const unbranded = evaluate({ BRAND_NAME: 'Harbor Workspace' });
    expect(unbranded).toMatchObject({ name: 'Harbor Workspace', official: false, initial: 'H', officialMarkUri: null, officialHosts: [], officialSupabaseOrigins: [] });
    const official = evaluate({ OFFICIAL_BRANDING: '1' });
    expect(official).toMatchObject({ name: 'Union Ground', official: true, officialHosts: officialDomains.webHosts });
    const png = readFileSync(new URL('../../../../branding/official/mark-tile-180.png', import.meta.url)).toString('base64');
    expect(official.officialMarkUri).toBe(`data:image/png;base64,${png}`);
  });
});

describe('About this app (ServiceIdentityCard)', () => {
  it("links to the server's operator page only when the app has a real server", async () => {
    const { operatorPageUrl } = await import('./brandPolicy');
    expect(operatorPageUrl('https://app.tamarack.example')).toBe('https://app.tamarack.example/operator');
    expect(operatorPageUrl('https://unionground.invalid')).toBeNull();
    expect(operatorPageUrl('http://app.tamarack.example')).toBeNull();
  });

  it('carries the attribution notice and the source code link in every build', () => {
    const source = readFileSync(new URL('../components/ServiceIdentityCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('{ATTRIBUTION_NOTICE}');
    expect(source).toContain('phoneBrand.sourceCodeUrl');
    expect(source).toContain('SOURCE_CODE_URL');
    expect(parsePhoneBrand({}).sourceCodeUrl).toBe('https://github.com/Union-Ground-Org/unionground');
    const account = readFileSync(new URL('../../app/(tabs)/account.tsx', import.meta.url), 'utf8');
    expect(account).toContain('<ServiceIdentityCard />');
  });
});
