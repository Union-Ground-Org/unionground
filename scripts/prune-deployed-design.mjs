import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The design package under public/design is a JSX-in-the-browser prototype
 * runtime: its pages transpile with Babel standalone, which needs
 * script-src 'unsafe-eval'. Vercel serves public/ from the SAME origin as the
 * authenticated application, so an injection into that runtime would run
 * beside persisted Supabase member sessions in the same localStorage.
 *
 * SEC-UG-DESIGN-EVAL-ORIGIN-20260817: the prototype stays in the
 * repository — `vite dev` serves public/ untouched, so the local design
 * handoff workflow is unaffected — but the built artifact that reaches a
 * deployed authenticated origin carries only the assets below.
 *
 * email-logo.png is not a design runtime. It is the 30x30 mark that
 * api/_lib/emailTemplate.js references as an absolute https URL, because an
 * email <img src> resolves against the recipient's mail client and cannot use
 * a relative path. Removing it would break the logo in every transactional
 * email already delivered.
 */
export const DEPLOYED_DESIGN_ASSETS = Object.freeze(["email-logo.png"]);

/** True when a path relative to dist/design may reach a deployed origin. */
export function isDeployedDesignAsset(relativePath) {
  return DEPLOYED_DESIGN_ASSETS.includes(relativePath.split(sep).join("/"));
}

function walk(dir, root, found = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new Error(`Refusing to prune a symbolic link: ${full}`);
    if (info.isDirectory()) walk(full, root, found);
    else found.push(relative(root, full));
  }
  return found;
}

/**
 * Delete every built /design path that is not an approved deployed asset.
 * Returns the relative paths removed, so the caller can report them.
 */
export function pruneDeployedDesign(distRoot) {
  const buildRoot = resolve(distRoot);
  const designRoot = join(buildRoot, "design");
  let buildInfo;
  try {
    buildInfo = lstatSync(buildRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!buildInfo.isDirectory()) {
    throw new Error("Refusing to prune a symbolic link or non-directory build/design root");
  }
  let designInfo;
  try {
    designInfo = lstatSync(designRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!designInfo.isDirectory()) {
    throw new Error("Refusing to prune a symbolic link or non-directory build/design root");
  }
  let top;
  try {
    top = readdirSync(designRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  // Validate the whole tree before deleting anything, including allowed names.
  walk(designRoot, designRoot);
  const removed = [];
  for (const name of top) {
    if (isDeployedDesignAsset(name)) continue;
    const full = join(designRoot, name);
    const paths = lstatSync(full).isDirectory() ? walk(full, designRoot) : [name];
    rmSync(full, { recursive: true, force: true });
    removed.push(...paths);
  }

  const unexpected = walk(designRoot, designRoot).filter((entry) => !isDeployedDesignAsset(entry));
  if (unexpected.length > 0) {
    throw new Error(`dist/design still serves unapproved design files: ${unexpected.join(", ")}`);
  }
  return removed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const removed = pruneDeployedDesign(resolve(process.cwd(), "dist"));
  console.log(`Pruned ${removed.length} unsafe-eval design runtime files from the deployed artifact.`);
}
