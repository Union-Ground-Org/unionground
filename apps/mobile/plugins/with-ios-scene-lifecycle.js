// iOS 27 kills an app during scene creation unless it adopts the UIScene life
// cycle (UIKit's __UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption
// trap; record BUG-UG-MOBILE-IOS-27-LAUNCH-TRAP-NO-SCENE-LIFECYCLE-20260926).
// Expo ships ExpoAppSceneDelegate for exactly that, but neither the prebuild
// template nor Expo registers it. This plugin does the two things the scene
// delegate documents: name it in UIApplicationSceneManifest and let the app
// delegate hand over its React Native factory instead of starting React Native
// in a window of its own.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE_CLASS = 'EXExpoAppSceneDelegate';
const SCENE_CONFIGURATION_NAME = 'Default Configuration';
const PROVIDER_PROTOCOL = 'ExpoReactNativeFactoryProvider';
const CLASS_DECLARATION = /^class AppDelegate: ExpoAppDelegate(?<conformances>(?:, [A-Za-z0-9_]+)*) \{$/m;
// The template starts React Native itself inside application(_:didFinishLaunchingWithOptions:).
const START_REACT_NATIVE_BLOCK = new RegExp([
  '^#if os\\(iOS\\) \\|\\| os\\(tvOS\\)\\n',
  ' {4}window = UIWindow\\(frame: UIScreen\\.main\\.bounds\\)\\n',
  ' {4}factory\\.startReactNative\\(\\n',
  ' {6}withModuleName: "main",\\n',
  ' {6}in: window,\\n',
  ' {6}launchOptions: launchOptions\\)\\n',
  '#endif\\n',
].join(''), 'm');
const SCENE_HANDOVER_NOTE = [
  '    // iOS 27 refuses the pre-scene life cycle. EXExpoAppSceneDelegate, registered by',
  '    // plugins/with-ios-scene-lifecycle.js through UIApplicationSceneManifest, creates the',
  '    // window and starts React Native from the connecting scene; it reads the factory',
  '    // built above through ExpoReactNativeFactoryProvider.',
  '',
].join('\n');

function sceneManifest() {
  return {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: SCENE_CONFIGURATION_NAME,
          UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
        },
      ],
    },
  };
}

function adoptSceneLifecycle(contents) {
  let nextContents = contents;
  const declaration = nextContents.match(CLASS_DECLARATION);
  if (!declaration) {
    throw new Error('iOS scene life cycle: the generated Swift AppDelegate class declaration anchor is missing.');
  }
  const conformances = declaration.groups?.conformances ?? '';
  if (!conformances.split(', ').includes(PROVIDER_PROTOCOL)) {
    nextContents = nextContents.replace(
      declaration[0],
      `class AppDelegate: ExpoAppDelegate${conformances}, ${PROVIDER_PROTOCOL} {`,
    );
  }
  if (nextContents.includes(SCENE_HANDOVER_NOTE)) {
    return nextContents;
  }
  if (!START_REACT_NATIVE_BLOCK.test(nextContents)) {
    throw new Error('iOS scene life cycle: the generated startReactNative block anchor is missing.');
  }
  return nextContents.replace(START_REACT_NATIVE_BLOCK, SCENE_HANDOVER_NOTE);
}

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults.UIApplicationSceneManifest = sceneManifest();
    return modConfig;
  });

  return withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift') {
      throw new Error('iOS scene life cycle requires the generated Swift AppDelegate.');
    }
    modConfig.modResults.contents = adoptSceneLifecycle(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
module.exports.sceneManifest = sceneManifest;
module.exports.SCENE_DELEGATE_CLASS = SCENE_DELEGATE_CLASS;
