import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExpoConfig } from 'expo/config';

type MobileExpoConfig = ExpoConfig & { newArchEnabled: boolean };
// Expo transpiles this config entry independently during prebuild/EAS config
// resolution. Keep its build-time guards self-contained instead of importing
// TypeScript modules from the application bundle.
type MobileReleaseEnvironment = 'development' | 'preview' | 'staging' | 'production';
type MobileReleaseIdentity = {
  applicationId: string;
  applicationVersion: string;
  releaseEnvironment: MobileReleaseEnvironment;
  storeBuild: boolean;
  easProjectId: string | null;
  expoOwner: string | null;
  previewEnabled: boolean;
};

// The release identity (application id, Expo owner, EAS project) is whoever
// builds the app's own. config/mobile-release-foundation.json carries
// placeholder defaults (an org.example application id, no owner, no project);
// the environment variables MOBILE_APPLICATION_ID, EXPO_OWNER and
// EAS_PROJECT_ID replace them (apps/mobile/README.md, "Your own app
// identity"). A store build refuses the placeholders. Never reuse a sibling
// application's application id, EAS project, Expo owner, scheme, provider, or
// host.
const applicationVersion = '0.3.0';
const releaseFoundation = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../config/mobile-release-foundation.json'),
  'utf8',
)) as { applicationId: string; expoOwner: string; easProjectId: string };
const applicationIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const expoOwnerPattern = /^[a-z0-9][a-z0-9_-]*$/;
const easProjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const placeholderApplicationIdPattern = /^(?:org|com|net)\.example\./;
// These origins are a security boundary. The storage adapter invalidates old
// sessions on an origin change, while this source pin also prevents sign-in
// data from reaching an environment-selected host. No Union Ground backend
// is provisioned yet, so config/sample-backend.json pins none: every build is
// the fictional preview, live sign-in fails closed, and any backend input is
// refused. Add an exact origin only after owner approval; EAS environment
// values alone are not approval.
const sampleBackend = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../config/sample-backend.json'),
  'utf8',
)) as {
  samplePortalOrigin: string;
  sampleSupabaseOrigin: string;
  sampleSupabaseRef: string;
  forbiddenSupabaseRefSha256: string[];
};
const appLinksPolicy = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../config/mobile-app-links.json'),
  'utf8',
)) as {
  enabled: boolean;
  applicationId: string;
  domains: string[];
  appleAppIDs: string[];
  androidCertFingerprints: string[];
};

const appLinkPolicyKeys = ['androidCertFingerprints', 'appleAppIDs', 'applicationId', 'domains', 'enabled'];
if (Object.keys(appLinksPolicy).sort().join(',') !== appLinkPolicyKeys.sort().join(',')) {
  throw new Error('Mobile app-link policy has an unknown or missing field.');
}
if (typeof appLinksPolicy.enabled !== 'boolean'
  || !Array.isArray(appLinksPolicy.domains)
  || !Array.isArray(appLinksPolicy.appleAppIDs)
  || !Array.isArray(appLinksPolicy.androidCertFingerprints)) {
  throw new Error('Mobile app-link policy has invalid field types.');
}
if (appLinksPolicy.applicationId !== releaseFoundation.applicationId) {
  throw new Error('Mobile app-link policy must match the application identifier in config/mobile-release-foundation.json.');
}
// Union Ground has no verified web domain of its own yet. Universal and
// App Links stay off until one is approved and listed here.
const approvedAppLinkDomains: string[] = [];
if (appLinksPolicy.domains.join(',') !== approvedAppLinkDomains.join(',')) {
  throw new Error('Mobile app-link domains must stay exact and source-approved.');
}
if (appLinksPolicy.enabled
  ? appLinksPolicy.appleAppIDs.length === 0 || appLinksPolicy.androidCertFingerprints.length === 0
  : appLinksPolicy.appleAppIDs.length > 0 || appLinksPolicy.androidCertFingerprints.length > 0) {
  throw new Error('Mobile app-link identities must be populated atomically with the enabled policy.');
}
if (appLinksPolicy.appleAppIDs.some((appID) => (
  !/^[A-Z0-9]{10}\.[a-zA-Z0-9.-]+$/.test(appID) || !appID.endsWith(`.${appLinksPolicy.applicationId}`)
))) {
  throw new Error('Mobile app-link policy contains an invalid Apple application identifier.');
}
if (appLinksPolicy.androidCertFingerprints.some((fingerprint) => (
  !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)
))) {
  throw new Error('Mobile app-link policy contains an invalid Android SHA-256 certificate fingerprint.');
}

const approvedSampleOrigin = (sampleBackend.sampleSupabaseOrigin.trim()
  || (sampleBackend.sampleSupabaseRef.trim() ? `https://${sampleBackend.sampleSupabaseRef.trim()}.supabase.co` : ""));
const approvedBuildSupabaseOrigins: Partial<Record<MobileReleaseEnvironment, string>> = {
  development: approvedSampleOrigin || undefined,
  preview: approvedSampleOrigin || undefined,
  production: approvedSampleOrigin || undefined,
};
// The Guide answers over the network only for a source-approved backend.
const approvedCompassSupabaseOrigins: Partial<Record<MobileReleaseEnvironment, string>> = {
  development: approvedSampleOrigin || undefined,
  preview: approvedSampleOrigin || undefined,
  production: approvedSampleOrigin || undefined,
};
const profileEnvironment: Record<string, MobileReleaseEnvironment> = {
  development: 'development',
  preview: 'preview',
  'ci-ios-simulator': 'preview',
  staging: 'staging',
  production: 'production',
};

function optionalValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function parsePreviewEnabled(value: string | undefined): boolean {
  const normalized = optionalValue(value);
  // Every native build exposes an explicit demo
  // choice at sign-in. Defaulting on keeps ad-hoc local Release builds aligned
  // with the four EAS profiles; an environment may no longer compile the
  // entry out and recreate the physical-build failure this guard replaces.
  if (normalized === null || normalized === '1') return true;
  throw new Error('EXPO_PUBLIC_PREVIEW_ENABLED must be 1 or unset; every mobile build includes the explicit demo entry.');
}

function configuredBuildProfile(environment: NodeJS.ProcessEnv): string | null {
  const workerProfile = optionalValue(environment.EAS_BUILD_PROFILE);
  // EAS evaluates the profile env locally before its worker injects
  // EAS_BUILD_PROFILE. The explicit marker must agree once both are present.
  const localProfile = optionalValue(environment.MOBILE_BUILD_PROFILE);
  if (workerProfile && localProfile && workerProfile !== localProfile) {
    throw new Error('MOBILE_BUILD_PROFILE must match EAS_BUILD_PROFILE.');
  }
  return workerProfile ?? localProfile;
}

function resolveMobileReleaseIdentity(environment: NodeJS.ProcessEnv): MobileReleaseIdentity {
  const buildProfile = configuredBuildProfile(environment);
  const profileReleaseEnvironment = buildProfile ? profileEnvironment[buildProfile] : null;
  if (buildProfile && !profileReleaseEnvironment) {
    throw new Error(`Unsupported EAS build profile: ${buildProfile}.`);
  }
  const configuredReleaseEnvironment = optionalValue(environment.MOBILE_RELEASE_ENV);
  if (configuredReleaseEnvironment && !['development', 'preview', 'staging', 'production'].includes(configuredReleaseEnvironment)) {
    throw new Error(`Unsupported mobile release environment: ${configuredReleaseEnvironment}.`);
  }
  if (profileReleaseEnvironment && configuredReleaseEnvironment && profileReleaseEnvironment !== configuredReleaseEnvironment) {
    throw new Error(`EAS build profile ${buildProfile} cannot use mobile release environment ${configuredReleaseEnvironment}.`);
  }
  const releaseEnvironment = (configuredReleaseEnvironment ?? profileReleaseEnvironment ?? 'development') as MobileReleaseEnvironment;

  const applicationId = optionalValue(environment.MOBILE_APPLICATION_ID)
    ?? optionalValue(releaseFoundation.applicationId) ?? '';
  if (!applicationIdPattern.test(applicationId)) {
    throw new Error('MOBILE_APPLICATION_ID must be a lowercase reverse-DNS application identifier.');
  }
  const expoOwner = optionalValue(environment.EXPO_OWNER) ?? optionalValue(releaseFoundation.expoOwner);
  if (expoOwner !== null && !expoOwnerPattern.test(expoOwner)) {
    throw new Error('EXPO_OWNER must be an Expo account name.');
  }
  const configuredProjectId = optionalValue(environment.EAS_PROJECT_ID) ?? optionalValue(releaseFoundation.easProjectId);
  if (configuredProjectId !== null && !easProjectIdPattern.test(configuredProjectId)) {
    throw new Error('EAS_PROJECT_ID must be a lowercase EAS project UUID.');
  }
  // The EAS builder reports the project it builds; it must be the configured
  // one, and supplies the project when none is configured.
  const builderProjectId = optionalValue(environment.EAS_BUILD_PROJECT_ID);
  if (builderProjectId !== null && configuredProjectId !== null && builderProjectId !== configuredProjectId) {
    throw new Error('EAS_BUILD_PROJECT_ID must exactly match the configured EAS_PROJECT_ID.');
  }
  const easProjectId = configuredProjectId ?? builderProjectId;

  const previewEnabled = parsePreviewEnabled(environment.EXPO_PUBLIC_PREVIEW_ENABLED);
  const storeBuild = releaseEnvironment === 'staging' || releaseEnvironment === 'production';
  const nativeDeepLinkProof = optionalValue(environment.EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF);
  if (nativeDeepLinkProof !== null && nativeDeepLinkProof !== '1') {
    throw new Error('EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF must be 1 or unset.');
  }
  if (storeBuild && nativeDeepLinkProof === '1') {
    throw new Error('Native deep-link proof instrumentation is forbidden in store builds.');
  }
  if (storeBuild && (placeholderApplicationIdPattern.test(applicationId) || !expoOwner || !easProjectId)) {
    throw new Error('Store builds need your own MOBILE_APPLICATION_ID, EXPO_OWNER and EAS_PROJECT_ID, not the placeholders.');
  }

  return {
    applicationId,
    applicationVersion,
    releaseEnvironment,
    storeBuild,
    easProjectId,
    expoOwner,
    previewEnabled,
  };
}

const releaseIdentity = resolveMobileReleaseIdentity(process.env);

// The product name and mark (the rules of src/lib/shared-core/brand.js, kept
// self-contained here like the other build-time guards; the mobile brand
// tests hold the two in step). Unbranded by default: the name comes from
// BRAND_NAME and the icons are neutral placeholders. A store build (staging,
// production) fails without a name of its own, or with the Union Ground name
// unless OFFICIAL_BRANDING=1 and branding/official/ is present, which only
// Union Ground LLC's own builds use (branding/official/LICENSE.md).
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const officialBrandingDirectory = join(repositoryRoot, 'branding/official');
const officialAppIcon = join(officialBrandingDirectory, 'mark-tile-1024.png');
const officialDomains = JSON.parse(readFileSync(join(repositoryRoot, 'config/official-domains.json'), 'utf8')) as {
  webHosts: string[];
  supabaseOrigins: string[];
};
const UNION_GROUND_NAME = 'Union Ground';
const DEVELOPMENT_BRAND_NAME = 'Union workspace (development build)';
const DEFAULT_SOURCE_CODE_URL = 'https://github.com/Union-Ground-Org/unionground';
const brandNamePattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&()’-]{1,59}$/u;
type PhoneBrand = { name: string; official: boolean; initial: string; sourceCodeUrl: string };

function resolvePhoneBrand(environment: NodeJS.ProcessEnv, storeBuild: boolean): PhoneBrand {
  const name = (environment.BRAND_NAME ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const flag = (environment.OFFICIAL_BRANDING ?? '').trim();
  if (flag !== '' && flag !== '0' && flag !== '1') throw new Error('OFFICIAL_BRANDING must be 1 or unset.');
  const reserved = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes('unionground');
  const ownName = 'Set BRAND_NAME to your own product name; copies of Union Ground use their own name and logo (TRADEMARKS.md).';
  const rawSource = (environment.SOURCE_CODE_URL ?? '').trim();
  let sourceCodeUrl = DEFAULT_SOURCE_CODE_URL;
  if (rawSource) {
    let parsed: URL | null = null;
    try { parsed = new URL(rawSource); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('SOURCE_CODE_URL must be an https URL of this build\'s source code.');
    }
    sourceCodeUrl = parsed.href;
  }
  const result = (resolved: string, official: boolean): PhoneBrand => ({
    name: resolved,
    official,
    initial: (/[\p{L}\p{N}]/u.exec(resolved)?.[0] ?? '?').toLocaleUpperCase(),
    sourceCodeUrl,
  });
  if (flag === '1') {
    if (existsSync(officialAppIcon)) {
      if (name && !reserved) throw new Error('OFFICIAL_BRANDING=1 always uses the Union Ground name; unset BRAND_NAME or turn official branding off.');
      return result(UNION_GROUND_NAME, true);
    }
    if (storeBuild) throw new Error(`OFFICIAL_BRANDING=1, but branding/official/ is missing. Official branding is only for Union Ground LLC's own builds. Unset OFFICIAL_BRANDING. ${ownName}`);
    return result(DEVELOPMENT_BRAND_NAME, false);
  }
  if (!name) {
    if (storeBuild) throw new Error(`BRAND_NAME is not set. A store build needs a product name. ${ownName}`);
    return result(DEVELOPMENT_BRAND_NAME, false);
  }
  if (!brandNamePattern.test(name)) {
    throw new Error('BRAND_NAME must be 2 to 60 letters, digits, spaces or . , & ( ) ’ -, starting with a letter or digit.');
  }
  if (reserved) {
    if (storeBuild) throw new Error(`BRAND_NAME is "${name}". The Union Ground name is reserved for Union Ground LLC's official builds. ${ownName}`);
    return result(DEVELOPMENT_BRAND_NAME, false);
  }
  return result(name, false);
}

const brand = resolvePhoneBrand(process.env, releaseIdentity.storeBuild);
const brandText = (text: string) => text.replaceAll(UNION_GROUND_NAME, brand.name);
const officialBrandingFile = (name: string) => `../../branding/official/${name}`;
const appIcon = brand.official ? officialBrandingFile('mark-tile-1024.png') : './assets/icon.png';
const androidForeground = brand.official ? officialBrandingFile('mark-tile-1024.png') : './assets/android-icon-foreground.png';
const splashImage = brand.official ? officialBrandingFile('mark-tile-1024.png') : './assets/splash-icon.png';
if (appLinksPolicy.enabled && appLinksPolicy.applicationId !== releaseIdentity.applicationId) {
  throw new Error('Enabled app links name a different application identifier than MOBILE_APPLICATION_ID.');
}
const approvedBackendOrigin = approvedBuildSupabaseOrigins[releaseIdentity.releaseEnvironment];
const portalOrigin = sampleBackend.samplePortalOrigin;

// Over-the-air updates. Every EAS build profile reads only the channel named
// after it (eas.json carries the same name), and a config with no build
// profile, such as `expo start`, has updates off. Updates also stay off until
// the builder sets its own EAS_PROJECT_ID: there is no default update server.
// The runtime version is Expo's fingerprint of the native project: native
// modules, config plugins, native settings and this config's values, the
// backend and the channel included. So an update reaches only builds of the
// same profile with the same native code, whatever channel it was published to.
const updateChannel = configuredBuildProfile(process.env);

function publishableKeyForClientBundle(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!key) return '';
  if (!/^sb_publishable_[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key.');
  }
  return key;
}

function normalizedHttpsUrl(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const originOnly = url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
    return url.protocol === 'https:' && originOnly ? url.origin : null;
  } catch {
    return null;
  }
}

const supabasePublishableKey = publishableKeyForClientBundle(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
const supabaseUrl = normalizedHttpsUrl(process.env.EXPO_PUBLIC_SUPABASE_URL);
const shareRecoveryTestFlag = optionalValue(process.env.EXPO_PUBLIC_SHARE_RECOVERY_TEST_HOOK);
if (shareRecoveryTestFlag !== null && shareRecoveryTestFlag !== '1') {
  throw new Error('EXPO_PUBLIC_SHARE_RECOVERY_TEST_HOOK must be 1 or unset.');
}
const shareRecoveryTestHook = shareRecoveryTestFlag === '1';
// One explicit development-only opt-in gates upload, cleanup, notification and
// sign-out ordering controls. Do not enable it through a shared EAS profile.
if (shareRecoveryTestHook && (releaseIdentity.releaseEnvironment !== 'development'
  || !approvedSampleOrigin || supabaseUrl !== approvedSampleOrigin)) {
  throw new Error('Share-recovery test instrumentation requires a development build on the approved backend.');
}
const placeholderBackend = !supabasePublishableKey
  || /replace|your[_-]?project/i.test(supabasePublishableKey)
  || Boolean(supabaseUrl && /your[_-]?project/i.test(supabaseUrl));
const backendConfigured = Boolean(supabaseUrl) && !placeholderBackend;
const compassNetworkEnabled = Boolean(supabaseUrl
  && approvedCompassSupabaseOrigins[releaseIdentity.releaseEnvironment] === supabaseUrl);
const backendInputPresent = Boolean(optionalValue(process.env.EXPO_PUBLIC_SUPABASE_URL)
  || optionalValue(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
const managedBuild = Boolean(optionalValue(process.env.EAS_BUILD_PROFILE)
  || optionalValue(process.env.MOBILE_RELEASE_ENV));

// The sibling product's projects are listed by digest
// (scripts/lib/denied-identity.mjs), so the repository refuses them without
// naming them; this hashes the ref of a Supabase-hosted origin the same way.
const supabaseRef = supabaseUrl ? /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(supabaseUrl.toLowerCase())?.[1] : undefined;
const denyDigest = (value: string) => createHash('sha256').update(`union-ground/deny-list/v1:${value}`).digest('hex');
if (supabaseRef && sampleBackend.forbiddenSupabaseRefSha256.includes(denyDigest(supabaseRef))) {
  throw new Error('Union Ground builds cannot use a sibling product\'s Supabase project.');
}

if (managedBuild) {
  const { releaseEnvironment } = releaseIdentity;
  const approvedOrigin = approvedBackendOrigin;
  // A store build without an approved origin is the preview-only public beta.
  if (!approvedOrigin && backendInputPresent) {
    throw new Error(`${releaseEnvironment} builds cannot configure a backend until its exact owner-approved origin is pinned in source.`);
  }
  if (approvedOrigin && (releaseIdentity.storeBuild || backendInputPresent)
    && (!backendConfigured || supabaseUrl !== approvedOrigin)) {
    throw new Error(`${releaseEnvironment} builds require the exact source-approved Supabase origin and a publishable key.`);
  }
}

// Official apps talk only to the official service: an official build refuses
// any configured backend that is not on config/official-domains.json.
if (brand.official && backendInputPresent && !(supabaseUrl && officialDomains.supabaseOrigins.includes(supabaseUrl))) {
  throw new Error('Official Union Ground builds talk only to the official service; this backend is not on config/official-domains.json.');
}

const config: MobileExpoConfig = {
  name: brand.name,
  slug: 'union-ground-mobile',
  ...(releaseIdentity.expoOwner ? { owner: releaseIdentity.expoOwner } : {}),
  version: releaseIdentity.applicationVersion,
  platforms: ['ios', 'android'],
  orientation: 'portrait',
  scheme: 'unionground',
  userInterfaceStyle: 'light',
  backgroundColor: '#F6F2E9',
  newArchEnabled: true,
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    enabled: updateChannel !== null && releaseIdentity.easProjectId !== null,
    ...(releaseIdentity.easProjectId ? { url: `https://u.expo.dev/${releaseIdentity.easProjectId}` } : {}),
    // Checked at launch without waiting: the app opens on the code it has and
    // a downloaded update applies at the next cold start.
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
    ...(updateChannel ? { requestHeaders: { 'expo-channel-name': updateChannel } } : {}),
  },
  ios: {
    icon: appIcon,
    supportsTablet: false,
    bundleIdentifier: releaseIdentity.applicationId,
    buildNumber: '3',
    ...(appLinksPolicy.enabled ? {
      associatedDomains: appLinksPolicy.domains.map((domain) => `applinks:${domain}`),
    } : {}),
    infoPlist: {
      NSMicrophoneUsageDescription: brandText('Union Ground records voice notes only while you are actively recording in the shortcuts panel.'),
    },
    // The app reaches cryptography only through the operating system (TLS,
    // Keychain, and the CryptoKit-backed hashing and random identifiers in
    // expo-crypto) and bundles no proprietary or standard encryption
    // algorithm. Revisit this value before adding any dependency that ships its
    // own encryption. expo-updates downloads
    // over the system's TLS and uses the system libraries (iOS CommonCrypto and
    // Security, Android java.security, plus bundled ASN.1 certificate parsing)
    // only for SHA-256 checks of downloaded files and the optional update
    // signature check, which is not configured here: integrity and
    // authentication, not encryption.
    config: { usesNonExemptEncryption: false },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
      ],
    },
  },
  android: {
    icon: androidForeground,
    package: releaseIdentity.applicationId,
    versionCode: 2,
    adaptiveIcon: {
      // The official tile has rounded transparent corners; pine fills them.
      backgroundColor: brand.official ? '#0A2F26' : '#F6F2E9',
      foregroundImage: androidForeground,
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: ['CAMERA', 'POST_NOTIFICATIONS', 'RECORD_AUDIO', 'USE_BIOMETRIC', 'VIBRATE'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      // Voice notes play only while their screen is open. Google Play will
      // not accept the media-playback foreground-service declaration without
      // a background-playback demo video, so these stay out of the manifest.
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    ],
    predictiveBackGestureEnabled: true,
    softwareKeyboardLayoutMode: 'resize',
    ...(appLinksPolicy.enabled ? {
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: appLinksPolicy.domains.map((host) => ({ scheme: 'https', host, pathPrefix: '/app' })),
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    } : {}),
  },
  plugins: [
    'expo-router',
    // The app paints the safe-area canvas itself. Android's default
    // three-button contrast scrim otherwise adds a third tone below drawers.
    ['expo-navigation-bar', { enforceContrast: false, style: 'dark' }],
    [
      'expo-audio',
      {
        microphonePermission: brandText('Union Ground records voice notes only while you are actively recording in the shortcuts panel.'),
        // Drops the Android mediaPlayback foreground service and the iOS audio
        // background mode. Voice notes play only while their screen is open.
        enableBackgroundPlayback: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: false,
        cameraPermission: brandText('Union Ground uses the camera only when you choose Scan document for an issue or task attachment.'),
        microphonePermission: brandText('Union Ground records voice notes only while you are actively recording in the shortcuts panel.'),
      },
    ],
    [
      'expo-secure-store',
      {
        configureAndroidBackup: false,
        faceIDPermission: brandText('Allow Union Ground to protect your organizing session with Face ID.'),
      },
    ],
    [
      'expo-local-authentication',
      {
        faceIDPermission: brandText('Use Face ID to unlock your private Union Ground workspace.'),
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#0E4034',
        defaultChannel: 'organizing-updates',
      },
    ],
    // Local modules under ./modules autolink on both platforms without an
    // entry here; only modules that must mutate the generated native projects
    // (manifests, entitlements, generated sources) register a config plugin.
    './modules/secure-share-intake/app.plugin.js',
    './modules/native-quick-actions/app.plugin.js',
    './modules/home-widgets/app.plugin.js',
    './modules/store-age-signal/app.plugin.js',
    './plugins/with-android-keep-rules.js',
    // iOS 27 kills apps that keep the pre-scene life cycle; this registers
    // Expo's scene delegate and hands it the React Native factory.
    './plugins/with-ios-scene-lifecycle.js',
    // Reminders are scheduled on the device. No remote push service is
    // provisioned, so the unused aps-environment entitlement is removed.
    './plugins/with-local-notifications-only.js',
    './plugins/with-ios-tab-accessibility.js',
    './plugins/with-android-release-shrinking.js',
    // The theme's typefaces, embedded in the build (UX-UNIONGROUND-NATIVE-ARCHIVO-AND-
    // PUBLIC-SANS-TYPEFACES-20261115): static files, one per weight. iOS reads each file's
    // family name; Android gets XML font families under the same two names, so a style's
    // family and weight pick the same face on both. Sources and licences:
    // fonts/README.md. Roles: src/theme/tokens.ts typography.
    [
      'expo-font',
      {
        ios: {
          fonts: [
            './fonts/Archivo-ExtraBold.ttf',
            './fonts/PublicSans-Regular.ttf',
            './fonts/PublicSans-Medium.ttf',
            './fonts/PublicSans-SemiBold.ttf',
            './fonts/PublicSans-Bold.ttf',
          ],
        },
        android: {
          fonts: [
            {
              fontFamily: 'Archivo',
              fontDefinitions: [{ path: './fonts/Archivo-ExtraBold.ttf', weight: 800 }],
            },
            {
              fontFamily: 'Public Sans',
              fontDefinitions: [
                { path: './fonts/PublicSans-Regular.ttf', weight: 400 },
                { path: './fonts/PublicSans-Medium.ttf', weight: 500 },
                { path: './fonts/PublicSans-SemiBold.ttf', weight: 600 },
                { path: './fonts/PublicSans-Bold.ttf', weight: 700 },
              ],
            },
            // Android before API 28 picks only NORMAL or BOLD from a family, so the
            // in-between weights also get a family of their own (tokens.ts
            // resolveTypography names them there).
            {
              fontFamily: 'Public Sans Medium',
              fontDefinitions: [{ path: './fonts/PublicSans-Medium.ttf', weight: 500 }],
            },
            {
              fontFamily: 'Public Sans SemiBold',
              fontDefinitions: [{ path: './fonts/PublicSans-SemiBold.ttf', weight: 600 }],
            },
          ],
        },
      },
    ],
    [
      'expo-splash-screen',
      {
        // Light-only app: no dark splash variant, or OS-dark devices flash a
        // near-black launch screen before the forced-light UI.
        backgroundColor: '#F6F2E9',
        image: splashImage,
        imageWidth: 148,
        // BUG-UG-NATIVE-ANDROID-LAUNCH-MARK-CLIPPED-AND-SIGN-IN-HEADER-LOW-20261115:
        // Android 12+ shows the splash icon only inside a circle two thirds of
        // the plugin's 288 dp canvas (192 dp across). The mark's rounded
        // corners reach 0.617 of its width from the centre, so at 180 dp they
        // were cut (111 dp > 96 dp); at 144 dp they reach 89 dp and the whole
        // mark shows. iOS has no mask and keeps 180 pt.
        android: { imageWidth: 144 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    productName: brand.name,
    ...(releaseIdentity.easProjectId ? { eas: { projectId: releaseIdentity.easProjectId } } : {}),
    releaseEnvironment: releaseIdentity.releaseEnvironment,
    supabaseUrl: supabaseUrl ?? '',
    supabasePublishableKey,
    portalBaseUrl: portalOrigin,
    compassNetworkEnabled,
    previewEnabled: releaseIdentity.previewEnabled,
    shareRecoveryTestHook,
    appLinksEnabled: appLinksPolicy.enabled,
  },
};

export default config;
