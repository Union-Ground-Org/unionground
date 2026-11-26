// Over-the-air updates for the phone apps
// (REQ-UG-PHONE-APPS-OVER-THE-AIR-UPDATES-20261113; rules in
// apps/mobile/AGENTS.md "Over-the-air update contract").
//
// Expo's update server hands an install only an update whose runtime version
// equals the install's own, on the channel the install names. The runtime
// version is Expo's fingerprint of the native project and of the app config the
// build or the publish evaluated. These tests prove that every build profile
// has its own channel and its own runtime version, so an update made for one
// profile (SAMPLE, preview or Production) can never load in another even if it
// is published to the wrong channel, and that any change to native code or
// native settings gives a new runtime version.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateCommandProblems, updateEnvironment } from '../../scripts/update-profile-env.mjs';

type EasProfile = {
  extends?: string;
  channel?: string;
  distribution?: string;
  environment?: string;
  env?: Record<string, string>;
};
type FingerprintHook = (
  source: { type: 'file'; filePath: string } | { type: 'contents'; id: string },
  chunk: Buffer | string | null,
  isEndOfFile: boolean,
  encoding: BufferEncoding,
) => Buffer | string | null;
type RuntimeVersionResolver = (
  projectRoot: string,
  platform: 'ios' | 'android',
  fingerprintOptions: { fileHookTransform?: FingerprintHook },
  otherOptions: { workflowOverride?: 'managed' | 'generic' },
) => Promise<{
  runtimeVersion: string | null;
  fingerprintSources: Array<{ type: string; filePath?: string; id?: string }> | null;
}>;

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
// The resolver the native build and `eas update` use to stamp a runtime version.
const { resolveRuntimeVersionAsync } = require('expo-updates/utils/build/resolveRuntimeVersionAsync') as {
  resolveRuntimeVersionAsync: RuntimeVersionResolver;
};
const easConfig = JSON.parse(readFileSync(new URL('../../eas.json', import.meta.url), 'utf8')) as {
  build: Record<string, EasProfile>;
};
const backends = JSON.parse(readFileSync(new URL('../../../../config/sample-backend.json', import.meta.url), 'utf8')) as {
  saasSupabaseOrigin: string;
  sampleSupabaseRef: string;
};
const approvedEasProjectId = '00000000-0000-4000-8000-00000000e45e';
const profileNames = Object.keys(easConfig.build).sort();
// Staging has no approved backend, so its config refuses to build at all.
const buildableProfiles = profileNames.filter((name) => name !== 'staging');
const storeChannels = ['production', 'staging'];

const trackedEnvironment = [
  'EAS_BUILD_PROFILE',
  'EAS_BUILD_PLATFORM',
  'EAS_BUILD',
  'EAS_BUILD_PROJECT_ID',
  'CI',
  'EAS_UPDATE_SKIP_ENVIRONMENT_CHECK',
  'EXPO_PUBLIC_SENTRY_DSN_IOS',
  'GOOGLE_SERVICES_JSON',
  'MOBILE_BUILD_PROFILE',
  'MOBILE_RELEASE_ENV',
  'EXPO_PUBLIC_PREVIEW_ENABLED',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
] as const;
const originalEnvironment = Object.fromEntries(trackedEnvironment.map((key) => [key, process.env[key]]));

function clearEnvironment(): void {
  for (const key of trackedEnvironment) delete process.env[key];
}

beforeEach(() => {
  clearEnvironment();
  vi.resetModules();
});

// The Firebase Android client file: an EAS secret file, so it exists only on
// the EAS worker, at a path outside the project. The public client shape
// app.config.ts accepts.
const temporaryDirectories: string[] = [];
function firebaseClientFile(projectNumber = '1'): string {
  const directory = mkdtempSync(join(tmpdir(), 'ota-firebase-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'google-services.json');
  writeFileSync(path, JSON.stringify({
    project_info: { project_id: 'union-ground', project_number: projectNumber },
    client: [{ client_info: { android_client_info: { package_name: 'org.example.unionground' } } }],
  }));
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
  for (const key of trackedEnvironment) {
    const value = originalEnvironment[key];
    const environment: Record<string, string | undefined> = process.env;
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  vi.resetModules();
});

// A profile as EAS resolves it: `extends` first, then the profile's own keys,
// with `env` merged key by key.
function resolvedProfile(name: string, seen: string[] = []): EasProfile {
  const profile = easConfig.build[name];
  if (!profile || seen.includes(name)) throw new Error(`Unknown or cyclic EAS profile ${name}.`);
  const parent = profile.extends ? resolvedProfile(profile.extends, [...seen, name]) : {};
  return { ...parent, ...profile, env: { ...parent.env, ...profile.env } };
}

// The hosted EAS environment a profile reads (public values; keys are stand-ins).
// The hosted `production` and `preview` environments hold SAMPLE, `development`
// holds Union Ground (docs/mobile/release-identity-runbook.md).
const sampleOrigin = `https://${backends.sampleSupabaseRef}.supabase.co`;
function hostedEnvironment(name: string): Record<string, string> {
  // This edition has no hosted backend or EAS project of its own. These cases
  // model a fork that configured one: every profile names the (fictional) EAS
  // project, and a store profile also carries the fork's own identity.
  const store = ['staging', 'production'].includes(resolvedProfile(name).environment ?? '');
  return {
    EAS_PROJECT_ID: approvedEasProjectId,
    ...(store ? { MOBILE_APPLICATION_ID: 'org.fictional.unionground', EXPO_OWNER: 'fictional-owner', BRAND_NAME: 'Fictional Union App' } : {}),
  };
}

// The environment the config is evaluated in for this profile, as EAS Build
// makes it: hosted values, then the profile's env over them. The local EAS CLI
// evaluates it before the worker exists ('local'): it has no EAS_BUILD_PROFILE
// and no secret file. The worker ('worker') adds its profile marker and, for
// Android, its platform and the Firebase secret file. Both must give the same
// runtime version, or EAS refuses the build.
function buildEnvironment(name: string, where: 'local' | 'worker' = 'worker', firebaseFile?: string): Record<string, string> {
  return {
    ...hostedEnvironment(name),
    ...resolvedProfile(name).env,
    // Every variable the worker sets that the config or a plugin could read.
    ...(where === 'worker' ? { EAS_BUILD: 'true', EAS_BUILD_PROFILE: name, EAS_BUILD_PROJECT_ID: approvedEasProjectId, CI: '1' } : {}),
    ...(where === 'worker' && firebaseFile ? { EAS_BUILD_PLATFORM: 'android', GOOGLE_SERVICES_JSON: firebaseFile } : {}),
  };
}
function useEnvironment(environment: Record<string, string | undefined>): void {
  clearEnvironment();
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }
}
function useBuildEnvironment(name: string, where: 'local' | 'worker' = 'worker'): void {
  useEnvironment(buildEnvironment(name, where));
}

async function runtimeVersionIn(environment: Record<string, string | undefined>, platform: 'ios' | 'android', fileHookTransform?: FingerprintHook) {
  useEnvironment(environment);
  const result = await resolveRuntimeVersionAsync(projectRoot, platform, { fileHookTransform }, { workflowOverride: 'managed' });
  expect(result.runtimeVersion).toMatch(/^[0-9a-f]{40}$/);
  return result;
}

async function runtimeVersion(name: string, platform: 'ios' | 'android', fileHookTransform?: FingerprintHook) {
  useBuildEnvironment(name);
  const result = await resolveRuntimeVersionAsync(projectRoot, platform, { fileHookTransform }, { workflowOverride: 'managed' });
  expect(result.runtimeVersion).toMatch(/^[0-9a-f]{40}$/);
  return result;
}

// Changes one hashed input the way a native change would, and nothing else.
function changeContents(id: string, change: (contents: string) => string): FingerprintHook {
  return (source, chunk) => (source.type === 'contents' && source.id === id && typeof chunk === 'string' ? change(chunk) : chunk);
}
function changeFile(path: string): FingerprintHook {
  return (source, chunk, isEndOfFile) => {
    if (source.type !== 'file' || source.filePath !== path || !isEndOfFile) return chunk;
    return Buffer.concat([chunk === null ? Buffer.alloc(0) : Buffer.from(chunk), Buffer.from('\n// native change\n')]);
  };
}

describe('over-the-air update channels', () => {
  it('gives every EAS build profile its own channel, named after the profile, in eas.json and in the built config', async () => {
    expect(profileNames).toEqual([
      'ci-ios-simulator',
      'development',
      'preview',
      'production',
      'staging',
    ]);
    for (const name of profileNames) {
      // Set on the profile itself, so no profile inherits its parent's channel
      // or its parent's marker: the local EAS CLI reads only the marker, the
      // worker also sets EAS_BUILD_PROFILE.
      expect(easConfig.build[name]?.channel).toBe(name);
      expect(easConfig.build[name]?.env?.MOBILE_BUILD_PROFILE).toBe(name);
    }
    expect(profileNames.filter((name) => resolvedProfile(name).distribution === 'store')).toEqual(storeChannels);

    for (const name of buildableProfiles) {
      for (const where of ['local', 'worker'] as const) {
        useBuildEnvironment(name, where);
        vi.resetModules();
        const { default: config } = await import('../../app.config');
        expect(config.updates, `${name} ${where}`).toEqual({
          enabled: true,
          url: `https://u.expo.dev/${approvedEasProjectId}`,
          checkAutomatically: 'ON_LOAD',
          fallbackToCacheTimeout: 0,
          requestHeaders: { 'expo-channel-name': name },
        });
      }
    }
  });

  it('turns updates off when no build profile is named', async () => {
    const { default: config } = await import('../../app.config');
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.requestHeaders).toBeUndefined();
  });

  it('refuses a channel for an unknown profile instead of reading a store channel', async () => {
    process.env.EAS_BUILD_PROFILE = 'production-copy';
    await expect(import('../../app.config')).rejects.toThrow(/Unsupported EAS build profile/);
  });
});

describe('over-the-air update runtime versions', () => {
  it('stamps every build with the fingerprint policy and no fixed runtime version', async () => {
    useBuildEnvironment('production');
    const { default: config } = await import('../../app.config');
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(config.ios?.runtimeVersion).toBeUndefined();
    expect(config.android?.runtimeVersion).toBeUndefined();
    // Either file can drop native inputs from the fingerprint, so changing one
    // needs this contract's review. The one ignore line is build state: Kotlin 2
    // writes session files into a Gradle plugin's .kotlin folder while a native
    // build runs, so a build hashed them and a clean `eas update` did not, and
    // no update could ever reach that build (found in the C216 emulator proof).
    // The second is the one dependency file a config plugin edits during iOS
    // prebuild (plugins/with-ios-tab-accessibility.js patches react-native-
    // screens): the worker hashed it patched and the local CLI unpatched. Its
    // patched content is still covered: the package version through
    // autolinking, the patch through the plugin file.
    expect(readFileSync(new URL('../../.fingerprintignore', import.meta.url), 'utf8')).toBe(
      '**/*-gradle-plugin/.kotlin/**/*\n**/node_modules/react-native-screens/ios/tabs/host/RNSTabBarController.mm\n',
    );
    // fingerprint.config.js ignores only the one file GOOGLE_SERVICES_JSON names
    // (the worker-only Firebase secret file), and nothing when it is unset.
    const fingerprintConfig = require('../../fingerprint.config.js') as {
      ignorePaths: string[];
      firebaseClientIgnorePaths(environment: Record<string, string | undefined>): string[];
    };
    expect(Object.keys(fingerprintConfig).sort()).toEqual(['firebaseClientIgnorePaths', 'ignorePaths']);
    expect(fingerprintConfig.firebaseClientIgnorePaths({})).toEqual([]);
    expect(fingerprintConfig.firebaseClientIgnorePaths({ GOOGLE_SERVICES_JSON: ' ' })).toEqual([]);
    expect(fingerprintConfig.firebaseClientIgnorePaths({ GOOGLE_SERVICES_JSON: '/home/expo/workingdir/env/google-services (1).json' }))
      .toEqual([`${relative(projectRoot, '/home/expo/workingdir/env')}/google-services \\(1\\).json`]);
    expect(fingerprintConfig.firebaseClientIgnorePaths({ GOOGLE_SERVICES_JSON: 'google-services.json' })).toEqual(['google-services.json']);
  });

  // EAS refuses a build unless two runtime versions agree: the one the local
  // EAS CLI computes from the checkout, and the one the worker computes after
  // its own native steps. On Android the worker runs `expo prebuild`; on iOS it
  // runs `expo prebuild` and then pod install (that half needs macOS; see the
  // audit in the pull request). A config plugin that edits a fingerprinted file
  // outside the generated ios/ and android/ folders, or a value only the worker
  // has, splits the two (rounds 1, final and final 2 of the gate each found
  // one). This compares the two for every profile and platform in a copy of
  // the project, and no two profiles may share a runtime version. The real
  // prebuild runs for one profile per platform: a prebuild of all eight
  // profiles on both platforms changed the same one fingerprinted file for
  // every profile (the C216 audit), so the other fifteen would only repeat it
  // at about two CI minutes a run. Every other profile still gets the full
  // worker environment against the local one.
  const prebuildProfiles = { ios: 'ci-ios-simulator', android: 'production' } as const;
  it('agrees with the EAS worker after its prebuild for every profile and platform, and no two profiles share a runtime version', async () => {
    const top = mkdtempSync(join(tmpdir(), 'ota-prebuild-'));
    temporaryDirectories.push(top);
    const project = join(top, 'apps', 'mobile');
    const generated = new Set(['node_modules', 'ios', 'android', 'dist', '.expo']);
    cpSync(projectRoot, project, { recursive: true, filter: (source) => !generated.has(relative(projectRoot, source).split(sep)[0] ?? '') });
    symlinkSync(join(projectRoot, 'node_modules'), join(project, 'node_modules'), 'dir');
    symlinkSync(join(projectRoot, '../../config'), join(top, 'config'), 'dir');
    const expoCli = require.resolve('expo/bin/cli');
    const firebase = firebaseClientFile();
    const runtimeIn = async (environment: Record<string, string | undefined>, platform: 'ios' | 'android') => {
      useEnvironment(environment);
      const { runtimeVersion } = await resolveRuntimeVersionAsync(project, platform, {}, { workflowOverride: 'managed' });
      expect(runtimeVersion).toMatch(/^[0-9a-f]{40}$/);
      return runtimeVersion;
    };
    const prebuild = (environment: Record<string, string | undefined>, platform: 'ios' | 'android') => {
      const result = spawnSync(process.execPath, [expoCli, 'prebuild', '--platform', platform, '--no-install', '--clean'], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', ...environment },
      });
      expect(result.status, `${platform} prebuild: ${result.stderr}`).toBe(0);
    };

    const workerRuntimes = { ios: new Map<string, string | null>(), android: new Map<string, string | null>() };
    for (const name of buildableProfiles) {
      for (const platform of ['ios', 'android'] as const) {
        // The local EAS CLI: no worker marker, no secret file, no prebuild.
        const local = await runtimeIn(buildEnvironment(name, 'local'), platform);
        // The worker: its marker, its platform, the Firebase secret file, and
        // for one profile per platform the real prebuild. ci-ios-simulator iOS
        // comes first, the comparison that fails without the
        // react-native-screens ignore line.
        const worker = { ...buildEnvironment(name, 'worker', firebase), EAS_BUILD_PLATFORM: platform };
        if (prebuildProfiles[platform] === name) prebuild(worker, platform);
        const afterPrebuild = await runtimeIn(worker, platform);
        expect(afterPrebuild, `${name} ${platform}`).toBe(local);
        workerRuntimes[platform].set(name, afterPrebuild);
      }
    }
    // Every profile is its own runtime, so an update published from one
    // profile's config never matches an install of another.
    for (const platform of ['ios', 'android'] as const) {
      expect(new Set(workerRuntimes[platform].values()).size, platform).toBe(buildableProfiles.length);
    }
    expect(workerRuntimes.ios.get('production')).not.toBe(workerRuntimes.android.get('production'));
    expect(buildableProfiles[0]).toBe(prebuildProfiles.ios);
    expect(buildableProfiles).toContain(prebuildProfiles.android);
  }, 600_000);

  it('gives a new runtime version for any native change and keeps it for JavaScript-only changes', async () => {
    const base = await runtimeVersion('production', 'android');
    const sources = base.fingerprintSources ?? [];
    const paths = sources.flatMap((source) => (source.filePath ? [source.filePath] : []));
    // The JavaScript bundle (app/, src/) is what an update carries; it is not
    // part of the runtime version.
    expect(paths.filter((path) => /^(?:app|src)\//.test(path))).toEqual([]);

    const nativeChanges: Array<[string, FingerprintHook]> = [
      ['an Android permission', changeContents('expoConfig', (contents) => {
        const config = JSON.parse(contents) as { android: { permissions: string[] } };
        config.android.permissions.push('READ_CONTACTS');
        return JSON.stringify(config);
      })],
      ['a native dependency version', changeContents('expoAutolinkingConfig:android', (contents) => (
        contents.replace(/"packageName":"expo-secure-store"(.*?)"packageVersion":"[^"]+"/, '"packageName":"expo-secure-store"$1"packageVersion":"99.0.0"')
      ))],
      ['a local native module', changeFile('modules/store-age-signal/android/src/main/java/expo/modules/storeagesignal/StoreAgeSignalModule.kt')],
      ['a config plugin', changeFile('plugins/with-android-keep-rules.js')],
      ['the build profile settings', changeFile('eas.json')],
    ];
    for (const [label, hook] of nativeChanges) {
      const changed = await runtimeVersion('production', 'android', hook);
      expect(changed.runtimeVersion, label).not.toBe(base.runtimeVersion);
    }

    const baseIos = await runtimeVersion('production', 'ios');
    const plistChange = await runtimeVersion('production', 'ios', changeContents('expoConfig', (contents) => {
      const config = JSON.parse(contents) as { ios: { infoPlist: Record<string, unknown> } };
      config.ios.infoPlist.NSContactsUsageDescription = 'native change';
      return JSON.stringify(config);
    }));
    expect(plistChange.runtimeVersion).not.toBe(baseIos.runtimeVersion);
    // The react-native-screens patch is ignored as a dependency file, but the
    // plugin that writes it is not: a change to the patch is a new runtime.
    const patchChange = await runtimeVersion('production', 'ios', changeFile('plugins/with-ios-tab-accessibility.js'));
    expect(patchChange.runtimeVersion).not.toBe(baseIos.runtimeVersion);

    // An unchanged project gives the same runtime version every time.
    expect((await runtimeVersion('production', 'android')).runtimeVersion).toBe(base.runtimeVersion);

    // The Firebase client file is the one native input left out, and only the
    // file GOOGLE_SERVICES_JSON names: the JavaScript an update carries never
    // reads it, and the local EAS CLI cannot see it.
    const firebaseBuild = buildEnvironment('production', 'worker', firebaseClientFile());
    const otherFirebaseBuild = buildEnvironment('production', 'worker', firebaseClientFile('2'));
    expect((await runtimeVersionIn(firebaseBuild, 'android')).runtimeVersion).toBe(base.runtimeVersion);
    expect((await runtimeVersionIn(otherFirebaseBuild, 'android')).runtimeVersion).toBe(base.runtimeVersion);
    // A native change still counts on the worker with the file present.
    const workerChange = await runtimeVersionIn(firebaseBuild, 'android', changeFile('plugins/with-android-keep-rules.js'));
    expect(workerChange.runtimeVersion).not.toBe(base.runtimeVersion);
  }, 300_000);
});

describe('publishing an update in the profile\'s own environment', () => {

  it('refuses another channel, --environment, a branch, and a missing or "all" platform', () => {
    const update = (...args: string[]) => ['eas', 'update', ...args];
    expect(updateCommandProblems('production', update('--channel', 'production', '--platform', 'ios', '--message', 'fix'))).toEqual([]);
    expect(updateCommandProblems('production', update('--channel=production', '-p', 'ios'))).toEqual([]);
    for (const args of [
      ['--channel', 'staging', '--platform', 'ios'],
      ['--channel', 'preview', '--platform', 'ios'],
      ['--platform', 'ios'],
      ['--channel', 'production', '--channel', 'production', '--platform', 'ios'],
      ['--channel', 'production', '--platform', 'ios', '--environment', 'production'],
      ['--channel', 'production', '--platform', 'ios', '--environment=production'],
      ['--channel', 'production', '--platform', 'ios', '--branch', 'main'],
      ['--channel', 'production', '--platform', 'ios', '--auto'],
      ['--channel', 'production'],
      ['--channel', 'production', '--platform', 'all'],
    ]) {
      expect(updateCommandProblems('production', update(...args)), args.join(' ')).not.toEqual([]);
    }
    expect(updateCommandProblems('production', ['eas', 'build', '--channel', 'production', '--platform', 'ios'])).not.toEqual([]);
    // Android needs no secret file on the publisher's machine.
    expect(updateCommandProblems('production', update('--channel', 'production', '--platform', 'android'))).toEqual([]);
    expect(() => updateEnvironment(easConfig, 'production-copy', {})).toThrow(/Unknown or cyclic/);
  });
});
