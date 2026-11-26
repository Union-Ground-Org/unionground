// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { androidLaneSelected, isAndroidNativeInput } from "../scripts/ci-android-scope.mjs";

// When ci.yml's android-native lane runs (docs/contracts/ci.md).

describe("Android native lane scope", () => {
  it("selects the lane for every input of the Expo prebuild and the Gradle build", () => {
    for (const path of [
      "apps/mobile/app.config.ts",
      "apps/mobile/app.json",
      "apps/mobile/eas.json",
      "apps/mobile/package.json",
      "apps/mobile/package-lock.json",
      "apps/mobile/assets/icon.png",
      "apps/mobile/plugins/with-local-notifications-only.js",
      "apps/mobile/modules/network-policy/android/build.gradle",
      "apps/mobile/modules/a-new-module/expo-module.config.json",
      // Read by app.config.ts.
      "config/mobile-app-links.json",
      "config/sample-backend.json",
      // The lane itself.
      "apps/mobile/scripts/verify-android-manifest-permissions.mjs",
      "scripts/ci-android-scope.mjs",
      ".github/workflows/ci.yml",
    ]) expect(isAndroidNativeInput(path), path).toBe(true);
  });

  it("leaves it out for changes the native build does not read", () => {
    for (const path of [
      "src/App.jsx",
      "package.json",
      "package-lock.json",
      "apps/mobile/src/services/notifications.ts",
      "apps/mobile/app/(tabs)/index.tsx",
      "apps/mobile/scripts/contrast-audit.mjs",
      "apps/mobile/README.md",
      "apps/mobile/assets-old.png",
      "supabase/migrations/20261018060200_example.sql",
      "tests/ci-android-scope.test.js",
      ".github/workflows/coverage-weekly.yml",
    ]) expect(isAndroidNativeInput(path), path).toBe(false);
  });

  it("reads git's NUL-separated list and selects the lane when there is none", () => {
    expect(androidLaneSelected("src/App.jsx\0README.md\0")).toBe(false);
    expect(androidLaneSelected("src/App.jsx\0apps/mobile/plugins/x.js\0")).toBe(true);
    expect(androidLaneSelected("")).toBe(false);
    expect(androidLaneSelected(null)).toBe(true);
  });

  it("writes the answer as a step output, and selects the lane for an unreadable list", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-android-scope-"));
    try {
      const output = join(root, "output");
      const run = (...args) => {
        writeFileSync(output, "");
        const result = spawnSync(process.execPath, ["scripts/ci-android-scope.mjs", ...args], {
          encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
        });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, "utf8");
      };
      const paths = join(root, "paths");
      writeFileSync(paths, "src/App.jsx\0");
      expect(run(paths)).toBe("android_native=false\n");
      writeFileSync(paths, "apps/mobile/app.config.ts\0");
      expect(run(paths)).toBe("android_native=true\n");
      expect(run(join(root, "missing"))).toBe("android_native=true\n");
      expect(run()).toBe("android_native=true\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
