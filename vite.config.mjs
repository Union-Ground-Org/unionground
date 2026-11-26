import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv, minifySync, transformWithOxc } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { assertExactBuildSha } from "./scripts/lib/build-provenance.mjs";
import { loadViteRuntimeEnv } from "./scripts/lib/vite-runtime-env.mjs";
import { runnerTimeout } from "./scripts/lib/runner-timeout.mjs";
import { publicRouteMetadataPlugin } from "./scripts/public-route-metadata.mjs";
import { memberShellPreloadPlugin } from "./scripts/member-shell-build.mjs";
import { appCodeSplitting, catalogueChunkGuardPlugin } from "./scripts/lib/app-chunks.mjs";
import { legalPendingManifestPlugin } from "./scripts/lib/legal-pending-manifest.mjs";
import { runtimeConfigForRequest, serializeRuntimeConfig } from "./api/_lib/runtimeConfig.js";
import { withOperator } from "./api/_lib/operator.js";
import { validateBrowserEnvironmentKeys, validateBrowserProviderEnvironment } from "./src/lib/providerContract.js";
import { brandPlugin, resolveWebBrand } from "./scripts/lib/brand-vite-plugin.mjs";

// The stylesheet transform only runs in builds and the dev server. Keeping
// it in Vitest's config dependency graph turns every splitter change into a
// whole-suite related run. A URL import keeps the build-only module outside
// the bundled test config while production still loads the same plugin.
// Load the factory in both modes: callers may evaluate this cached config
// again after switching from test to build mode.
const { routeStylesPlugin } = await import(new URL("./scripts/lib/route-styles.mjs", import.meta.url).href);
const { criticalFullStylesPlugin } = await import(new URL("./scripts/lib/critical-full-styles.mjs", import.meta.url).href);

function localCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Keep the deployed SHA as an explicit build input: Vercel's authenticated
// Production event and the browser-proof lane both bind to this exact marker.
const commitSha = assertExactBuildSha(process.env.VERCEL_GIT_COMMIT_SHA || localCommit());
const htmlBuildShaPlaceholder = "__UNION_GROUND_BUILD_SHA__";

// Vitest workers (threads and forks) take their local zone from this process,
// and CI runs in UTC. Pin it here, before any worker starts, so a fixed-instant
// date assertion does not flip a day on a host in Pacific/Kiritimati or
// America/Los_Angeles. VITEST_KEEP_TZ=1 keeps the host TZ for a deliberate
// other-zone run.
if (process.env.VITEST && !process.env.VITEST_KEEP_TZ) process.env.TZ = "UTC";
// The suite runs as the official build (branding/official/), so the copy
// tests read the product's real text. The unbranded default, its development
// fallback and the production refusals are pinned in tests/brand*.test.js.
// Set here, before any worker starts, so the server functions under test
// (api/_lib/brand.js) see the same brand as the bundle.
if (process.env.VITEST) {
  process.env.VITE_BRAND_NAME = "";
  process.env.VITE_OFFICIAL_BRANDING = "1";
}
const sentryBuildEnabled = Boolean(
  process.env.SENTRY_AUTH_TOKEN
  && process.env.SENTRY_ORG
  && process.env.SENTRY_PROJECT,
);

function runtimeConfigMiddleware(env) {
  return (request, response, next) => {
    if (request.url?.split("?", 1)[0] !== "/api/runtime-config") return next();
    response.statusCode = 200;
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("Content-Type", "application/javascript; charset=utf-8");
    response.setHeader("Vary", "Host");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") return response.end();
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      return response.end();
    }
    return response.end(serializeRuntimeConfig(withOperator(runtimeConfigForRequest(request, env), env)));
  };
}

function runtimeConfigPlugin(mode) {
  const runtimeEnv = loadViteRuntimeEnv(mode, process.cwd());
  return {
    name: "runtime-backend-config-local",
    configureServer(server) {
      server.middlewares.use(runtimeConfigMiddleware(runtimeEnv));
    },
    configurePreviewServer(server) {
      server.middlewares.use(runtimeConfigMiddleware(runtimeEnv));
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // Union Ground provider boundary: a build that names a sibling product's
  // Supabase project or host fails here, before anything is bundled.
  const loadedEnv = loadEnv(mode, process.cwd(), "VITE_");
  const browserEnv = {
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? loadedEnv.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? loadedEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_UNIONGROUND_SUPABASE_REF: process.env.VITE_UNIONGROUND_SUPABASE_REF ?? loadedEnv.VITE_UNIONGROUND_SUPABASE_REF,
  };
  validateBrowserProviderEnvironment(browserEnv, { allowLocal: mode !== "production" });
  // No server-only Supabase key may ride in under any VITE_ name.
  validateBrowserEnvironmentKeys({
    ...loadedEnv,
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("VITE_"))),
  });
  // The product's own name and mark (scripts/lib/brand-vite-plugin.mjs): a
  // production build with no VITE_BRAND_NAME, or with the Union Ground name
  // and no official branding, stops here with a message for the operator.
  const brand = resolveWebBrand({
    env: {
      ...loadedEnv,
      ...loadEnv(mode, process.cwd(), "SOURCE_CODE_URL"),
      NODE_ENV: process.env.NODE_ENV,
    },
    mode,
    command,
    root: process.cwd(),
  });
  if (brand.warning) console.warn(`[brand] ${brand.warning}`);

  return {
  // Root consumer tests import native TypeScript without installing Expo.
  // An inline tsconfig keeps Oxc from resolving the native package's tsconfig,
  // which extends expo/tsconfig.base. Vite 8 converts only esbuild's jsx and
  // define options to Oxc and drops esbuild.tsconfigRaw, so this must be oxc.
  oxc: process.env.VITEST ? {
    tsconfig: { compilerOptions: { jsx: "react-jsx", useDefineForClassFields: true } },
  } : undefined,
  resolve: process.env.VITEST ? { dedupe: ["react", "react-dom", "@supabase/supabase-js"] } : undefined,
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    // No `host`/`allowedHosts` here on purpose. Binding 0.0.0.0 by default
    // published the unauthenticated dev server, the HMR socket, and the raw
    // module graph to every device on whatever network the developer was
    // attached to, and the allowlist named one contributor's mDNS hostname,
    // which meant nothing on any other machine. LAN exposure is now opt-in
    // per session: `npm run dev -- --host`.
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [
    loadedEnv.VITE_SENTRY_DSN === undefined && {
      name: "unconfigured-sentry-dead-code",
      apply: "build",
      enforce: "pre",
      async transform(source, id) {
        if (!id.endsWith("/src/lib/observability.js")) return;
        // Fold the absent DSN before browser-target lowering introduces
        // optional-chain temporaries that Rolldown cannot eliminate. This
        // preserves the telemetry source/disclosure pins; configured builds
        // and development bypass it entirely. Keep maps for error reporting.
        const transformed = await transformWithOxc(source, id, {
          define: { "import.meta.env.VITE_SENTRY_DSN": "undefined" },
          sourcemap: true,
        });
        return minifySync(id, transformed.code, {
          mangle: false, sourcemap: true, inputMap: transformed.map,
        });
      },
    },
    legalPendingManifestPlugin(),
    // Tests read src/styles.css whole; builds and the dev server split it
    // into a critical sheet and per-route sheets (scripts/lib/route-styles.mjs).
    !process.env.VITEST && routeStylesPlugin(),
    !process.env.VITEST && catalogueChunkGuardPlugin(),
    mode === 'test' && (process.env.VITE_E2E_HARNESS === '1' || process.env.VITE_VISUAL_AUDIT === '1') && {
      name: 'isolated-assurance-fixtures',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.') || importer.includes('/tests/fixtures/')) return;
        const path = resolve(dirname(importer), source);
        const retired = [
          'src/lib/demoVoiceParity.js', 'src/lib/demoCampaigns.js',
          'src/features/analytics/preview.js', 'src/features/connectionSuggestions/preview.js',
          'src/features/organizationIntelligence/preview.js', 'src/features/learningContent/preview.js',
        ].find((entry) => resolve(entry) === path);
        if (retired) return resolve('tests/fixtures/retired-pre-bot', retired);
      },
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace('src="/src/main.jsx"', 'src="/e2e/assurance-entry.jsx"');
        },
      },
    },
    process.env.VITEST && {
      name: "root-native-test-imports",
      enforce: "pre",
      resolveId(id) {
        // These platform boundaries must be explicitly mocked by root tests.
        if (["@expo/vector-icons", "@react-native-masked-view/masked-view", "expo-blur", "expo-crypto", "expo-linear-gradient", "expo-router", "react-native", "react-native-safe-area-context", "react-native-screens/experimental", "react-native-svg", "react-native-url-polyfill/auto"].includes(id)) return id;
      },
    },
    brandPlugin(brand, { root: process.cwd() }),
    react(),
    runtimeConfigPlugin(mode),
    {
      name: "build-sha-document-marker",
      transformIndexHtml(html) {
        if (html.split(htmlBuildShaPlaceholder).length !== 2) {
          throw new Error("Document build marker placeholder must occur exactly once");
        }
        return html.replace(htmlBuildShaPlaceholder, commitSha);
      },
    },
    publicRouteMetadataPlugin(),
    !process.env.VITEST && memberShellPreloadPlugin(),
    !process.env.VITEST && criticalFullStylesPlugin(),
    {
      name: "build-info",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: JSON.stringify({ commitSha, builtAt: new Date().toISOString() }),
        });
      },
    },
    sentryBuildEnabled && sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      telemetry: false,
      // The app passes the release itself (src/lib/observability.js reads the
      // document marker). The plugin's own injection would write the sha into
      // the entry chunk and rename every chunk that imports it at each deploy
      release: { name: commitSha, inject: false },
      sourcemaps: { filesToDeleteAfterUpload: "./dist/**/*.map" },
    }),
  ].filter(Boolean),
  build: {
    sourcemap: sentryBuildEnabled ? "hidden" : false,
    // Pin the browser floor the app has shipped with since vite 6. Vite 7+
    // defaults to 'baseline-widely-available', which silently raises the iOS
    // floor from Safari 14 to 16+ — a support-policy decision, not one a
    // dependency bump gets to make for a members' PWA. Change deliberately.
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
    rolldownOptions: {
      output: {
        // Vendor chunks and the string catalogue chunk: scripts/lib/app-chunks.mjs.
        codeSplitting: appCodeSplitting,
      },
    },
  },
  test: {
    environment: "jsdom",
    // Tests pin the shell default so the production swap (VITE_UG_DEFAULT_SHELL,
    //) never changes what the suite
    // renders; a test that wants the alternate shell passes ?shell=alt. Set
    // UG_TEST_DEFAULT_SHELL=alt to run the whole suite against the other default.
    env: { VITE_UG_DEFAULT_SHELL: process.env.UG_TEST_DEFAULT_SHELL ?? "classic" },
    setupFiles: ["./tests/setup.js"],
    // Declare the test surface explicitly. Vitest's default globs sweep the
    // whole tree, so any vendored or archived sub-tree added later would be
    // pulled into this jsdom suite and gate deploys through `npm run check`.
    include: ["tests/**/*.test.{js,jsx,mjs}"],
    pool: "threads",
    // One Chromium launch per CI run before the browser suites need it.
    globalSetup: ["./tests/helpers/warm-chromium.js"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,jsx}", "workers/**/*.{js,ts}", "api/**/*.js"],
      exclude: ["src/main.jsx", "**/tests/fixtures/**", "**/*.d.ts"],
      reporter: ["text", "json", "json-summary", "lcov"],
      reportsDirectory: "coverage",
    },
    // Belongs here, not only in the `npm test` script: a bare `npx vitest run`
    // otherwise over-parallelizes across the suite and manufactures 5s timeouts
    // in files that are not actually slow.
    // 2026-09-22: eight workers on the 8-vCPU runner starved React's macrotask
    // renders in the jsdom App suites (Compass retained-answer race, More-hub
    // heading misses, 10 s timeouts in six files); four workers leave headroom
    // for jsdom, GC and the assurance sidecars while still halving the 2-vCPU time.
    // The 6-GiB self-hosted coverage slots need a single worker to leave
    // room for the parent process to collect and serialize V8 coverage.
    maxWorkers: process.env.CI_ASSURANCE_WORKERS === "1" ? 1 : process.env.CI_ASSURANCE_WORKERS === "8" ? 4 : 2,
    minWorkers: 1,
    // The approved 2-vCPU runner can briefly contend while multiple lazy App
    // integration tests transform and mount. Keep hangs bounded, but do not
    // mistake ordinary scheduling headroom for a product failure. On the
    // hosted 8-worker Root check (2026-09-22) the 10 s budget manufactured
    // "Test timed out" failures in six unrelated files across consecutive
    // Main pushes while every one of them passed locally, so CI gets a wider
    // budget; local runs keep the tight one so real hangs still surface.
    // Both budgets are tripled on GitHub's standard 2-vCPU runner
    // (scripts/lib/runner-timeout.mjs); hookTimeout keeps Vitest's 10 s default
    // everywhere else.
    testTimeout: runnerTimeout(process.env.CI ? 30_000 : 10_000),
    hookTimeout: runnerTimeout(10_000),
    // Sibling session worktrees live under .worktrees/; without this a main-
    // tree `npm run check` sweeps every worktree's copy of the suite and
    // reports their in-flight failures as ours. CI never sees the difference
    // (a fresh clone has no .worktrees/), so this only makes the local gate
    // honest. Claude Code agent worktrees live under .claude/worktrees/ and
    // need their own pattern — vitest 4 globs dot-directories, so the
    // .worktrees rule alone does not cover them.
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      // The Expo client is a separate package with its own dependency tree,
      // Vitest config, and CI job. Letting the root runner discover these
      // tests makes a root-only `npm ci` try to resolve Expo's tsconfig.
      "apps/mobile/**",
      "**/.worktrees/**",
      "**/.claude/worktrees/**",
    ],
  },
  };
});
