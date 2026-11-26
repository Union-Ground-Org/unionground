import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type GradleProperty = { type: 'property'; key: string; value: string } | { type: 'comment'; value: string };

const require = createRequire(import.meta.url);
const { setReleaseProperties, useOptimizedRules } = require('../../plugins/with-android-release-shrinking.js') as {
  setReleaseProperties: (properties: GradleProperty[]) => GradleProperty[];
  useOptimizedRules: (buildGradle: string) => string;
};

// The Expo SDK 57 app/build.gradle release block, as prebuild writes it.
const TEMPLATE_RELEASE = `
        release {
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
`;

// These checks cover the prebuild transform only. That an R8 release build
// starts and runs is a device proof recorded on the pull request.
describe('Android release shrinking prebuild plugin', () => {
  it('turns on R8 minify and resource shrinking, replacing template values once', () => {
    const properties = setReleaseProperties([
      { type: 'comment', value: 'Template' },
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
      { type: 'property', key: 'hermesEnabled', value: 'true' },
    ]);
    expect(properties).toEqual([
      { type: 'comment', value: 'Template' },
      { type: 'property', key: 'hermesEnabled', value: 'true' },
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' },
      { type: 'property', key: 'android.enableShrinkResourcesInReleaseBuilds', value: 'true' },
    ]);
    expect(setReleaseProperties(properties)).toEqual(properties);
  });

  it('switches the release build to the optimizing R8 defaults, idempotently', () => {
    const optimized = useOptimizedRules(TEMPLATE_RELEASE);
    expect(optimized).toContain('getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"');
    expect(optimized).not.toContain('"proguard-android.txt"');
    expect(useOptimizedRules(optimized)).toBe(optimized);
  });

  it('refuses a template whose proguardFiles line changed', () => {
    expect(() => useOptimizedRules(TEMPLATE_RELEASE.replace('proguard-android.txt', 'proguard-other.txt')))
      .toThrow(/proguardFiles line changed/);
    expect(() => useOptimizedRules(TEMPLATE_RELEASE + TEMPLATE_RELEASE)).toThrow(/proguardFiles line changed/);
  });

  it('is registered in the app config and touches only Android files', () => {
    const config = readFileSync(join(import.meta.dirname, '../../app.config.ts'), 'utf8');
    const plugin = readFileSync(join(import.meta.dirname, '../../plugins/with-android-release-shrinking.js'), 'utf8');
    expect(config).toContain("'./plugins/with-android-release-shrinking.js'");
    expect(plugin).toContain('withGradleProperties(config');
    expect(plugin).toContain('withAppBuildGradle(withProperties');
    expect(plugin).not.toMatch(/withDangerousMod|withXcodeProject|withInfoPlist/);
  });
});
