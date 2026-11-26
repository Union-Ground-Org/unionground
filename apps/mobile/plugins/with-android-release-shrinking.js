// Turn on R8 for the Android release build: shrink, optimize and obfuscate the
// app code, and drop unused resources. Google Play flags an unoptimized DEX
// (OPS-UG-ANDROID-DEX-OPTIMIZATION-BELOW-STORE-THRESHOLD-20261113).
// Keep rules come from each library's consumer rules; the app adds none until
// a release build shows one is missing. Debug builds are unchanged.
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};
// The template's default file carries -dontoptimize, which leaves R8 shrinking
// without optimizing; the optimize variant is the one Play's notice measures.
const DEFAULT_RULES = 'getDefaultProguardFile("proguard-android.txt")';
const OPTIMIZE_RULES = 'getDefaultProguardFile("proguard-android-optimize.txt")';

function setReleaseProperties(properties) {
  const rest = properties.filter((item) => !(item.type === 'property' && item.key in RELEASE_PROPERTIES));
  return [
    ...rest,
    ...Object.entries(RELEASE_PROPERTIES).map(([key, value]) => ({ type: 'property', key, value })),
  ];
}

function useOptimizedRules(buildGradle) {
  if (buildGradle.includes(OPTIMIZE_RULES) && !buildGradle.includes(DEFAULT_RULES)) return buildGradle;
  if (buildGradle.split(DEFAULT_RULES).length !== 2) {
    throw new Error('Android release shrinking: the template proguardFiles line changed.');
  }
  return buildGradle.replace(DEFAULT_RULES, OPTIMIZE_RULES);
}

function withAndroidReleaseShrinking(config) {
  const withProperties = withGradleProperties(config, (modConfig) => {
    modConfig.modResults = setReleaseProperties(modConfig.modResults);
    return modConfig;
  });
  return withAppBuildGradle(withProperties, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      throw new Error('Android release shrinking: expected a Groovy app/build.gradle.');
    }
    modConfig.modResults.contents = useOptimizedRules(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withAndroidReleaseShrinking;
module.exports.setReleaseProperties = setReleaseProperties;
module.exports.useOptimizedRules = useOptimizedRules;
