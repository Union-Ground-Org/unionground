const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);
config.transformer.unstable_allowRequireContext = true;

// Native screens reuse platform-neutral feature engines and the encrypted
// document transport in src/lib. They never import the web JSX desks.
config.watchFolders = [...(config.watchFolders ?? []), path.join(workspaceRoot, 'src/features'), path.join(workspaceRoot, 'src/lib'), path.join(workspaceRoot, 'content/legal')];
const featuresRoot = path.join(workspaceRoot, 'src/features').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const webJsxFence = new RegExp(`^${featuresRoot}[\\\\/].*\\.jsx$`);
// Protocol fixtures deliberately bypass Auth. Never resolve them into an app
// bundle, even through a barrel, alias or accidental production import.
const testingRoot = path.join(projectRoot, 'src/testing').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const testHelperFence = new RegExp(`^${testingRoot}[\\\\/]`);
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : config.resolver.blockList ? [config.resolver.blockList] : []),
  webJsxFence,
  testHelperFence,
];

// A shared web-tree hook (src/features/civic/useLoad.js) imports `react`. From
// there, hierarchical lookup would find the web app's copy in the repository
// root, and two Reacts in one bundle break every hook. `react` and its
// subpaths always resolve from this app, whoever imports them.
// EAS and mobile CI need no root node_modules directory.
const appRuntimeDependency = /^react(?:\/.*)?$/;
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  if (appRuntimeDependency.test(moduleName) && !context.originModulePath.startsWith(projectRoot + path.sep)) {
    return resolve({ ...context, originModulePath: path.join(projectRoot, 'package.json') }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

// The product name is written into the bundle at build time
// (plugins/babel-brand-name.js), so a change of brand must not reuse
// transforms cached under another one.
config.cacheVersion = [config.cacheVersion, 'brand', process.env.BRAND_NAME ?? '', process.env.OFFICIAL_BRANDING ?? '', process.env.SOURCE_CODE_URL ?? ''].filter((part) => part !== undefined).join(':');

module.exports = config;
