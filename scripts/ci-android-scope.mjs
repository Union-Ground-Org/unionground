import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Decides whether ci.yml's `android-native` lane runs for a change. The lane
// generates the Android project with Expo prebuild and compiles the debug app
// with Gradle and the NDK, a cold build the sibling repository measured at
// more than 45 minutes on this runner, so it runs only for inputs that can
// change what that build proves. The sibling selects it by the same kind of
// path list (scripts/classify-ci-worklist-change.mjs, isAndroidNative): the
// Expo configuration, the native manifests, assets, config plugins and local
// native modules. Added here: the two repository files app.config.ts reads,
// the manifest verifier the lane runs, this script, and the workflow that
// defines the lane, so a change to the lane proves the lane.
export function isAndroidNativeInput(path) {
  return /^apps\/mobile\/(?:app\.config\..*|app\.json|eas\.json|package(?:-lock)?\.json)$/.test(path)
    || path.startsWith("apps/mobile/assets/")
    || path.startsWith("apps/mobile/plugins/")
    || path.startsWith("apps/mobile/modules/")
    || path === "apps/mobile/scripts/verify-android-manifest-permissions.mjs"
    || path === "config/mobile-app-links.json"
    || path === "config/sample-backend.json"
    || path === "scripts/ci-android-scope.mjs"
    || path === ".github/workflows/ci.yml";
}

// `paths` is git's NUL-separated name list. No list at all (an unreadable
// base, a first push) selects the lane: when the answer is unknown, prove.
export function androidLaneSelected(paths) {
  if (paths === null) return true;
  return paths.split("\0").filter(Boolean).some(isAndroidNativeInput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pathsFile] = process.argv.slice(2);
  let paths = null;
  try {
    if (pathsFile) paths = readFileSync(pathsFile, "utf8");
  } catch {
    paths = null;
  }
  const selected = androidLaneSelected(paths);
  const line = `android_native=${selected}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}
