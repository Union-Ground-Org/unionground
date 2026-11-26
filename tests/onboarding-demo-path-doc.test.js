// @vitest-environment node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requiresBackendConfig } from "../src/lib/appMode.js";
import { isTestHarness, resolveAppSurface } from "../src/lib/demoOrigin.js";
import { PREVIEW_DEMO_ENV, resolveViteCli, runDevPreview } from "../scripts/dev-preview.mjs";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

const PREVIEW_COMMAND = "npm run dev:preview";
const PREVIEW_INVOCATION = /\bnpm run dev:preview\b/;
const POSIX_ENV_PREFIX = /^[A-Z_][A-Z0-9_]*=\S+\s+npm run /;
const LOCAL_PREVIEW_URL = /https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/[^\s)`'"]*)?/;
const HARNESS_CAVEAT = /\?demo=1`? alone only works under the project's own e2e\/visual-audit test harness(?:,|\s+\([^)]*\),)? not an ordinary (?:dev server|`npm run dev`)/;

function firstCopyPastePreviewCommand(source) {
  const fences = [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  for (const body of fences) {
    const line = body.split("\n").find((candidate) => (
      PREVIEW_INVOCATION.test(candidate) && !/supabase/.test(candidate)
    ));
    if (!line) continue;
    return line.trim().replace(/^`+|`+$/g, "");
  }
  return null;
}

function documentedOnboardingPath(source, label) {
  const command = firstCopyPastePreviewCommand(source);
  expect(command, `${label} must document a copy-paste ${PREVIEW_COMMAND} start command`).toBe(
    PREVIEW_COMMAND,
  );
  expect(POSIX_ENV_PREFIX.test(command), `${label} start command must be Windows Command Prompt safe`).toBe(false);
  const urlMatch = source.match(LOCAL_PREVIEW_URL);
  expect(urlMatch, `${label} must document a 127.0.0.1 preview URL`).toBeTruthy();
  const url = new URL(urlMatch[0]);
  return {
    command,
    env: PREVIEW_DEMO_ENV,
    href: url.href,
    search: url.search,
  };
}

function fixtureDemoActive(env, search) {
  const demo = resolveAppSurface({
    hostname: "127.0.0.1",
    search,
    env,
  }) === "demo";
  return demo && isTestHarness(env);
}

describe("onboarding demo path documentation", () => {
  it("binds npm run dev:preview to the fixture-enabling launcher", () => {
    expect(pkg.scripts["dev:preview"]).toBe("node scripts/dev-preview.mjs");
    expect(PREVIEW_DEMO_ENV).toEqual({
      VITE_APP_SURFACE: "demo",
      VITE_VISUAL_AUDIT: "1",
    });
  });

  it("resolves the Vite CLI from the exported package.json path", () => {
    const real = createRequire(new URL("../scripts/dev-preview.mjs", import.meta.url));
    expect(() => real.resolve("vite/bin/vite.js")).toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath '\.\/bin\/vite\.js'/,
    );
    const requireImpl = {
      resolve(specifier) {
        if (specifier === "vite/bin/vite.js") {
          const error = new Error("Package subpath './bin/vite.js' is not defined by \"exports\"");
          error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
          throw error;
        }
        return real.resolve(specifier);
      },
    };
    const cli = resolveViteCli(requireImpl);
    expect(realpathSync(cli)).toBe(realpathSync(resolve(process.cwd(), "node_modules/vite/bin/vite.js")));
    expect(existsSync(cli)).toBe(true);
    expect(resolveViteCli()).toBe(cli);
  });

  it("starts Vite with the preview env instead of a POSIX prefix", () => {
    const spawned = [];
    runDevPreview({
      spawnImpl: (...args) => {
        spawned.push(args);
        return { on() {} };
      },
      nodePath: "/usr/bin/node",
      viteCli: "/tmp/vite.js",
      forwardedArgs: [],
      env: { PATH: "/usr/bin" },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0][0]).toBe("/usr/bin/node");
    expect(spawned[0][1]).toEqual(["/tmp/vite.js", "--mode", "test"]);
    expect(spawned[0][2].env).toMatchObject(PREVIEW_DEMO_ENV);
  });

  it.each([
    ["README.md", readme],
  ])("documented %s start command opens SAMPLE fixtures on 127.0.0.1", (label, source) => {
    const path = documentedOnboardingPath(source, label);
    const demoActive = fixtureDemoActive(path.env, path.search);
    expect(resolveAppSurface({
      hostname: "127.0.0.1",
      search: path.search,
      env: path.env,
    }), `${label} command ${JSON.stringify(path.command)} at ${path.href}`).toBe("demo");
    expect(isTestHarness(path.env), `${label} must enable the fixture harness`).toBe(true);
    expect(demoActive, `${label} must boot fixtures without SAMPLE keys`).toBe(true);
    expect(requiresBackendConfig({
      hasConfig: false,
      testPreview: false,
      demoActive,
    }), `${label} must clear the configuration-error gate`).toBe(false);
  });

  it.each([
    ["README.md", readme],
  ])("the same %s URL stays SaaS with an empty env", (label, source) => {
    const path = documentedOnboardingPath(source, label);
    expect(resolveAppSurface({
      hostname: "127.0.0.1",
      search: path.search,
      env: {},
    }), `${label} ${path.href} without documented env`).toBe("saas");
    expect(requiresBackendConfig({
      hasConfig: false,
      testPreview: false,
      demoActive: fixtureDemoActive({}, path.search),
    })).toBe(true);
  });

  it("VITE_APP_SURFACE=demo alone still fails closed without keys or a harness", () => {
    const env = { VITE_APP_SURFACE: "demo" };
    expect(resolveAppSurface({ hostname: "127.0.0.1", search: "", env })).toBe("demo");
    expect(isTestHarness(env)).toBe(false);
    expect(requiresBackendConfig({
      hasConfig: false,
      testPreview: false,
      demoActive: fixtureDemoActive(env, ""),
    })).toBe(true);
  });

  it.each([
    ["README.md", readme],
  ])("%s states that ?demo=1 alone is harness-only", (_label, source) => {
    expect(HARNESS_CAVEAT.test(source.replace(/\s+/g, " "))).toBe(true);
  });
});
