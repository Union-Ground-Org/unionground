import type { NativeQuickActionID } from '../services/nativeQuickActionRoutes';

// REQ-UG-APP-SHORTCUTS-SIRI-PHRASES-20261029: the Account guide reads
// these entries, and nativeShortcutGuide.test.ts holds them equal to the iOS
// App Shortcut phrases (UnionGroundAppIntents.swift, en.lproj) and the Android
// launcher shortcuts (app.plugin.js). Change a declaration and this file together.
// Every value is fixed and generic: no member, chapter, role or count.

export const NATIVE_SHORTCUT_APP_NAME = 'Union Ground';
const APP_NAME_TOKEN = '${applicationName}';

export type NativeShortcutGuideEntry = {
  id: NativeQuickActionID;
  title: string;
  // iOS phrase templates, in declaration order, with the app name as the
  // App Shortcuts strings token.
  siriPhraseTemplates: readonly string[];
};

export const NATIVE_SHORTCUT_GUIDE: readonly NativeShortcutGuideEntry[] = [
  {
    id: 'home',
    title: 'Home',
    siriPhraseTemplates: ['Open Home in ${applicationName}', 'Open ${applicationName} Home', 'Go to Home in ${applicationName}'],
  },
  {
    id: 'compass',
    title: 'Guide',
    siriPhraseTemplates: ['Open Guide in ${applicationName}', 'Open ${applicationName} Guide', 'Go to Guide in ${applicationName}'],
  },
  {
    id: 'messages',
    title: 'Messages',
    siriPhraseTemplates: ['Open Messages in ${applicationName}', 'Go to Messages in ${applicationName}'],
  },
  {
    id: 'work',
    title: 'Work',
    siriPhraseTemplates: ['Open ${applicationName} Work', 'Go to Work in ${applicationName}'],
  },
];

export type NativeShortcutPlatform = 'ios' | 'android';

export type NativeShortcutGuideRow = {
  id: NativeQuickActionID;
  title: string;
  // Spoken Siri phrases on iOS; empty on Android, which has no Siri.
  phrases: readonly string[];
};

export type NativeShortcutGuideCopy = {
  title: string;
  summary: string;
  steps: readonly string[];
  rows: readonly NativeShortcutGuideRow[];
  notes: readonly string[];
};

export function spokenSiriPhrase(template: string): string {
  return template.split(APP_NAME_TOKEN).join(NATIVE_SHORTCUT_APP_NAME);
}

const sharedNotes = [
  'A shortcut only opens the app. You still sign in and unlock it as usual, and each screen shows only what your account can already see.',
  'If you are signed out, Union Ground asks you to sign in first and then opens the screen you chose.',
];

// Null on platforms without OS shortcuts (web), so the Account row stays hidden.
export function nativeShortcutGuideCopy(platform: string): NativeShortcutGuideCopy | null {
  if (platform === 'ios') {
    return {
      title: 'Siri and Shortcuts',
      summary: 'Open Home, Guide, Messages or Work by asking Siri, or from the Shortcuts app or Spotlight.',
      steps: [
        'First, keep Union Ground open and say one of the phrases below. If Siri asks “Turn on Union Ground shortcuts with Siri?”, confirm only if you want voice access.',
        'Siri set to English: say one of the phrases below exactly as written.',
        'Shortcuts app or Spotlight: search for Union Ground and tap Home, Guide, Messages or Work.',
      ],
      rows: NATIVE_SHORTCUT_GUIDE.map(({ id, title, siriPhraseTemplates }) => ({
        id,
        title,
        phrases: siriPhraseTemplates.map(spokenSiriPhrase),
      })),
      notes: [
        'If Siri says Union Ground “hasn’t added support”, open the Shortcuts app, find Union Ground under App Shortcuts and check that Siri is turned on for this app. Running a shortcut by tapping it does not confirm that Siri voice access is enabled.',
        'Siri listens for these phrases only. Other wording is not guaranteed to work and may open the app on its first screen, or another app.',
        'These are the English phrases. If Siri is set to another language, it listens for that language’s phrases instead, so these may not work.',
        ...sharedNotes,
      ],
    };
  }
  if (platform === 'android') {
    return {
      title: 'Launcher shortcuts',
      summary: 'Open Home, Guide, Messages or Work straight from the Union Ground app icon.',
      steps: [
        'Touch and hold the Union Ground icon on your home screen or in your app list.',
        'Choose a shortcut from the menu. To keep one on your home screen, drag it out of the menu.',
      ],
      rows: NATIVE_SHORTCUT_GUIDE.map(({ id, title }) => ({ id, title, phrases: [] })),
      notes: [
        'These shortcuts work from the launcher. Union Ground does not add voice commands on Android.',
        ...sharedNotes,
      ],
    };
  }
  return null;
}
