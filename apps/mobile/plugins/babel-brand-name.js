// @brand-literal
// The phone app's build-time product name: the Metro counterpart of the web
// build's scripts/lib/brand-vite-plugin.mjs. Every string, template and JSX
// text in the app's own code that says "Union Ground" is written in the
// build's name, except the attribution notice ("Based on Union Ground") and
// the company ("Union Ground LLC"). An official build (OFFICIAL_BRANDING=1 and
// branding/official/ present) keeps the text as written.
//
// The rules are src/lib/shared-core/brand.js's. This file repeats the few it
// needs because Babel loads it as CommonJS inside Metro, which cannot import
// that ES module; apps/mobile/src/lib/brand.test.ts holds the two in step.
// app.config.ts has already refused a store build without a valid name of its
// own, so here an unusable name falls back to the development name.
const { existsSync, readFileSync } = require('node:fs');
const { join, sep } = require('node:path');

const UNION_GROUND_NAME = 'Union Ground';
const DEVELOPMENT_BRAND_NAME = 'Union workspace (development build)';
const BRAND_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&()\u2019-]{1,59}$/u;
const OFFICIAL_APP_ICON = join(__dirname, '../../../branding/official/mark-tile-1024.png');
const OFFICIAL_MARK_PNG = join(__dirname, '../../../branding/official/mark-tile-180.png');
const OFFICIAL_DOMAINS = join(__dirname, '../../../config/official-domains.json');
const DEFAULT_SOURCE_CODE_URL = 'https://github.com/Union-Ground-Org/unionground';
const BRAND_IDENTIFIER = '__UNIONGROUND_PHONE_BRAND__';

function brandKey(name) {
  return String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function phoneBrandName(env = process.env, officialAssetsPresent = existsSync(OFFICIAL_APP_ICON)) {
  if (String(env.OFFICIAL_BRANDING ?? '').trim() === '1' && officialAssetsPresent) return UNION_GROUND_NAME;
  const name = String(env.BRAND_NAME ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name || !BRAND_NAME_PATTERN.test(name) || brandKey(name).includes('unionground')) return DEVELOPMENT_BRAND_NAME;
  return name;
}

// The brand object src/lib/brand.ts reads: the name, whether this is an
// official build, the official service's hosts, and the official mark only in
// an official build, so an unbranded bundle carries no Union Ground artwork.
function phoneBrandInfo(env = process.env) {
  const name = phoneBrandName(env);
  const official = name === UNION_GROUND_NAME;
  const domains = JSON.parse(readFileSync(OFFICIAL_DOMAINS, 'utf8'));
  const source = String(env.SOURCE_CODE_URL ?? '').trim();
  return {
    name,
    official,
    sourceCodeUrl: /^https:\/\//.test(source) ? source : DEFAULT_SOURCE_CODE_URL,
    // Only an official build can show the official service mark, so only an
    // official bundle names the official service (scripts/verify-bundle-identity.mjs
    // refuses the LLC's hosts in any other).
    officialHosts: official ? domains.webHosts : [],
    officialSupabaseOrigins: official ? domains.supabaseOrigins : [],
    officialMarkUri: official ? `data:image/png;base64,${readFileSync(OFFICIAL_MARK_PNG).toString('base64')}` : null,
  };
}

const NAME_PATTERN = /Union Ground(?! LLC)/g;
const UPPERCASE_PATTERN = /UNION( |&nbsp;)GROUND(?! LLC)/g;
const ATTRIBUTION_LEAD = 'Based on ';

function applyBrandName(text, name) {
  if (typeof text !== 'string' || !name || name === UNION_GROUND_NAME) return text;
  const upper = name.toLocaleUpperCase();
  return text
    .replace(NAME_PATTERN, (match, offset, whole) => (
      whole.slice(Math.max(0, offset - ATTRIBUTION_LEAD.length), offset) === ATTRIBUTION_LEAD ? match : name
    ))
    .replace(UPPERCASE_PATTERN, (_, space) => (space === ' ' ? upper : upper.replaceAll(' ', '&nbsp;')));
}

function brandNamePlugin(api, options = {}) {
  const info = options.brandInfo ?? (options.brandName ? null : phoneBrandInfo());
  const name = options.brandName ?? info.name;
  const outside = (state) => String(state.filename ?? '').includes(`${sep}node_modules${sep}`);
  const skip = (state) => name === UNION_GROUND_NAME || outside(state)
    || String(state.file?.code ?? '').includes('@brand-literal');
  return {
    name: 'union-ground-brand-name',
    visitor: {
      ReferencedIdentifier(path, state) {
        if (path.node.name !== BRAND_IDENTIFIER || !info || outside(state)) return;
        path.replaceWith(api.types.valueToNode(info));
      },
      StringLiteral(path, state) {
        if (skip(state)) return;
        const next = applyBrandName(path.node.value, name);
        if (next === path.node.value) return;
        path.node.value = next;
        path.node.extra = undefined;
      },
      TemplateElement(path, state) {
        if (skip(state)) return;
        const raw = applyBrandName(path.node.value.raw, name);
        if (raw === path.node.value.raw) return;
        path.node.value = { raw, cooked: applyBrandName(path.node.value.cooked, name) };
      },
      JSXText(path, state) {
        if (skip(state)) return;
        const next = applyBrandName(path.node.value, name);
        if (next === path.node.value) return;
        path.node.value = next;
        path.node.extra = undefined;
      },
    },
  };
}

module.exports = brandNamePlugin;
module.exports.phoneBrandName = phoneBrandName;
module.exports.phoneBrandInfo = phoneBrandInfo;
module.exports.applyBrandName = applyBrandName;
module.exports.DEVELOPMENT_BRAND_NAME = DEVELOPMENT_BRAND_NAME;
