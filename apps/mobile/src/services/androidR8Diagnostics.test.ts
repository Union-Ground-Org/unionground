import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { addKeepRules, KEEP_RULES } = require('../../plugins/with-android-keep-rules.js') as {
  addKeepRules: (rules: string) => string;
  KEEP_RULES: string;
};

const appRoot = join(import.meta.dirname, '../..');
const readApp = (file: string) => readFileSync(join(appRoot, file), 'utf8');
const KEEP_CODED_NAMES = '-keepnames class * extends expo.modules.kotlin.exception.CodedException';

// Port of expo-modules-core CodedException.inferCode (pinned 57.0.x).
function inferCode(className: string): string {
  return 'ERR_' + className.replace(/Exception$/, '').replace(/(.)([A-Z])/g, '$1_$2').toUpperCase();
}

function kotlinFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return kotlinFiles(full);
    return full.endsWith('.kt') ? [full] : [];
  });
}

// Installed Expo classes whose code comes from their own name: a CodedException
// subclass built without an explicit code string.
function inferredCodeClasses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const pkg of ['expo-file-system', 'expo-image-picker', 'expo-font', 'expo-modules-core']) {
    const root = join(dirname(require.resolve(`${pkg}/package.json`)), 'android/src/main/java');
    for (const file of kotlinFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/class (\w+Exception)\b(?:\([^)]*\))?\s*:\s*CodedException\(\s*("?\w*)/g)) {
        const [, name, firstArgument] = match;
        // CodedException(code, message, cause) passes an explicit code; every
        // other constructor leaves the code to the class name.
        if (!name || firstArgument === 'code' || /^"ERR_/.test(firstArgument ?? '')) continue;
        found.set(inferCode(name), `${pkg}: ${name}`);
      }
    }
  }
  return found;
}

function lifecycleInferredCodes(): string[] {
  const source = readApp('src/services/lifecycleDiagnostics.ts');
  const block = source.split('// Expo CodedException.inferCode derives these from native class names.')[1]?.split('//')[0] ?? '';
  return [...block.matchAll(/\['(ERR_\w+)'/g)].map((match) => match[1] ?? '');
}

describe('Android R8 keep rules for Expo error codes', () => {
  it('derives codes the way Expo does', () => {
    expect(inferCode('ModuleNotFoundException')).toBe('ERR_MODULE_NOT_FOUND');
    expect(inferCode('UnableToDeleteException')).toBe('ERR_UNABLE_TO_DELETE');
  });

  it('classifies codes that the installed Expo modules infer from class names', () => {
    const classes = inferredCodeClasses();
    const codes = lifecycleInferredCodes();
    expect(codes).toContain('ERR_UNABLE_TO_DELETE');
    const inferred = codes.filter((code) => classes.has(code));
    // These would change under R8 renaming without the keep rule below.
    expect(inferred).toEqual(expect.arrayContaining([
      'ERR_UNABLE_TO_DELETE', 'ERR_UNABLE_TO_CREATE', 'ERR_FAILED_TO_PICK_MEDIA', 'ERR_INVALID_PERMISSION',
      'ERR_DESTINATION_DOES_NOT_EXIST', 'ERR_MISSING_APP_CONTEXT',
    ]));
    expect(classes.get('ERR_UNABLE_TO_DELETE')).toBe('expo-file-system: UnableToDeleteException');
  });

  it('keeps the names of every Expo CodedException subclass, without keeping unused classes', () => {
    expect(KEEP_RULES.split('\n')).toContain(KEEP_CODED_NAMES);
    // keepnames still lets R8 drop classes the app never reaches.
    expect(KEEP_RULES).not.toMatch(/^-keep class|allowobfuscation/m);
  });

  it('appends the rules to the generated proguard-rules.pro once and refuses a drifted block', () => {
    const template = '# Add project specific ProGuard rules here.\n\n# Add any project specific keep options here:\n';
    const kept = addKeepRules(template);
    expect(kept.startsWith(template)).toBe(true);
    expect(kept.split(KEEP_CODED_NAMES)).toHaveLength(2);
    expect(addKeepRules(kept)).toBe(kept);
    expect(() => addKeepRules(kept.replace(KEEP_CODED_NAMES, '-keepnames class Other'))).toThrow(/differ from the maintained block/);
  });

  it('is registered in the app config and touches only Android files', () => {
    const plugin = readApp('plugins/with-android-keep-rules.js');
    expect(readApp('app.config.ts')).toContain("'./plugins/with-android-keep-rules.js'");
    expect(plugin).toContain("withDangerousMod(config, ['android'");
    expect(plugin).toContain("'app', 'proguard-rules.pro'");
    expect(plugin).not.toContain("['ios'");
  });
});

// OPS-UG-ANDROID-R8-MAPPING-NOT-UPLOADED-TO-SENTRY-20261113: an R8
// mapping in Sentry only matters for native Android events. The app keeps the
// Sentry native layer off (no Kotlin scrubber yet), so nothing native reaches
// Sentry today. Turning native capture on must come with the mapping upload.
describe('Sentry native capture and the R8 mapping upload', () => {
  const observability = readApp('src/services/observability.ts');
  const nativeCaptureOff = /enableNative: false,/.test(observability)
    && /enableNativeCrashHandling: false,/.test(observability)
    && /autoInitializeNativeSdk: false,/.test(observability);
  const mappingUploadConfigured = /'@sentry\/react-native\/expo'/.test(readApp('app.config.ts'));

  it('never sends native Android meetings to Sentry without the R8 mapping upload', () => {
    expect(nativeCaptureOff || mappingUploadConfigured).toBe(true);
  });

  it('records that native capture is off today, so no mapping upload is configured', () => {
    expect(nativeCaptureOff).toBe(true);
    expect(mappingUploadConfigured).toBe(false);
  });
});
