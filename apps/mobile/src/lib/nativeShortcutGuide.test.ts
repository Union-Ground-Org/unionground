import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NATIVE_QUICK_ACTION_IDS,
  nativeQuickActionDestinationPath,
  nativeQuickActionGatePath,
  nativeQuickActionIDFromSystemPath,
  routeFromNativeQuickAction,
} from '../services/nativeQuickActionRoutes';
import {
  NATIVE_SHORTCUT_APP_NAME,
  NATIVE_SHORTCUT_GUIDE,
  nativeShortcutGuideCopy,
  spokenSiriPhrase,
} from './nativeShortcutGuide';

const mobileRoot = join(import.meta.dirname, '../..');
const moduleRoot = join(mobileRoot, 'modules/native-quick-actions');
const require = createRequire(import.meta.url);
const { writeAndroidShortcutResources } = require(join(moduleRoot, 'app.plugin.js')) as {
  writeAndroidShortcutResources: (resourceRoot: string, applicationId: string) => void;
};
const intentSource = readFileSync(join(moduleRoot, 'plugin/UnionGroundAppIntents.swift'), 'utf8');
const englishShortcutStrings = readFileSync(join(moduleRoot, 'plugin/en.lproj/AppShortcuts.strings'), 'utf8');
const cardSource = readFileSync(join(mobileRoot, 'src/features/NativeShortcutsGuideCard.tsx'), 'utf8');
const accountSource = readFileSync(join(mobileRoot, 'app/(tabs)/account.tsx'), 'utf8');
const appConfigSource = readFileSync(join(mobileRoot, 'app.config.ts'), 'utf8');

type DeclaredShortcut = { id: string; shortTitle: string; phrases: string[] };

// Reads the AppShortcutsProvider as shipped: each AppShortcut's intent, its
// phrases in order (with the app name as the strings-file token) and its title.
function declaredIosShortcuts(): DeclaredShortcut[] {
  const provider = intentSource.match(/static var appShortcuts: \[AppShortcut\] \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  return [...provider.matchAll(/AppShortcut\(\s*intent: (\w+)\(\),\s*phrases: \[([\s\S]*?)\],\s*shortTitle: "([^"]+)"/g)]
    .map(([, intentName, phraseList, shortTitle]) => {
      const intentBody = intentSource.match(new RegExp(`struct ${intentName}: UnionGroundQuickActionIntent \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      return {
        id: intentBody.match(/quickActionIdentifier = "([^"]+)"/)?.[1] ?? '',
        shortTitle: shortTitle ?? '',
        phrases: [...(phraseList ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)]
          .map(([, phrase]) => (phrase ?? '').replace('\\(.applicationName)', '${applicationName}')),
      };
    });
}

function readAndroidResources() {
  const root = mkdtempSync(join(tmpdir(), 'union-ground-shortcut-guide-'));
  try {
    writeAndroidShortcutResources(root, 'org.example.unionground');
    return {
      shortcuts: readFileSync(join(root, 'xml/shortcuts.xml'), 'utf8'),
      strings: readFileSync(join(root, 'values/native_quick_action_strings.xml'), 'utf8'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('native shortcuts guide', () => {
  it('lists the four fixed destinations in the quick action allowlist order', () => {
    expect(NATIVE_SHORTCUT_GUIDE.map(({ id }) => id)).toEqual([...NATIVE_QUICK_ACTION_IDS]);
    expect(NATIVE_SHORTCUT_GUIDE.map(({ title }) => title)).toEqual(['Home', 'Guide', 'Messages', 'Work']);
  });

  it('matches the shipped iOS App Shortcut declarations exactly', () => {
    const declared = declaredIosShortcuts();
    expect(declared).toHaveLength(4);
    expect(declared).toEqual(NATIVE_SHORTCUT_GUIDE.map(({ id, title, siriPhraseTemplates }) => ({
      id,
      shortTitle: title,
      phrases: [...siriPhraseTemplates],
    })));
  });

  it('pins the ten phrases that opened the correct screen in the iPhone Siri check', () => {
    // #6969: the omitted Messages and Work aliases asked about Apple apps
    // after consent; keep the phrases that opened Union Ground directly.
    expect(declaredIosShortcuts()).toEqual([
      { id: 'home', shortTitle: 'Home', phrases: [
        'Open Home in ${applicationName}',
        'Open ${applicationName} Home',
        'Go to Home in ${applicationName}',
      ] },
      { id: 'compass', shortTitle: 'Guide', phrases: [
        'Open Guide in ${applicationName}',
        'Open ${applicationName} Guide',
        'Go to Guide in ${applicationName}',
      ] },
      { id: 'messages', shortTitle: 'Messages', phrases: [
        'Open Messages in ${applicationName}',
        'Go to Messages in ${applicationName}',
      ] },
      { id: 'work', shortTitle: 'Work', phrases: [
        'Open ${applicationName} Work',
        'Go to Work in ${applicationName}',
      ] },
    ]);
  });

  it('matches the English App Shortcuts strings resource exactly', () => {
    const entries = [...englishShortcutStrings.matchAll(/^"([^"]+)" = "([^"]+)";$/gm)]
      .map(([, key, value]) => ({ key, value }));
    const templates = NATIVE_SHORTCUT_GUIDE.flatMap(({ siriPhraseTemplates }) => siriPhraseTemplates);
    expect(entries.map(({ key }) => key)).toEqual(templates);
    expect(entries.map(({ value }) => value)).toEqual(templates);
  });

  it('shows the spoken phrases with the configured app name', () => {
    // The default brand is Union Ground; a copy sets BRAND_NAME instead.
    expect(appConfigSource).toContain(`const UNION_GROUND_NAME = '${NATIVE_SHORTCUT_APP_NAME}';`);
    expect(appConfigSource).toContain('name: brand.name,');
    const copy = nativeShortcutGuideCopy('ios');
    expect(copy?.rows.map(({ id, title, phrases }) => ({ id, title, phrases }))).toEqual(
      NATIVE_SHORTCUT_GUIDE.map(({ id, title, siriPhraseTemplates }) => ({
        id,
        title,
        phrases: siriPhraseTemplates.map(spokenSiriPhrase),
      })),
    );
    expect(copy?.rows.find(({ id }) => id === 'messages')?.phrases).toEqual([
      'Open Messages in Union Ground',
      'Go to Messages in Union Ground',
    ]);
  });

  it('matches the Android launcher shortcuts and their fixed destinations', () => {
    const { shortcuts, strings } = readAndroidResources();
    const declared = [...shortcuts.matchAll(/android:shortcutId="open_(\w+)"[^>]*android:shortcutShortLabel="@string\/(\w+)"[^>]*android:shortcutLongLabel="@string\/(\w+)"[\s\S]*?android:data="([^"]+)"/g)]
      .map(([, id, shortKey, longKey, data]) => ({
        id,
        shortLabel: strings.match(new RegExp(`<string name="${shortKey}">([^<]+)</string>`))?.[1],
        longLabel: strings.match(new RegExp(`<string name="${longKey}">([^<]+)</string>`))?.[1],
        data,
      }));
    expect(declared).toEqual(NATIVE_SHORTCUT_GUIDE.map(({ id, title }) => ({
      id,
      shortLabel: title,
      longLabel: `Open ${title}`,
      data: `unionground://os-quick-action/${id}`,
    })));
    for (const { data } of declared) {
      const identifier = nativeQuickActionIDFromSystemPath(data ?? '');
      expect(identifier).not.toBeNull();
      expect(nativeQuickActionGatePath(identifier)).toBe(`/os-quick-action/${identifier}`);
      expect(nativeQuickActionDestinationPath(identifier)).not.toBeNull();
    }
  });

  it('opens each guide destination through the strict quick action route', () => {
    expect(NATIVE_SHORTCUT_GUIDE.map(({ id }) => nativeQuickActionDestinationPath(id))).toEqual([
      '/(tabs)/home',
      '/compass',
      '/messages',
      '/work',
    ]);
  });

  it('refuses destinations the guide does not offer', () => {
    for (const value of ['account', 'inbox', 'Messages', 'home ', '', 'case/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 7, { id: 'home' }]) {
      expect(routeFromNativeQuickAction(value)).toBeNull();
      expect(nativeQuickActionGatePath(value)).toBeNull();
      expect(nativeQuickActionDestinationPath(value)).toBeNull();
    }
    for (const value of [
      'unionground://os-quick-action/inbox',
      'unionground://os-quick-action/messages?thread=1',
      'unionground://os-quick-action/work/task-1',
      'https://app.unionground.example/os-quick-action/compass',
    ]) {
      expect(nativeQuickActionIDFromSystemPath(value)).toBeNull();
    }
  });

  it('offers Siri phrases on iOS only and launcher steps on Android', () => {
    const ios = nativeShortcutGuideCopy('ios');
    const android = nativeShortcutGuideCopy('android');
    expect(ios?.notes.join(' ')).toMatch(/Other wording is not guaranteed/);
    expect(ios?.steps.join(' ')).toMatch(/Siri set to English:/);
    expect(ios?.notes.join(' ')).toMatch(/These are the English phrases\. If Siri is set to another language/);
    expect(ios?.rows.map(({ phrases }) => phrases.length)).toEqual([3, 3, 2, 2]);
    expect(android?.rows.map(({ title }) => title)).toEqual(['Home', 'Guide', 'Messages', 'Work']);
    expect(android?.rows.every(({ phrases }) => phrases.length === 0)).toBe(true);
    expect(android?.steps.join(' ')).toMatch(/Touch and hold the Union Ground icon/);
    expect(JSON.stringify(android)).not.toMatch(/Siri/);
    expect(nativeShortcutGuideCopy('web')).toBeNull();
    for (const copy of [ios, android]) {
      expect(copy?.notes.join(' ')).toMatch(/sign in and unlock/);
      expect(copy?.notes.join(' ')).toMatch(/asks you to sign in first/);
    }
  });

  it('explains the separate Siri opt-in and recovery before asking for a phrase', () => {
    const ios = nativeShortcutGuideCopy('ios');
    expect(ios?.steps[0]).toMatch(/turn on.*shortcuts with Siri/i);
    expect(ios?.steps[0]).toMatch(/only if you want/i);
    expect(ios?.notes.join(' ')).toMatch(/hasn.t added support/);
    expect(ios?.notes.join(' ')).toMatch(/Shortcuts.*Siri/i);
    expect(ios?.notes.join(' ')).toMatch(/tapping.*does not.*Siri/i);
    expect(JSON.stringify(nativeShortcutGuideCopy('android'))).not.toMatch(/Siri/);
  });

  it('keeps the guide static, generic and mounted under Account', () => {
    expect(accountSource).toContain("import { NativeShortcutsGuideCard } from '../../src/features/NativeShortcutsGuideCard';");
    expect(accountSource).toContain('<NativeShortcutsGuideCard />');
    expect(cardSource).toContain('nativeShortcutGuideCopy(Platform.OS)');
    expect(cardSource).toContain('accessibilityState={{ expanded }}');
    expect(cardSource).not.toMatch(/services\/(?:supabase|api)|fetch\(|useApp\(/);
    const guideText = JSON.stringify([nativeShortcutGuideCopy('ios'), nativeShortcutGuideCopy('android')]);
    expect(guideText).not.toMatch(/\$\{|unread|\d/i);
  });
});
