import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCKED_PERMISSIONS, builtManifestPaths, manifestFailures, readManifest } from '../../scripts/verify-android-manifest-permissions.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const projectRequire = createRequire(join(projectRoot, 'package.json'));
type ManifestDocument = Record<string, unknown>;
const { getPrebuildConfigAsync } = projectRequire('@expo/prebuild-config') as {
  getPrebuildConfigAsync: (root: string, options: { platforms: string[] }) => Promise<{ exp: Record<string, unknown> }>;
};
const { compileModsAsync, XML } = projectRequire('@expo/config-plugins') as {
  compileModsAsync: (config: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ _internal?: { modResults?: { android?: { manifest?: ManifestDocument } } } }>;
  XML: { format: (document: ManifestDocument) => string };
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

// The Android manifest Expo prebuild generates from app.config.ts and every
// config plugin, without writing a native project.
async function generatedManifest(): Promise<string> {
  const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ['android'] });
  const config = await compileModsAsync(exp, { projectRoot, platforms: ['android'], introspect: true, assertMissingModProviders: false });
  const manifest = config._internal?.modResults?.android?.manifest;
  if (!manifest) throw new Error('prebuild introspection returned no Android manifest');
  return XML.format(manifest);
}

const manifest = (body: string) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">\n${body}\n</manifest>`;

describe('Android manifest permissions', () => {
  it('generates a manifest that removes the foreground-service permissions and the playback service', async () => {
    const xml = await generatedManifest();
    expect(manifestFailures(xml)).toEqual([]);
    expect(readManifest(xml).removed).toEqual(expect.arrayContaining(BLOCKED_PERMISSIONS));
  });

  it('fails the manifest the expo-audio defaults produced before October 18', () => {
    const xml = manifest(`
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
  <uses-permission android:name="android.permission.RECORD_AUDIO"/>
  <application>
    <service android:name="expo.modules.audio.service.AudioControlsService" android:exported="false" android:foregroundServiceType="mediaPlayback"/>
  </application>`);
    expect(manifestFailures(xml)).toEqual([
      'grants blocked permission android.permission.FOREGROUND_SERVICE',
      'grants blocked permission android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'declares media-playback foreground service expo.modules.audio.service.AudioControlsService',
    ]);
  });

  it('reads merged-manifest layout: multi-line attributes, sdk-23 grants, combined service types and comments', () => {
    const xml = manifest(`
  <!-- <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/> -->
  <uses-permission
      android:name="android.permission.RECORD_AUDIO" />
  <uses-permission-sdk-23 android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
  <application>
    <service
        android:name="com.example.Player"
        android:foregroundServiceType="microphone|mediaPlayback" />
    <service android:name="com.example.Sync" android:foregroundServiceType="dataSync" />
  </application>`);
    expect(manifestFailures(xml)).toEqual([
      'grants blocked permission android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'declares media-playback foreground service com.example.Player',
    ]);
    expect(manifestFailures(manifest('<uses-permission android:name="android.permission.CAMERA"/>')))
      .toEqual(['is missing required permission android.permission.RECORD_AUDIO']);
  });

  it('finds the merged and packaged manifests Gradle writes for the variant', () => {
    const android = mkdtempSync(join(tmpdir(), 'android-manifest-test-'));
    temporaryDirectories.push(android);
    const intermediates = join(android, 'app', 'build', 'intermediates');
    const files = [
      'merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml',
      'packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml',
      'merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
      'aapt_friendly_merged_manifests/debug/processDebugManifest/aapt/AndroidManifest.xml',
    ];
    for (const file of files) {
      mkdirSync(join(intermediates, file, '..'), { recursive: true });
      writeFileSync(join(intermediates, file), manifest(''));
    }
    expect(builtManifestPaths(android)).toEqual([join(intermediates, files[0]!), join(intermediates, files[1]!)]);
    expect(builtManifestPaths(join(android, 'missing'))).toEqual([]);
  });
});
