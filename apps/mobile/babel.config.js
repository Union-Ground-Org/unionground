// Expo's default Babel setup plus the build-time product name
// (plugins/babel-brand-name.js): BRAND_NAME, or Union Ground with
// OFFICIAL_BRANDING=1 in Union Ground LLC's own builds, and SOURCE_CODE_URL.
// Babel's cache follows the three variables; metro.config.js keys Metro's cache on them too.
module.exports = function babelConfig(api) {
  api.cache.using(() => `${process.env.BRAND_NAME ?? ''}|${process.env.OFFICIAL_BRANDING ?? ''}|${process.env.SOURCE_CODE_URL ?? ''}`);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['./plugins/babel-brand-name.js'],
  };
};
