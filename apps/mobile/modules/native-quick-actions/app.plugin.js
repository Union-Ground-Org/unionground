const fs = require('node:fs');
const path = require('node:path');

const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withAppDelegate,
  withDangerousMod,
  withXcodeProject,
} = require('expo/config-plugins');
const { applyBrandName } = require('../../plugins/babel-brand-name.js');

const IOS_INTENTS_SOURCE = path.join(__dirname, 'plugin/UnionGroundAppIntents.swift');
const IOS_INTENTS_TARGET = 'UnionGroundAppIntents.swift';
const IOS_SHORTCUTS_LOCALIZATIONS = ['en', 'es'];
const IOS_LOCALIZED_STRING_RESOURCES = ['AppShortcuts.strings', 'Localizable.strings'];
const IOS_APP_INTENTS_IMPORT = 'import AppIntents';
const IOS_SHORTCUT_REGISTRATION = 'UnionGroundAppShortcuts.updateAppShortcutParameters()';

function addIosShortcutRegistration(contents) {
  let nextContents = contents;
  if (!new RegExp(`^${IOS_APP_INTENTS_IMPORT}$`, 'm').test(nextContents)) {
    const firstImport = nextContents.match(/^import [^\n]+$/m)?.[0];
    if (!firstImport) {
      throw new Error('Native quick actions could not find a generated iOS import anchor.');
    }
    nextContents = nextContents.replace(firstImport, `${IOS_APP_INTENTS_IMPORT}\n${firstImport}`);
  }

  const anchor = '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
  const registrationBlock = [
    `    ${IOS_SHORTCUT_REGISTRATION}`,
    anchor,
  ].join('\n');
  if (nextContents.includes(registrationBlock)) return nextContents;

  const executableRegistration = new RegExp(`^\\s*${IOS_SHORTCUT_REGISTRATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  if (executableRegistration.test(nextContents)) {
    throw new Error('Native quick actions found iOS shortcut registration outside the launch completion anchor.');
  }
  if (nextContents.split(anchor).length !== 2) {
    throw new Error('Native quick actions could not find the generated iOS launch completion anchor.');
  }
  return nextContents.replace(anchor, registrationBlock);
}

function addIosShortcutResources(xcodeProject, { projectName, supportingDirectory, productName }) {
  const appTargetUUID = xcodeProject.getFirstTarget()?.uuid;
  if (!appTargetUUID) {
    throw new Error('Native quick actions could not resolve the generated iOS application target.');
  }
  const supportingGroupName = `${projectName}/Supporting`;
  const supportingGroup = IOSConfig.XcodeUtils.ensureGroupRecursively(
    xcodeProject,
    supportingGroupName,
  );
  const pbxGroups = xcodeProject.hash?.project?.objects?.PBXGroup ?? {};
  const supportingGroupKey = Object.entries(pbxGroups)
    .find(([key, group]) => !key.endsWith('_comment') && group === supportingGroup)?.[0];
  if (!supportingGroup || !supportingGroupKey) {
    throw new Error('Native quick actions could not find the generated iOS Supporting group.');
  }

  for (const resourceName of IOS_LOCALIZED_STRING_RESOURCES) {
    let variantGroupKey = supportingGroup.children
      .find(({ comment }) => comment === resourceName)?.value;
    if (!variantGroupKey) {
      variantGroupKey = xcodeProject.pbxCreateVariantGroup(resourceName);
      xcodeProject.addToPbxGroup(variantGroupKey, supportingGroupKey);
      const variantBuildFile = {
        uuid: xcodeProject.generateUuid(),
        fileRef: variantGroupKey,
        basename: resourceName,
        group: 'Resources',
        target: appTargetUUID,
      };
      xcodeProject.addToPbxBuildFileSection(variantBuildFile);
      xcodeProject.addToPbxResourcesBuildPhase(variantBuildFile);
    }
    const variantGroup = xcodeProject.getPBXVariantGroupByKey(variantGroupKey);
    if (!variantGroup) {
      throw new Error(`Native quick actions could not create the ${resourceName} localization group.`);
    }

    for (const locale of IOS_SHORTCUTS_LOCALIZATIONS) {
      xcodeProject.addKnownRegion(locale);
      const source = path.join(__dirname, 'plugin', `${locale}.lproj`, resourceName);
      if (!fs.existsSync(source)) {
        throw new Error(`Native quick actions ${locale} ${resourceName} resource is missing.`);
      }

      const localizationDirectory = path.join(supportingDirectory, `${locale}.lproj`);
      fs.mkdirSync(localizationDirectory, { recursive: true });
      const target = path.join(localizationDirectory, resourceName);
      // In the build's own product name (config.name, from app.config.ts).
      fs.writeFileSync(target, applyBrandName(fs.readFileSync(source, 'utf8'), productName));

      const resourcePath = `${locale}.lproj/${resourceName}`;
      const fileReferences = xcodeProject.pbxFileReferenceSection();
      let fileReferenceKey = Object.entries(fileReferences).find(([key, reference]) => (
        !key.endsWith('_comment')
          && typeof reference === 'object'
          && reference !== null
          && [resourcePath, `"${resourcePath}"`].includes(reference.path)
      ))?.[0];

      if (!fileReferenceKey) {
        const addedFile = xcodeProject.addFile(
          resourcePath,
          variantGroupKey,
          { lastKnownFileType: 'text.plist.strings' },
        );
        if (!addedFile) {
          throw new Error(`Native quick actions could not add ${locale} ${resourceName} to Xcode.`);
        }
        fileReferenceKey = addedFile.fileRef;
      } else if (!variantGroup.children.some(({ value }) => value === fileReferenceKey)) {
        xcodeProject.addToPbxVariantGroup({
          fileRef: fileReferenceKey,
          basename: locale,
        }, variantGroupKey);
      }

      const stringsReference = fileReferences[fileReferenceKey];
      if (!stringsReference) {
        throw new Error(`Native quick actions could not resolve ${locale} ${resourceName} in Xcode.`);
      }
      stringsReference.name = locale;
      stringsReference.lastKnownFileType = 'text.plist.strings';
      delete stringsReference.explicitFileType;
      fileReferences[`${fileReferenceKey}_comment`] = locale;

      const variantChild = variantGroup.children.find(({ value }) => value === fileReferenceKey);
      if (!variantChild) {
        throw new Error(`Native quick actions could not link ${locale} ${resourceName} localization.`);
      }
      variantChild.comment = locale;
    }
  }
  return xcodeProject;
}

function withIosShortcutStrings(config) {
  return withXcodeProject(config, (modConfig) => {
    const projectRoot = modConfig.modRequest.projectRoot;
    addIosShortcutResources(modConfig.modResults, {
      projectName: IOSConfig.XcodeUtils.getProjectName(projectRoot),
      supportingDirectory: path.join(IOSConfig.Paths.getSourceRoot(projectRoot), 'Supporting'),
      productName: modConfig.name,
    });
    return modConfig;
  });
}

// The Android shortcuts open the app's own main activity, so they name the
// application id the build uses (config.android.package from app.config.ts).
const shortcutsXml = (applicationId) => `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut android:shortcutId="open_home" android:enabled="true" android:icon="@drawable/ic_quick_action_home" android:shortcutShortLabel="@string/quick_action_home_short" android:shortcutLongLabel="@string/quick_action_home_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${applicationId}" android:targetClass="${applicationId}.MainActivity" android:data="unionground://os-quick-action/home" />
  </shortcut>
  <shortcut android:shortcutId="open_compass" android:enabled="true" android:icon="@drawable/ic_quick_action_compass" android:shortcutShortLabel="@string/quick_action_compass_short" android:shortcutLongLabel="@string/quick_action_compass_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${applicationId}" android:targetClass="${applicationId}.MainActivity" android:data="unionground://os-quick-action/compass" />
  </shortcut>
  <shortcut android:shortcutId="open_messages" android:enabled="true" android:icon="@drawable/ic_quick_action_messages" android:shortcutShortLabel="@string/quick_action_messages_short" android:shortcutLongLabel="@string/quick_action_messages_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${applicationId}" android:targetClass="${applicationId}.MainActivity" android:data="unionground://os-quick-action/messages" />
  </shortcut>
  <shortcut android:shortcutId="open_work" android:enabled="true" android:icon="@drawable/ic_quick_action_work" android:shortcutShortLabel="@string/quick_action_work_short" android:shortcutLongLabel="@string/quick_action_work_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${applicationId}" android:targetClass="${applicationId}.MainActivity" android:data="unionground://os-quick-action/work" />
  </shortcut>
</shortcuts>
`;

const stringsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="quick_action_home_short">Home</string>
  <string name="quick_action_home_long">Open Home</string>
  <string name="quick_action_compass_short">Guide</string>
  <string name="quick_action_compass_long">Open Guide</string>
  <string name="quick_action_messages_short">Messages</string>
  <string name="quick_action_messages_long">Open Messages</string>
  <string name="quick_action_work_short">Work</string>
  <string name="quick_action_work_long">Open Work</string>
</resources>
`;

const spanishStringsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="quick_action_home_short">Inicio</string>
  <string name="quick_action_home_long">Abrir Inicio</string>
  <string name="quick_action_compass_short">Guía</string>
  <string name="quick_action_compass_long">Abrir la Guía</string>
  <string name="quick_action_messages_short">Mensajes</string>
  <string name="quick_action_messages_long">Abrir Mensajes</string>
  <string name="quick_action_work_short">Trabajo</string>
  <string name="quick_action_work_long">Abrir Trabajo</string>
</resources>
`;

const vectorIcons = {
  ic_quick_action_home: 'M10,20v-6h4v6h5v-8h3L12,3 2,12h3v8z',
  ic_quick_action_compass: 'M12,2a10,10 0,1 0,0 20 10,10 0,0 0,0-20m2.2,12.2L6,18l3.8-8.2L18,6z',
  ic_quick_action_messages: 'M20,2H4a2,2 0,0 0-2,2v18l4-4h14a2,2 0,0 0,2-2V4a2,2 0,0 0-2-2',
  ic_quick_action_work: 'M20,6h-4V4a2,2 0,0 0-2-2h-4a2,2 0,0 0-2,2v2H4a2,2 0,0 0-2,2v11a2,2 0,0 0,2,2h16a2,2 0,0 0,2-2V8a2,2 0,0 0-2-2m-6,0h-4V4h4z',
};

function vectorXml(pathData) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24" android:tint="#0E4034">
  <path android:fillColor="#FFFFFFFF" android:pathData="${pathData}" />
</vector>
`;
}

function writeAndroidShortcutResources(resourceRoot, applicationId) {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(applicationId ?? '')) {
    throw new Error('Android quick actions need the application id the build uses.');
  }
  const xmlRoot = path.join(resourceRoot, 'xml');
  const valuesRoot = path.join(resourceRoot, 'values');
  const spanishValuesRoot = path.join(resourceRoot, 'values-es');
  const drawableRoot = path.join(resourceRoot, 'drawable');
  fs.mkdirSync(xmlRoot, { recursive: true });
  fs.mkdirSync(valuesRoot, { recursive: true });
  fs.mkdirSync(spanishValuesRoot, { recursive: true });
  fs.mkdirSync(drawableRoot, { recursive: true });
  fs.writeFileSync(path.join(xmlRoot, 'shortcuts.xml'), shortcutsXml(applicationId));
  fs.writeFileSync(path.join(valuesRoot, 'native_quick_action_strings.xml'), stringsXml);
  fs.writeFileSync(path.join(spanishValuesRoot, 'native_quick_action_strings.xml'), spanishStringsXml);
  for (const [name, pathData] of Object.entries(vectorIcons)) {
    fs.writeFileSync(path.join(drawableRoot, `${name}.xml`), vectorXml(pathData));
  }
}

function withNativeQuickActions(config) {
  config = withIosShortcutStrings(config);
  const intentsSource = applyBrandName(fs.readFileSync(IOS_INTENTS_SOURCE, 'utf8'), config.name);
  config = IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: IOS_INTENTS_TARGET,
    contents: intentsSource,
    overwrite: true,
  });

  config = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift') {
      throw new Error('Native quick actions require the generated Swift AppDelegate.');
    }
    modConfig.modResults.contents = addIosShortcutRegistration(modConfig.modResults.contents);
    return modConfig;
  });

  config = withAndroidManifest(config, (modConfig) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults);
    const metadata = (activity['meta-data'] ?? []).filter((item) => (
      item?.$?.['android:name'] !== 'android.app.shortcuts'
    ));
    metadata.push({
      $: {
        'android:name': 'android.app.shortcuts',
        'android:resource': '@xml/shortcuts',
      },
    });
    activity['meta-data'] = metadata;
    return modConfig;
  });

  return withDangerousMod(config, ['android', async (modConfig) => {
    const resourceRoot = path.join(modConfig.modRequest.platformProjectRoot, 'app/src/main/res');
    writeAndroidShortcutResources(resourceRoot, modConfig.android?.package);
    return modConfig;
  }]);
}

module.exports = withNativeQuickActions;
module.exports.addIosShortcutRegistration = addIosShortcutRegistration;
module.exports.addIosShortcutResources = addIosShortcutResources;
module.exports.writeAndroidShortcutResources = writeAndroidShortcutResources;
