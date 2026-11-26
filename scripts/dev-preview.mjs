import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Clean-clone onboarding has no SAMPLE keys. VITE_APP_SURFACE=demo alone
// selects the SAMPLE surface, but MemberApp only boots fixtures when
// isTestHarness() is true; otherwise requiresBackendConfig() shows the
// configuration-error screen. VITE_VISUAL_AUDIT is the local fixture
// seam that does not open Playwright-only window hooks.
export const PREVIEW_DEMO_ENV = Object.freeze({
  VITE_APP_SURFACE: "demo",
  VITE_VISUAL_AUDIT: "1",
});

export function previewDemoChildEnv(baseEnv = process.env) {
  return { ...baseEnv, ...PREVIEW_DEMO_ENV };
}

export function resolveViteCli(requireImpl = createRequire(import.meta.url)) {
  // Vite 7 exports `./package.json` but not `./bin/vite.js`. Resolving the
  // unexported bin specifier throws ERR_PACKAGE_PATH_NOT_EXPORTED and the
  // documented `npm run dev:preview` never starts.
  const packageJsonPath = requireImpl.resolve("vite/package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vite;
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error("Installed vite package.json does not declare a vite bin");
  }
  return join(dirname(packageJsonPath), bin);
}

export function runDevPreview({
  spawnImpl = spawn,
  nodePath = process.execPath,
  env = process.env,
  forwardedArgs = process.argv.slice(2),
  viteCli = resolveViteCli(),
  stdio = "inherit",
} = {}) {
  return spawnImpl(nodePath, [viteCli, ...forwardedArgs, "--mode", "test"], {
    stdio,
    env: previewDemoChildEnv(env),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = runDevPreview();
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}
