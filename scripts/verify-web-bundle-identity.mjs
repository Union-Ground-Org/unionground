import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { forbiddenAppHostsIn, forbiddenIdentityTokensIn, forbiddenSupabaseRefsIn } from "./lib/sibling-deny-list.mjs";
import { hasRetiredProjectName } from "./lib/retired-project-names.mjs";
import { officialAssetsPresent, officialWebHosts } from "./lib/brand-vite-plugin.mjs";

// The built web bundle is what ships. Union Ground is the open-source edition
// of a product whose official hosted service and apps keep identifiers of
// their own, so this scans dist/ for those: hosts, mailboxes, application ids,
// native scheme, OAuth client, AI-mesh hosts and Supabase projects (the same
// list apps/mobile scans its native export for, plus the web-only targets).
// It runs after `vite build` in `npm run check`. The Supabase projects,
// application hosts, account identifiers and AI-mesh hosts come from the one
// maintained deny list (config/sample-backend.json), which keeps them as
// digests so this repository does not spell them out; the application hosts
// match as the host or a subdomain, and everything there also matches in any
// case and percent-encoded, as a URL parser would read it
// (scripts/lib/sibling-deny-list.mjs). The literals below are names only:
// the official app's id namespace and native scheme, the retired "Union Base"
// design name, and the project's former name, which must not come back.
/** @type {readonly string[]} */
export const FORBIDDEN = Object.freeze([
  "net.unionground",
  "unionbase://",
  "Union Base",
]);

/**
 * @param {string} directory
 * @returns {string[]}
 */
function files(directory) {
  return readdirSync(directory).flatMap((/** @type {string} */ name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? files(path)
      : /\.(js|mjs|css|html|json|map|txt|xml|webmanifest|svg)$/.test(name) ? [path] : [];
  });
}

/**
 * @param {string} root
 * @param {{ allowedHosts?: readonly string[] }} [options] exact hosts an
 *   official Union Ground build may name (config/official-domains.json)
 * @returns {{ scanned: number, hits: string[] }}
 */
export function scanWebBundle(root, { allowedHosts = [] } = {}) {
  const scanned = files(root);
  /** @type {string[]} */
  const hits = [];
  for (const path of scanned) {
    const bytes = readFileSync(path);
    const text = bytes.toString("latin1");
    const unicode = bytes.toString("utf8");
    for (const value of FORBIDDEN) if (text.includes(value)) hits.push(`${path}: ${value}`);
    if (hasRetiredProjectName(text)) hits.push(`${path}: retired project name`);
    for (const ref of forbiddenSupabaseRefsIn(unicode)) hits.push(`${path}: ${ref} (Supabase project)`);
    for (const host of forbiddenAppHostsIn(unicode)) {
      if (!allowedHosts.includes(host)) hits.push(`${path}: ${host} (application host)`);
    }
    for (const token of forbiddenIdentityTokensIn(unicode)) hits.push(`${path}: ${token} (account or host identifier)`);
  }
  return { scanned: scanned.length, hits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf("--dist-dir");
  const root = flag >= 0 ? process.argv[flag + 1] : "dist";
  // Only Union Ground LLC's official build (VITE_OFFICIAL_BRANDING=1 with
  // branding/official/) carries its own service's hosts, for the official
  // service mark (scripts/lib/brand-vite-plugin.mjs); every other build must
  // name none of them.
  const official = String(process.env.VITE_OFFICIAL_BRANDING || "").trim() === "1" && officialAssetsPresent(process.cwd());
  const { scanned, hits } = scanWebBundle(root, { allowedHosts: official ? officialWebHosts(process.cwd()) : [] });
  if (scanned === 0) throw new Error(`No bundle files under ${root}.`);
  if (hits.length > 0) {
    console.error("FAIL: the built web bundle names the official app's identifiers or a retired name:");
    for (const hit of hits) console.error(`  ${hit}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${scanned} web bundle files carry no official-app identifier or retired name.`);
  }
}
