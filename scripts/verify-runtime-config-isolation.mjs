import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "vite";
import { forbiddenSupabaseRefsIn } from "./lib/sibling-deny-list.mjs";

const root = resolve(process.cwd());
const dist = join(root, "dist");
const mode = process.env.MODE || "production";
const loaded = loadEnv(mode, root, "");
const envValue = (name) => String(process.env[name] || loaded[name] || "").trim();

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const publicFiles = filesBelow(dist).filter((path) => statSync(path).isFile());
const deployedText = publicFiles
  .filter((path) => /\.(?:html|js|css|json|xml|webmanifest|txt)$/i.test(path))
  .map((path) => readFileSync(path, "utf8"));
const forbidden = new Map([
  ["VITE_SUPABASE_URL", envValue("VITE_SUPABASE_URL")],
  ["VITE_SUPABASE_PUBLISHABLE_KEY", envValue("VITE_SUPABASE_PUBLISHABLE_KEY")],
  ["VITE_SAMPLE_SUPABASE_URL", envValue("VITE_SAMPLE_SUPABASE_URL")],
  ["VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", envValue("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY")],
]);

for (const [label, value] of forbidden) {
  if (!value) continue;
  assert.equal(
    deployedText.some((text) => text.includes(value)),
    false,
    `public build contains host-specific ${label}`,
  );
}
// The sibling product's projects, listed by digest (config/sample-backend.json).
assert.deepEqual(deployedText.flatMap((text) => forbiddenSupabaseRefsIn(text)), [], "public build contains a forbidden production project ref");

const html = readFileSync(join(dist, "index.html"), "utf8");
const runtimeIndex = html.indexOf('src="/api/runtime-config"');
const applicationIndex = html.indexOf('type="module"');
assert.ok(runtimeIndex >= 0, "index.html must load /api/runtime-config");
assert.ok(applicationIndex >= 0, "index.html must load the application module");
const runtimeTag = html.slice(html.lastIndexOf("<script", runtimeIndex), html.indexOf(">", runtimeIndex) + 1);
assert.doesNotMatch(runtimeTag, /\b(?:async|defer)\b/, "runtime configuration must be a blocking script");
assert.ok(runtimeIndex < applicationIndex, "runtime configuration must load before the application module");

console.log(`Verified runtime configuration isolation across ${publicFiles.length} deployed files.`);
