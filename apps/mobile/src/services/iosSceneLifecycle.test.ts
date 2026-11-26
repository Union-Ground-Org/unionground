import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// BUG-UG-MOBILE-IOS-27-LAUNCH-TRAP-NO-SCENE-LIFECYCLE-20260926: iOS 27 kills the app
// during scene creation unless it adopts the UIScene life cycle. The plugin must register
// Expo's scene delegate and stop the generated AppDelegate from starting React Native itself.

const mobileRoot = join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { adoptSceneLifecycle, sceneManifest, SCENE_DELEGATE_CLASS } = require(
  '../../plugins/with-ios-scene-lifecycle.js',
) as {
  adoptSceneLifecycle: (contents: string) => string;
  sceneManifest: () => {
    UIApplicationSupportsMultipleScenes: boolean;
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: Array<{ UISceneConfigurationName: string; UISceneDelegateClassName: string }>;
    };
  };
  SCENE_DELEGATE_CLASS: string;
};
const { addIosShortcutRegistration } = require('../../modules/native-quick-actions/app.plugin.js') as {
  addIosShortcutRegistration: (contents: string) => string;
};

function readExpoTemplateAppDelegate(): string {
  // The prebuild template Expo actually generates from, not a hand-copied fixture.
  return execFileSync(
    'tar',
    ['-xzOf', require.resolve('expo/template.tgz'), 'package/ios/HelloWorld/AppDelegate.swift'],
    { encoding: 'utf8' },
  );
}

describe('iOS scene life cycle plugin', () => {
  it('names Expo scene delegate in a single application-role scene configuration', () => {
    const manifest = sceneManifest();
    expect(SCENE_DELEGATE_CLASS).toBe('EXExpoAppSceneDelegate');
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
    expect(manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication).toEqual([
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
    ]);
  });

  it('hands the React Native factory to the scene delegate exactly once', () => {
    const source = readExpoTemplateAppDelegate();
    expect(source).toContain('class AppDelegate: ExpoAppDelegate {');
    expect(source).toContain('factory.startReactNative(');

    const once = adoptSceneLifecycle(source);
    const twice = adoptSceneLifecycle(once);

    expect(once.match(/^class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{$/gm)).toHaveLength(1);
    expect(once).not.toContain('startReactNative(');
    expect(once).not.toContain('UIWindow(frame:');
    expect(once).toContain('  var window: UIWindow?');
    expect(once).toContain('    reactNativeFactory = factory');
    expect(once).toContain('    return super.application(application, didFinishLaunchingWithOptions: launchOptions)');
    expect(once.match(/EXExpoAppSceneDelegate/g)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('composes with the native quick actions AppDelegate mod in either order', () => {
    const source = readExpoTemplateAppDelegate();
    const sceneFirst = addIosShortcutRegistration(adoptSceneLifecycle(source));
    const shortcutsFirst = adoptSceneLifecycle(addIosShortcutRegistration(source));

    expect(sceneFirst).toBe(shortcutsFirst);
    expect(sceneFirst).toContain('    UnionGroundAppShortcuts.updateAppShortcutParameters()');
    expect(sceneFirst).not.toContain('startReactNative(');
  });

  it('refuses a foreign AppDelegate instead of leaving the trap in place', () => {
    expect(() => adoptSceneLifecycle('import Expo\n\n@main\nclass AppDelegate: UIResponder {\n}\n'))
      .toThrow(/class declaration anchor/i);
    expect(() => adoptSceneLifecycle('import Expo\n\n@main\nclass AppDelegate: ExpoAppDelegate {\n}\n'))
      .toThrow(/startReactNative block anchor/i);
  });

  it('is registered in the app config', () => {
    const appConfig = readFileSync(join(mobileRoot, 'app.config.ts'), 'utf8');
    expect(appConfig).toContain("'./plugins/with-ios-scene-lifecycle.js'");
  });
});
