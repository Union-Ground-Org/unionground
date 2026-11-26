const fs = require('node:fs');
const path = require('node:path');

const plist = require('@expo/plist').default;
const { AndroidConfig, withFinalizedMod, withStringsXml, withXcodeProject } = require('expo/config-plugins');
const { applyBrandName } = require('../../plugins/babel-brand-name.js');
const withExpoSharing = require('expo-sharing/app.plugin.js').default;

const TARGET_NAME = 'expo-sharing-extension';
// The share extension and its app group are named after the application id
// the build uses (config.ios.bundleIdentifier from app.config.ts).
const extensionBundleIdFor = (applicationId) => `${applicationId}.secure-share-intake`;
const appGroupIdFor = (applicationId) => `group.${applicationId}.secure-share-intake`;
const ALLOWED_TYPE_IDENTIFIERS = Object.freeze([
  'com.adobe.pdf',
  'public.jpeg',
  'public.png',
  'org.webmproject.webp',
  'public.plain-text',
  'public.comma-separated-values-text',
  'org.openxmlformats.wordprocessingml.document',
  'org.openxmlformats.spreadsheetml.sheet',
]);

function buildActivationRule() {
  const clauses = ALLOWED_TYPE_IDENTIFIERS.map(
    (identifier) => `ANY $attachment.registeredTypeIdentifiers UTI-EQUALS "${identifier}"`,
  );
  return `SUBQUERY(extensionItems, $item, SUBQUERY($item.attachments, $attachment, (${clauses.join(' OR ')})).@count == 1).@count == 1`;
}

const ACTIVATION_RULE = buildActivationRule();

function setExtensionTargetDeviceFamily(xcodeProject, extensionBundleId) {
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();
  let updated = 0;
  for (const [key, configuration] of Object.entries(configurations)) {
    if (key.endsWith('_comment') || !configuration?.buildSettings) continue;
    if (configuration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER !== `"${extensionBundleId}"`) continue;
    configuration.buildSettings.TARGETED_DEVICE_FAMILY = '"1"';
    configuration.buildSettings.APPLICATION_EXTENSION_API_ONLY = 'YES';
    updated += 1;
  }
  if (updated !== 2) {
    throw new Error('Secure share extension must have exactly two iPhone-only build configurations.');
  }
}

function withSecureShareIntake(config) {
  const applicationId = config.ios?.bundleIdentifier;
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(applicationId ?? '')) {
    throw new Error('Secure share intake needs the iOS bundle identifier the build uses.');
  }
  const EXTENSION_BUNDLE_ID = extensionBundleIdFor(applicationId);
  const APP_GROUP_ID = appGroupIdFor(applicationId);
  // Expo config mods run the most recently registered interceptor first. Add
  // our mutation before wrapping it with expo-sharing so the extension target
  // and both of its build configurations exist when this callback executes.
  config = withXcodeProject(config, (modConfig) => {
    setExtensionTargetDeviceFamily(modConfig.modResults, EXTENSION_BUNDLE_ID);
    return modConfig;
  });

  config = withExpoSharing(config, {
    ios: {
      enabled: true,
      extensionBundleIdentifier: EXTENSION_BUNDLE_ID,
      appGroupId: APP_GROUP_ID,
      activationRule: ACTIVATION_RULE,
    },
    android: { enabled: false },
  });

  // The Android share target's title is a library string resource; the app's
  // own copy of it, in the build's product name, overrides the default.
  config = withStringsXml(config, (modConfig) => {
    modConfig.modResults = AndroidConfig.Strings.setStringItem([{
      $: { name: 'secure_share_intake_title', translatable: 'false' },
      _: applyBrandName('Save to Union Ground', modConfig.name),
    }], modConfig.modResults);
    return modConfig;
  });

  return withFinalizedMod(config, ['ios', async (modConfig) => {
    const source = path.join(
      modConfig.modRequest.projectRoot,
      'modules/secure-share-intake/plugin/ShareIntakeViewController.swift',
    );
    const targetDirectory = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
    const target = path.join(targetDirectory, 'ShareIntoViewController.swift');
    if (!fs.existsSync(source) || !fs.existsSync(targetDirectory)) {
      throw new Error('Secure share extension source or generated target is missing.');
    }
    // In the build's own product name (config.name, from app.config.ts).
    fs.writeFileSync(target, applyBrandName(fs.readFileSync(source, 'utf8'), modConfig.name));
    const generated = fs.readFileSync(target, 'utf8');
    if (generated.includes('UIApplication') || generated.includes('openURL(') || generated.includes('print(')) {
      throw new Error('Secure share extension must not launch the containing app or log provider data.');
    }
    const info = {
      AppGroupId: APP_GROUP_ID,
      CFBundleDisplayName: applyBrandName('Save to Union Ground', modConfig.name),
      CFBundleExecutable: '$(EXECUTABLE_NAME)',
      CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
      CFBundleInfoDictionaryVersion: '6.0',
      CFBundleName: '$(PRODUCT_NAME)',
      CFBundlePackageType: 'XPC!',
      CFBundleShortVersionString: '$(MARKETING_VERSION)',
      CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
      NSExtension: {
        NSExtensionAttributes: { NSExtensionActivationRule: ACTIVATION_RULE },
        NSExtensionPointIdentifier: 'com.apple.share-services',
        NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareIntoViewController',
      },
    };
    fs.writeFileSync(path.join(targetDirectory, 'Info.plist'), plist.build(info));
    return modConfig;
  }]);
}

module.exports = withSecureShareIntake;
module.exports.ALLOWED_TYPE_IDENTIFIERS = ALLOWED_TYPE_IDENTIFIERS;
module.exports.buildActivationRule = buildActivationRule;
module.exports.setExtensionTargetDeviceFamily = setExtensionTargetDeviceFamily;
