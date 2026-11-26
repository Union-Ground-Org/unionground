const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'UnionGroundWidgets';
// The widget extension and its shared app group are derived from the
// application identifier the build uses (config.ios.bundleIdentifier from
// app.config.ts), as the secure share intake extension does, so no copy
// borrows another app's identifiers. Both bundles read the group back from
// their Info.plist (UGHomeWidgetsAppGroup).
const extensionBundleIdFor = (applicationId) => `${applicationId}.home-widgets`;
const appGroupIdFor = (applicationId) => `group.${applicationId}.home-widgets`;
const APP_GROUP_INFO_KEY = 'UGHomeWidgetsAppGroup';

function writeWidgetFiles(iosRoot, version, buildNumber, GROUP) {
  const root = path.join(iosRoot, TARGET);
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'plugin/UnionGroundWidgets.swift'), path.join(root, 'UnionGroundWidgets.swift'));
  fs.writeFileSync(path.join(root, 'Info.plist'), plist.build({
    CFBundleDisplayName: 'Union Ground widgets',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: version,
    CFBundleVersion: buildNumber,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
    [APP_GROUP_INFO_KEY]: GROUP,
  }));
  fs.writeFileSync(path.join(root, `${TARGET}.entitlements`), plist.build({ 'com.apple.security.application-groups': [GROUP] }));
}

function addWidgetTarget(project, version, buildNumber, BUNDLE) {
  const targets = project.pbxNativeTargetSection();
  let target = Object.entries(targets).find(([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET);
  if (!target) {
    const created = project.addTarget(TARGET, 'app_extension', TARGET, BUNDLE);
    const group = project.addPbxGroup([], TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', created.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', created.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', created.uuid);
    project.addSourceFile(`${TARGET}/UnionGroundWidgets.swift`, { target: created.uuid }, group.uuid);
    // The group already points at TARGET; keep the source reference relative to it.
    const sources = project.pbxFileReferenceSection();
    for (const [key, value] of Object.entries(sources)) {
      if (!key.endsWith('_comment') && value.path?.replaceAll('"', '') === `${TARGET}/UnionGroundWidgets.swift`) value.path = '"UnionGroundWidgets.swift"';
    }
    target = [created.uuid, created.pbxNativeTarget];
  }
  const list = project.pbxXCConfigurationList()[target[1].buildConfigurationList];
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const reference of list.buildConfigurations) {
    Object.assign(configurations[reference.value].buildSettings, {
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
      MARKETING_VERSION: `"${version}"`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${BUNDLE}"`,
      SWIFT_VERSION: '5.9',
      TARGETED_DEVICE_FAMILY: '1',
    });
  }
  return project;
}

function withHomeWidgets(config) {
  config.ios ??= {};
  const applicationId = config.ios.bundleIdentifier;
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(applicationId ?? '')) {
    throw new Error('Home widgets need the application identifier from app.config.ts (ios.bundleIdentifier).');
  }
  const BUNDLE = extensionBundleIdFor(applicationId);
  const GROUP = appGroupIdFor(applicationId);
  config.ios.infoPlist ??= {};
  config.ios.infoPlist[APP_GROUP_INFO_KEY] = GROUP;
  config.ios.entitlements ??= {};
  const groups = config.ios.entitlements['com.apple.security.application-groups'] ?? [];
  config.ios.entitlements['com.apple.security.application-groups'] = [...new Set([...groups, GROUP])];
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  config.extra.eas.build.experimental.ios ??= {};
  const extensions = config.extra.eas.build.experimental.ios.appExtensions ?? [];
  config.extra.eas.build.experimental.ios.appExtensions = [
    ...extensions.filter((extension) => extension.targetName !== TARGET),
    { targetName: TARGET, bundleIdentifier: BUNDLE, entitlements: { 'com.apple.security.application-groups': [GROUP] } },
  ];
  config = withDangerousMod(config, ['ios', async (mod) => {
    writeWidgetFiles(mod.modRequest.platformProjectRoot, mod.version ?? '0.1.0', mod.ios?.buildNumber ?? '1', GROUP);
    return mod;
  }]);
  return withXcodeProject(config, (mod) => {
    addWidgetTarget(mod.modResults, mod.version ?? '0.1.0', mod.ios?.buildNumber ?? '1', BUNDLE);
    return mod;
  });
}

module.exports = withHomeWidgets;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.writeWidgetFiles = writeWidgetFiles;
module.exports.extensionBundleIdFor = extensionBundleIdFor;
module.exports.appGroupIdFor = appGroupIdFor;
