import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenAppHostsIn, forbiddenIdentityTokensIn, forbiddenSupabaseRefsIn } from '../../../scripts/lib/sibling-deny-list.mjs';
import { hasRetiredProjectName } from '../../../scripts/lib/retired-project-names.mjs';

// The exported JS bundle is what ships. The official Union Ground app keeps
// identifiers of its own, so this scans the export for its application id
// namespace and native scheme, the project's former name, plus every Supabase
// project, application host and account identifier on the one maintained deny
// list (config/sample-backend.json, kept as digests; a host matches as itself
// or a subdomain, so the app's own org.unionground.app ids do not, and
// everything there also matches in any case and percent-encoded). The native
// app ships no deny list: app.config.ts reads it at build time and the export
// carries none of it.
/** @type {readonly string[]} */
const FORBIDDEN = ['net.unionground', 'unionbase://'];
// Only Union Ground LLC's official build (OFFICIAL_BRANDING=1 with
// branding/official/) names its own service's hosts, for the official service
// mark (plugins/babel-brand-name.js); every other export must name none.
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const officialBuild = String(process.env['OFFICIAL_BRANDING'] ?? '').trim() === '1'
  && statSync(join(repositoryRoot, 'branding/official/mark-tile-1024.png'), { throwIfNoEntry: false }) !== undefined;
/** @type {string[]} */
const allowedHosts = officialBuild
  ? /** @type {{ webHosts: string[] }} */ (JSON.parse(readFileSync(join(repositoryRoot, 'config/official-domains.json'), 'utf8'))).webHosts
  : [];

/** @type {string | undefined} */
const bundleDirectory = process.argv[process.argv.indexOf('--bundle-dir') + 1];
if (!bundleDirectory || process.argv.indexOf('--bundle-dir') < 0) throw new Error('Pass --bundle-dir <export directory>.');

/**
 * @param {string} directory
 * @returns {string[]}
 */
function files(directory) {
  return readdirSync(directory).flatMap((/** @type {string} */ name) => {
    /** @type {string} */
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|hbc|json|map)$/.test(name) ? [path] : [];
  });
}

const scanned = files(bundleDirectory);
if (scanned.length === 0) throw new Error(`No bundle files under ${bundleDirectory}.`);
/** @type {string[]} */
const hits = [];
for (const path of scanned) {
  const bytes = readFileSync(path);
  /** @type {string} */
  const text = bytes.toString('latin1');
  /** @type {string} */
  const unicode = bytes.toString('utf8');
  for (const value of FORBIDDEN) if (text.includes(value)) hits.push(`${path}: ${value}`);
  if (hasRetiredProjectName(text)) hits.push(`${path}: retired project name`);
  for (const ref of forbiddenSupabaseRefsIn(unicode)) hits.push(`${path}: ${ref} (Supabase project)`);
  for (const host of forbiddenAppHostsIn(unicode)) {
    if (!allowedHosts.includes(host)) hits.push(`${path}: ${host} (application host)`);
  }
  for (const token of forbiddenIdentityTokensIn(unicode)) hits.push(`${path}: ${token} (account or host identifier)`);
}
if (hits.length > 0) {
  console.error('FAIL: the exported bundle names the official app\'s identifiers or a retired name:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${scanned.length} bundle files carry no official-app identifier or retired name.`);
}
