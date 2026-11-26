import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/native-quick-actions/src/NativeQuickActionsModule', () => ({ default: null }));

import { createNativeQuickActionDrain, nativeQuickActionCanConsume } from './nativeQuickActions';
import { indexRedirectPath } from '../lib/routes';
import {
  NATIVE_QUICK_ACTION_IDS,
  type NativeQuickActionID,
  nativeQuickActionDestinationPath,
  nativeQuickActionGatePath,
  nativeQuickActionGatePathFromSystemPath,
  nativeQuickActionIDFromSystemPath,
  routeFromNativeQuickAction,
} from './nativeQuickActionRoutes';

const mobileRoot = join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { addIosShortcutRegistration, addIosShortcutResources, writeAndroidShortcutResources } = require(
  '../../modules/native-quick-actions/app.plugin.js',
) as {
  addIosShortcutRegistration: (contents: string) => string;
  addIosShortcutResources: (
    project: unknown,
    options: { projectName: string; supportingDirectory: string },
  ) => unknown;
  writeAndroidShortcutResources: (resourceRoot: string, applicationId: string) => void;
};
const xcode = require('xcode') as {
  project: (path: string) => {
    parseSync: () => void;
    writeSync: () => string;
    getFirstTarget: () => { uuid: string };
    pbxResourcesBuildPhaseObj: (target: string) => { files: Array<{ comment?: string }> };
  };
};
const expoTemplateArchive = gunzipSync(readFileSync(require.resolve('expo/template.tgz')));

function readTarString(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
}

function readPaxAttributes(bytes: Buffer): Record<string, string> {
  const attributes: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const separator = bytes.indexOf(0x20, offset);
    if (separator < 0) throw new Error('Invalid PAX record length delimiter');
    const recordLength = Number.parseInt(bytes.subarray(offset, separator).toString('ascii'), 10);
    const recordEnd = offset + recordLength;
    if (!Number.isSafeInteger(recordLength) || recordLength <= 0 || recordEnd > bytes.length) {
      throw new Error('Invalid PAX record length');
    }
    const record = bytes.subarray(separator + 1, recordEnd - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) attributes[record.slice(0, equals)] = record.slice(equals + 1);
    offset = recordEnd;
  }
  return attributes;
}

function readExpoTemplateEntry(pattern: RegExp): string {
  const matches: string[] = [];
  let offset = 0;
  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> = {};
  let nextLongName: string | undefined;

  while (offset + 512 <= expoTemplateArchive.length) {
    const header = expoTemplateArchive.subarray(offset, offset + 512);
    const shortName = readTarString(header, 0, 100);
    if (!shortName) break;

    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size)) throw new Error(`Invalid TAR size for ${shortName}`);

    const contentsStart = offset + 512;
    const contentsEnd = contentsStart + size;
    if (contentsEnd > expoTemplateArchive.length) throw new Error(`Truncated TAR entry for ${shortName}`);
    const contents = expoTemplateArchive.subarray(contentsStart, contentsEnd);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = readTarString(header, 345, 155);

    if (typeFlag === 'g') {
      globalPax = { ...globalPax, ...readPaxAttributes(contents) };
    } else if (typeFlag === 'x') {
      nextPax = readPaxAttributes(contents);
    } else if (typeFlag === 'L') {
      nextLongName = contents.toString('utf8').replace(/[\0\n]+$/g, '');
    } else {
      const headerName = prefix ? `${prefix}/${shortName}` : shortName;
      const name = nextPax.path ?? nextLongName ?? globalPax.path ?? headerName;
      if (pattern.test(name)) matches.push(contents.toString('utf8'));
      nextPax = {};
      nextLongName = undefined;
    }
    offset = contentsStart + Math.ceil(size / 512) * 512;
  }

  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`Expected one Expo template entry for ${pattern}, found ${matches.length}`);
  }
  return match;
}

function readExpoAppDelegateTemplate(): string {
  return readExpoTemplateEntry(/^package\/ios\/[^/]+\/AppDelegate\.swift$/);
}

function extractSwiftLocalizedIntentKeys(source: string): Set<string> {
  const patterns = [
    /LocalizedStringResource\s*=\s*"([^"]+)"/g,
    /IntentDescription\("([^"]+)"\)/g,
    /TypeDisplayRepresentation\s*=\s*"([^"]+)"/g,
    /caseDisplayRepresentations[^\n]*=\s*\[[^\n]*:\s*"([^"]+)"\]/g,
    /shortTitle:\s*"([^"]+)"/g,
    /@Parameter\(title:\s*"([^"]+)"/g,
  ];
  return new Set(patterns.flatMap((pattern) => (
    [...source.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => Boolean(value))
  )));
}

function extractSwiftShortcutPhrases(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/"([^"\n]*\\\(\.applicationName\)[^"\n]*)"/g)]
      .map((match) => match[1]?.replace('\\(.applicationName)', '${applicationName}'))
      .filter((value): value is string => Boolean(value)),
  );
}

const pluginSource = readFileSync(join(mobileRoot, 'modules/native-quick-actions/app.plugin.js'), 'utf8');
const intentSource = readFileSync(
  join(mobileRoot, 'modules/native-quick-actions/plugin/UnionGroundAppIntents.swift'),
  'utf8',
);
const moduleSource = readFileSync(
  join(mobileRoot, 'modules/native-quick-actions/ios/NativeQuickActionsModule.swift'),
  'utf8',
);
const handoffSource = readFileSync(join(mobileRoot, 'app/os-quick-action/[id].tsx'), 'utf8');
const quickActionGateSource = readFileSync(join(mobileRoot, 'src/components/NativeQuickActionGate.tsx'), 'utf8');
const signInSource = readFileSync(join(mobileRoot, 'app/sign-in.tsx'), 'utf8');
const mfaSource = readFileSync(join(mobileRoot, 'app/mfa-challenge.tsx'), 'utf8');
const readmeSource = readFileSync(join(mobileRoot, 'README.md'), 'utf8');

// A stack router like Expo Router's: replace swaps whichever route is on top,
// whichever screen asked for it. Redirect is a focus effect that waits for the
// loaded navigation, so on a cold launch the index Redirect to Home can fire
// after the gate has already pushed the quick action (#6482).
async function launchWithPendingQuickAction(identifier: NativeQuickActionID, startPath: '/' | '/(tabs)/home') {
  const stack: string[] = [startPath];
  const top = () => stack[stack.length - 1] ?? '';
  const replaceTop = (path: string) => { stack[stack.length - 1] = path; };
  let pending: NativeQuickActionID | null = identifier;
  let indexRedirectPending = startPath === '/';
  const drain = createNativeQuickActionDrain(
    async () => {
      const staged = pending;
      pending = null;
      return staged;
    },
    (staged) => { stack.push(nativeQuickActionGatePath(staged) as string); },
  );
  const gate = async (mode: 'booting' | 'authenticated') => {
    if (nativeQuickActionCanConsume({ mode, locked: false, privacyCovered: false, pathname: top() })) await drain();
  };
  const runRedirects = () => {
    const handoff = top().startsWith('/os-quick-action/')
      ? nativeQuickActionDestinationPath(top().slice('/os-quick-action/'.length))
      : null;
    if (handoff) replaceTop(handoff);
    if (indexRedirectPending) {
      indexRedirectPending = false;
      replaceTop(indexRedirectPath('authenticated') as string);
    }
  };

  if (startPath === '/') await gate('booting');
  // Sign-in restore: the gate's effect drains, then the Redirects fire.
  await gate('authenticated');
  runRedirects();
  // The path changed, so the gate's effect runs again.
  await gate('authenticated');
  runRedirects();
  return { stack, pending };
}

describe('native OS quick actions', () => {
  it('serializes overlapping destructive consumes without dropping the first action', async () => {
    let resolveFirst: ((identifier: 'messages') => void) | undefined;
    const consume = vi.fn()
      .mockImplementationOnce(() => new Promise<'messages'>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(null);
    const route = vi.fn();
    const drain = createNativeQuickActionDrain(consume, route);

    const first = drain();
    const overlapping = drain();
    resolveFirst?.('messages');
    await Promise.all([first, overlapping]);

    expect(consume).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith('messages');
  });

  it('lands a cold-launch quick action on its destination, not on the index Redirect to Home', async () => {
    for (const identifier of NATIVE_QUICK_ACTION_IDS) {
      const { stack, pending } = await launchWithPendingQuickAction(identifier, '/');
      expect(pending).toBeNull();
      expect(stack[stack.length - 1]).toBe(nativeQuickActionDestinationPath(identifier));
    }
  });

  it('routes a warm-launch quick action as before', async () => {
    for (const identifier of NATIVE_QUICK_ACTION_IDS) {
      const { stack, pending } = await launchWithPendingQuickAction(identifier, '/(tabs)/home');
      expect(pending).toBeNull();
      expect(stack).toEqual(['/(tabs)/home', nativeQuickActionDestinationPath(identifier)]);
    }
  });

  it('defers destructive consumption behind privacy and biometric covers without blocking auth staging', () => {
    const ready = { locked: false, privacyCovered: false, pathname: '/(tabs)/home' };
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'booting' })).toBe(false);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'authenticated', locked: true })).toBe(false);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'authenticated', privacyCovered: true })).toBe(false);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'authenticated', pathname: '/' })).toBe(false);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'authenticated' })).toBe(true);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'signedOut', pathname: '/sign-in' })).toBe(true);
    expect(nativeQuickActionCanConsume({ ...ready, mode: 'mfaRequired', pathname: '/mfa-challenge' })).toBe(true);
    expect(quickActionGateSource).toContain('const pathname = usePathname();');
    expect(quickActionGateSource).toContain('nativeQuickActionCanConsume({ mode, locked, privacyCovered, pathname })');
  });

  it('maps only the fixed identifier allowlist', () => {
    expect(NATIVE_QUICK_ACTION_IDS).toEqual(['home', 'compass', 'messages', 'work']);
    expect(routeFromNativeQuickAction('home')).toEqual({ kind: 'tab', tab: 'home' });
    expect(routeFromNativeQuickAction('compass')).toEqual({ kind: 'tab', tab: 'compass' });
    expect(routeFromNativeQuickAction('messages')).toEqual({ kind: 'messages' });
    expect(routeFromNativeQuickAction('work')).toEqual({ kind: 'tab', tab: 'work' });
    expect(routeFromNativeQuickAction('account')).toBeNull();
    expect(routeFromNativeQuickAction('case/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(routeFromNativeQuickAction({ id: 'home' })).toBeNull();
  });

  it('generates identical generic destinations for Android and iOS', () => {
    for (const identifier of NATIVE_QUICK_ACTION_IDS) {
      expect(pluginSource).toContain(`android:shortcutId="open_${identifier}"`);
      expect(pluginSource).toContain(`android:data="unionground://os-quick-action/${identifier}"`);
      expect(intentSource).toContain(`quickActionIdentifier = "${identifier}"`);
    }
    expect(pluginSource.match(/<shortcut android:shortcutId=/g)).toHaveLength(4);
    expect(intentSource.match(/AppShortcut\(/g)).toHaveLength(4);
  });

  it('generates localized English-default and Spanish Android shortcut labels', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'union-ground-android-shortcuts-'));
    try {
      writeAndroidShortcutResources(temporaryRoot, 'org.example.unionground');
      const base = readFileSync(join(temporaryRoot, 'values/native_quick_action_strings.xml'), 'utf8');
      const spanish = readFileSync(join(temporaryRoot, 'values-es/native_quick_action_strings.xml'), 'utf8');

      expect(base.match(/<string name="quick_action_/g)).toHaveLength(8);
      expect(spanish.match(/<string name="quick_action_/g)).toHaveLength(8);
      expect(spanish).toContain('<string name="quick_action_home_short">Inicio</string>');
      expect(spanish).toContain('<string name="quick_action_compass_long">Abrir la Guía</string>');
      expect(spanish).toContain('<string name="quick_action_messages_short">Mensajes</string>');
      expect(spanish).toContain('<string name="quick_action_work_long">Abrir Trabajo</string>');
      const shortcuts = readFileSync(join(temporaryRoot, 'xml/shortcuts.xml'), 'utf8');
      expect(shortcuts).toContain('@string/quick_action_messages_short');
      expect(shortcuts.match(/android:targetClass="org\.example\.unionground\.MainActivity"/g)).toHaveLength(4);
      expect(pluginSource).toContain('writeAndroidShortcutResources(resourceRoot, modConfig.android?.package);');
      expect(() => writeAndroidShortcutResources(temporaryRoot, '')).toThrow(/application id/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('uses one strict public handoff route before opening a protected destination', () => {
    expect(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/home')).toBe('home');
    expect(nativeQuickActionGatePathFromSystemPath('unionground://os-quick-action/messages'))
      .toBe('/os-quick-action/messages');
    expect(nativeQuickActionGatePath('work')).toBe('/os-quick-action/work');
    expect(nativeQuickActionDestinationPath('compass')).toBe('/compass');
    expect(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/account')).toBeNull();
    expect(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/home?member=1')).toBeNull();
    expect(nativeQuickActionIDFromSystemPath('unionground://os-quick-action/home/extra')).toBeNull();
    expect(nativeQuickActionIDFromSystemPath('https://app.unionground.example/os-quick-action/home')).toBeNull();
  });

  it('holds the generic destination through sign-in and MFA before redirecting', () => {
    expect(handoffSource).toContain("if (mode === 'signedOut')");
    expect(handoffSource).toContain("pathname: '/sign-in', params: { quickAction: identifier }");
    expect(handoffSource).toContain("if (mode === 'mfaRequired')");
    expect(handoffSource).toContain("pathname: '/mfa-challenge', params: { quickAction: identifier }");
    expect(signInSource).toContain("quickActionDestination ?? '/(tabs)/home'");
    expect(mfaSource).toContain("quickActionDestination ?? '/(tabs)/home'");
  });

  it('keeps the system metadata generic and foreground-only', () => {
    expect(intentSource).toContain('protocol UnionGroundQuickActionIntent: OpenIntent');
    expect(intentSource.match(/\.requiresLocalDeviceAuthentication/g)).toHaveLength(4);
    expect(intentSource.match(/static let openAppWhenRun = true/g)).toHaveLength(4);
    expect(intentSource.match(/\.foreground\(\.immediate\)/g)).toHaveLength(4);
    expect(intentSource.match(/@Parameter\(title: "Destination", default: \.(?:home|compass|messages|work)\)/g))
      .toHaveLength(4);
    expect(intentSource.match(/enum UnionGround(?:Home|Compass|Messages|Work)Target: String, AppEnum/g))
      .toHaveLength(4);
    for (const [name, identifier, label] of [
      ['Home', 'home', 'Home'],
      ['Compass', 'compass', 'Guide'],
      ['Messages', 'messages', 'Messages'],
      ['Work', 'work', 'Work'],
    ] as const) {
      const enumBody = intentSource.match(
        new RegExp(`enum UnionGround${name}Target: String, AppEnum \\{([\\s\\S]*?)\\n\\}`),
      )?.[1];
      expect(enumBody, `${name} target enum`).toBeDefined();
      expect(enumBody?.match(/^\s*case\s+\w+\s*$/gm)?.map((entry) => entry.trim()))
        .toEqual([`case ${identifier}`]);
      expect(enumBody).toContain(
        `static let caseDisplayRepresentations: [UnionGround${name}Target: DisplayRepresentation] = [.${identifier}: "${label}"]`,
      );
    }
    const performBody = intentSource.match(
      /extension UnionGroundQuickActionIntent \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(performBody).toContain('UnionGroundQuickActionStore.stage(Self.quickActionIdentifier)');
    expect(performBody).not.toMatch(/\btarget\b/);
    expect(intentSource).not.toMatch(/unionground:\/\/(?:case|conversation|channel|feature)\//);
    expect(pluginSource).not.toContain('<activity');
    expect(pluginSource).not.toContain('<receiver');
    expect(pluginSource).not.toContain('<uses-permission');
  });

  it('registers the provider exactly once during generated application launch', () => {
    const source = readExpoAppDelegateTemplate();
    const once = addIosShortcutRegistration(source);
    const twice = addIosShortcutRegistration(once);

    expect(once.match(/^import AppIntents$/gm)).toHaveLength(1);
    expect(once.match(/^ {4}UnionGroundAppShortcuts\.updateAppShortcutParameters\(\)$/gm)).toHaveLength(1);
    expect(once).toContain([
      '    UnionGroundAppShortcuts.updateAppShortcutParameters()',
      '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    ].join('\n'));
    expect(twice).toBe(once);
    expect(() => addIosShortcutRegistration('import Expo\nclass AppDelegate {}'))
      .toThrow(/launch completion anchor/i);
  });

  it('ships backward-compatible English and Spanish App Shortcuts strings as iOS resources', () => {
    const sourcePhrases = [
      'Open Home in ${applicationName}',
      'Open ${applicationName} Home',
      'Go to Home in ${applicationName}',
      'Open Guide in ${applicationName}',
      'Open ${applicationName} Guide',
      'Go to Guide in ${applicationName}',
      'Open Messages in ${applicationName}',
      'Go to Messages in ${applicationName}',
      'Open ${applicationName} Work',
      'Go to Work in ${applicationName}',
    ];
    const derivedSourcePhrases = extractSwiftShortcutPhrases(intentSource);
    expect(derivedSourcePhrases).toEqual(new Set(sourcePhrases));

    for (const locale of ['en', 'es']) {
      const strings = readFileSync(
        join(mobileRoot, `modules/native-quick-actions/plugin/${locale}.lproj/AppShortcuts.strings`),
        'utf8',
      );
      const entries = [...strings.matchAll(/^"([^"]+)" = "([^"]+)";$/gm)];
      expect(entries).toHaveLength(10);
      expect(entries.every(([, key, value]) => (
        key?.includes('${applicationName}') && value?.includes('${applicationName}')
      ))).toBe(true);
      expect(new Set(entries.map(([, key]) => key))).toEqual(derivedSourcePhrases);
      if (locale === 'en') expect(entries.every(([, key, value]) => key === value)).toBe(true);
    }

    for (const phrase of sourcePhrases) {
      expect(intentSource).toContain(phrase.replace('${applicationName}', '\\(.applicationName)'));
    }

    const localizedIntentKeys = [
      'Union Ground Home destination',
      'Union Ground Guide destination',
      'Union Ground Messages destination',
      'Union Ground Work destination',
      'Destination',
      'Home',
      'Guide',
      'Messages',
      'Work',
      'Open Home',
      'Open Guide',
      'Open Messages',
      'Open Work',
      'Open the Union Ground Home workspace.',
      'Open the Union Ground Guide workspace.',
      'Open the Union Ground Messages workspace.',
      'Open the Union Ground Work workspace.',
    ];
    const derivedIntentKeys = extractSwiftLocalizedIntentKeys(intentSource);
    expect(derivedIntentKeys).toEqual(new Set(localizedIntentKeys));
    for (const locale of ['en', 'es']) {
      const strings = readFileSync(
        join(mobileRoot, `modules/native-quick-actions/plugin/${locale}.lproj/Localizable.strings`),
        'utf8',
      );
      const entries = [...strings.matchAll(/^"([^"]+)" = "([^"]+)";$/gm)];
      expect(entries).toHaveLength(localizedIntentKeys.length);
      expect(new Set(entries.map(([, key]) => key))).toEqual(derivedIntentKeys);
      const localizedKeys = new Set(entries.map(([, key]) => key));
      const parameterTitles = [...intentSource.matchAll(/@Parameter\(title: "([^"]+)"/g)]
        .map((match) => match[1]);
      expect(new Set(parameterTitles)).toEqual(new Set(['Destination']));
      expect(parameterTitles.every((title) => title && localizedKeys.has(title))).toBe(true);
      if (locale === 'en') expect(entries.every(([, key, value]) => key === value)).toBe(true);
      if (locale === 'es') expect(entries.some(([, key, value]) => key !== value)).toBe(true);
    }

    const renamedTitleKeys = extractSwiftLocalizedIntentKeys(
      intentSource.replace(
        'LocalizedStringResource = "Open Home"',
        'LocalizedStringResource = "Open Home tab"',
      ),
    );
    expect([...renamedTitleKeys].filter((key) => !localizedIntentKeys.includes(key)))
      .toEqual(['Open Home tab']);
    const addedPhraseKeys = extractSwiftShortcutPhrases(
      intentSource.replace(
        '"Go to Home in \\(.applicationName)",',
        '"Go to Home in \\(.applicationName)",\n        "Visit Home in \\(.applicationName)",',
      ),
    );
    expect([...addedPhraseKeys].filter((key) => !sourcePhrases.includes(key)))
      .toEqual(['Visit Home in ${applicationName}']);

    expect(pluginSource).toContain("IOS_SHORTCUTS_LOCALIZATIONS = ['en', 'es']");
    expect(pluginSource).toContain("IOS_LOCALIZED_STRING_RESOURCES = ['AppShortcuts.strings', 'Localizable.strings']");
    expect(pluginSource).toContain('addKnownRegion(locale)');
    expect(pluginSource).toContain('pbxCreateVariantGroup');
    expect(pluginSource).toContain('addToPbxVariantGroup');
    expect(pluginSource).toContain('addToPbxResourcesBuildPhase');
    expect(pluginSource).toContain('target: appTargetUUID');
    expect(pluginSource).toContain("'AppShortcuts.strings'");
    expect(pluginSource).toContain("lastKnownFileType = 'text.plist.strings'");
    expect(pluginSource).not.toContain('addResourceFileToGroup');
    expect(pluginSource).not.toContain('AppShortcuts.xcstrings');
    expect(readmeSource).toContain('four fixed-destination, zero-input App');
    expect(readmeSource).not.toContain('parameterless App Intents');
  });

  it('mutates the real Expo Xcode template idempotently with both localized resource groups', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'union-ground-app-shortcuts-'));
    try {
      const projectPath = join(temporaryRoot, 'HelloWorld.xcodeproj/project.pbxproj');
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(
        projectPath,
        readExpoTemplateEntry(/^package\/ios\/HelloWorld\.xcodeproj\/project\.pbxproj$/),
      );
      const project = xcode.project(projectPath);
      project.parseSync();
      const supportingDirectory = join(temporaryRoot, 'HelloWorld/Supporting');

      addIosShortcutResources(project, { projectName: 'HelloWorld', supportingDirectory });
      const once = project.writeSync();
      const appResourceComments = project
        .pbxResourcesBuildPhaseObj(project.getFirstTarget().uuid)
        .files.map(({ comment }) => comment);
      addIosShortcutResources(project, { projectName: 'HelloWorld', supportingDirectory });
      const twice = project.writeSync();

      expect(twice).toBe(once);
      expect(once.match(/AppShortcuts\.strings in Resources/g)).toHaveLength(2);
      expect(once.match(/Localizable\.strings in Resources/g)).toHaveLength(2);
      expect(once.match(/isa = "?PBXVariantGroup"?;/g) ?? []).toHaveLength(2);
      expect(appResourceComments).toContain('AppShortcuts.strings in Resources');
      expect(appResourceComments).toContain('Localizable.strings in Resources');
      expect(once).toMatch(/knownRegions = \([\s\S]*?\bes\b[\s\S]*?\);/);
      for (const resourceName of ['AppShortcuts.strings', 'Localizable.strings']) {
        for (const locale of ['en', 'es']) {
          expect(readFileSync(join(supportingDirectory, `${locale}.lproj`, resourceName), 'utf8'))
            .toBe(readFileSync(
              join(mobileRoot, 'modules/native-quick-actions/plugin', `${locale}.lproj`, resourceName),
              'utf8',
            ));
        }
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('ignores comments and fails closed on misplaced executable registration', () => {
    const source = readExpoAppDelegateTemplate();
    const withComment = source.replace(
      'import Expo',
      '// UnionGroundAppShortcuts.updateAppShortcutParameters()\nimport Expo',
    );
    const withRegistration = addIosShortcutRegistration(withComment);
    expect(withRegistration.match(/^ {4}UnionGroundAppShortcuts\.updateAppShortcutParameters\(\)$/gm))
      .toHaveLength(1);

    const anchor = '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
    const misplaced = source.replace(
      anchor,
      `  UnionGroundAppShortcuts.updateAppShortcutParameters()\n${anchor}`,
    );
    expect(() => addIosShortcutRegistration(misplaced)).toThrow(/outside the launch completion anchor/i);
  });

  it('consumes and clears native staging before validating it', () => {
    const readIndex = moduleSource.indexOf('defaults.string(forKey: pendingQuickActionKey)');
    const clearIndex = moduleSource.indexOf('defaults.removeObject(forKey: pendingQuickActionKey)');
    const allowIndex = moduleSource.indexOf('allowedQuickActions.contains(pending)');
    expect(readIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(readIndex);
    expect(allowIndex).toBeGreaterThan(clearIndex);
  });
});
