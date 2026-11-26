// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { blockingAdvisories, introducedAdvisories } from "../scripts/ci-dependency-audit.mjs";

// The required gate's shape (docs/contracts/ci.md): parallel lanes, and one
// aggregate job named exactly `check`, the status context the main ruleset
// requires. These pins keep the split from silently dropping work that
// `npm run check` and the old single job used to run.

const ciSource = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const ci = parse(ciSource);
const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const daily = workflow("dependency-audit-daily.yml");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const LANES = ["conventions-and-lint", "web-tests", "contrast-and-build", "mobile", "security", "dependency-audit", "db", "android-native"];
// db-scope decides whether the db and android-native lanes run; `check` needs it too.
const NEEDED = [...LANES, "db-scope"];
const runs = (job) => (job.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("ci.yml lanes", () => {
  it("runs on pull requests and on pushes to main only", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    expect(ci.on.pull_request).toBeNull();
    expect(ci.on.push).toEqual({ branches: ["main"] });
    // Removed for the trusted-workflow ruleset (pull requests run main's copy).
    expect(ci.concurrency).toBeUndefined();
  });

  it("reads the repository and nothing else, with no secret and no database URL", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    // The db job also lists main's snapshot producer runs and downloads one.
    const extra = { db: { contents: "read", actions: "read" }, check: { contents: "read" } };
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.permissions, id).toEqual(extra[id]);
    }
    expect(ciSource).not.toMatch(/secrets\.|SUPABASE_DB_URL|DATABASE_URL|supabase\.co/);
  });

  it("has exactly the eight lanes, the scope job and the aggregate", () => {
    expect(Object.keys(ci.jobs).sort()).toEqual([...NEEDED, "check"].sort());
  });

  it("names the aggregate exactly `check`, needs every lane and fails unless each succeeded", () => {
    const check = ci.jobs.check;
    expect(check.name).toBe("check");
    expect([...check.needs].sort()).toEqual([...NEEDED].sort());
    expect(check.if).toBe("always()");
    const step = check.steps.find((entry) => entry.name === "Require every lane to succeed");
    expect(step.env.NEEDS).toBe("${{ toJSON(needs) }}");
    const rule = step.run.replace(/\s+/g, " ");
    expect(rule).toContain(`length == ${NEEDED.length}`);
    // Every job but db and android-native must succeed; each of those two may
    // be skipped only when db-scope succeeded and did not select it.
    expect(rule).toContain('all(to_entries[] | select(.key != "db" and .key != "android-native"); .value.result == "success")');
    expect(rule).toContain('(.db.result == "success" or (.db.result == "skipped" and .["db-scope"].outputs.db_changed == "false"))');
    expect(rule).toContain('(.["android-native"].result == "success" or (.["android-native"].result == "skipped" and .["db-scope"].outputs.android_native == "false"))');
    expect(step.run).toContain("exit 1");
    // No other job may take the required context's name.
    for (const [id, job] of Object.entries(ci.jobs)) if (id !== "check") expect(job.name ?? id).not.toBe("check");
  });

  it("runs every step of `npm run check` in some lane", () => {
    const steps = pkg.scripts.check.split("&&").map((part) => part.trim().replace(/^npm run /, ""));
    const all = Object.values(ci.jobs).map(runs).join("\n");
    for (const step of steps) {
      if (step === "test") continue;
      expect(all, step).toMatch(new RegExp(`^\\s*(?:run: )?npm run ${step.replace(/[:.]/g, "\\$&")}\\s*$`, "m"));
    }
    expect(steps).toContain("test");
  });

  it("shards exactly `npm test` across the web-tests matrix", () => {
    const job = ci.jobs["web-tests"];
    const shards = job.strategy.matrix.shard;
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1));
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(runs(job)).toContain(`npm test -- --shard=\${{ matrix.shard }}/${shards.length}`);
    expect(job.name).toBe(`web-tests (\${{ matrix.shard }}/${shards.length})`);
    expect(pkg.scripts.test).toBe("vitest run --pool=threads");
  });

  it("installs Playwright only where a browser launches, from a cache, with retries", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (id !== "web-tests") expect(runs(job), id).not.toMatch(/playwright/);
    }
    const job = ci.jobs["web-tests"];
    const cache = job.steps.find((step) => step.uses?.startsWith("actions/cache@"));
    expect(cache.with.path).toBe("~/.cache/ms-playwright");
    expect(cache.with.key).toContain("steps.playwright.outputs.version");
    expect(runs(job)).not.toContain("--with-deps");
    // The browser download is retried; the system libraries are not.
    expect(runs(job).match(/for attempt in /g)).toHaveLength(1);
    expect(runs(job)).toContain("for attempt in 1 2 3; do\n  npx playwright install chromium && exit 0");
    // apt retries an unreachable mirror for about 20 minutes, so the system
    // dependencies get one bounded attempt and the lane continues without them.
    const deps = job.steps.find((step) => step.name === "Install Chromium system dependencies").run;
    expect(deps.match(/install-deps/g)).toHaveLength(1);
    expect(deps).toContain("timeout --kill-after=10 90 npx playwright install-deps chromium \\\n  || echo \"::warning title=Package mirror unreachable::");
    expect(deps).not.toMatch(/exit 1|sleep/);
  });

  it("clones each web shard two commits deep and fetches history only when the base is outside", () => {
    const job = ci.jobs["web-tests"];
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@/);
    expect(job.steps[0].with["fetch-depth"]).toBe(2);
    // Run 43148928367: without its base named, the conventions script that
    // tests/repository-conventions.test.js runs cannot diff in a two-commit clone.
    expect(job.steps.find((step) => step.run?.includes("npm test -- --shard"))?.env.CI_BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    const fallback = job.steps[1];
    expect(fallback.if).toBe("github.event_name == 'pull_request'");
    expect(fallback.env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(fallback.run.trim()).toBe('git merge-base --is-ancestor "$BASE_SHA" HEAD 2>/dev/null || git fetch --no-tags --unshallow origin');
    // The only suite that reads history compares against this base.
    const shard = job.steps.find((step) => step.run?.startsWith("npm test"));
    expect(shard.env.ASSURANCE_BASE_REF).toBe("${{ github.event.pull_request.base.sha || format('origin/{0}', github.event.repository.default_branch) }}");
    // The conventions lane still needs the full history.
    expect(ci.jobs["conventions-and-lint"].steps[0].with["fetch-depth"]).toBe(0);
  });

  it("keeps the old job's mobile check, contrast audit and build", () => {
    expect(runs(ci.jobs.mobile)).toContain("npm ci --prefix apps/mobile");
    expect(runs(ci.jobs.mobile)).toContain("npm run check --prefix apps/mobile");
    expect(runs(ci.jobs["contrast-and-build"])).toContain("npm run contrast:audit");
    expect(runs(ci.jobs["contrast-and-build"])).toContain("npm run build");
  });

  it("checks Expo package versions against the installed SDK's list, not the live one", () => {
    // Online, expo-doctor compares with Expo's newest patch list, so every
    // pull request turned red on the day Expo published a patch release.
    const mobile = JSON.parse(readFileSync(new URL("../apps/mobile/package.json", import.meta.url), "utf8"));
    // npm_config_loglevel=warn only quiets npm's own notices around the run.
    expect(mobile.scripts.doctor).toBe("EXPO_OFFLINE=1 npm_config_loglevel=warn expo-doctor");
    expect(mobile.scripts.check.startsWith("npm run doctor && ")).toBe(true);
  });

  it("runs the repository's own scanner self-test, the three tree scans and registry signatures", () => {
    const steps = ci.jobs.security.steps.map((step) => step.run ?? "");
    const selfTest = steps.indexOf("npm run security:scan:self-test");
    const scan = steps.indexOf("npm run security:scan");
    expect(selfTest).toBeGreaterThan(-1);
    // The tree scan is believed only after the scanners proved themselves.
    expect(scan).toBeGreaterThan(selfTest);
    // `security:scan` is every tree scan: Semgrep, gitleaks and Trivy.
    expect(pkg.scripts["security:scan"]).toBe("node scripts/run-security-scan.mjs all");
    expect(runs(ci.jobs.security).match(/npm audit signatures/g)).toHaveLength(2);
  });

  it("audits dependencies in their own lane against the pull request's base", () => {
    const audit = runs(ci.jobs["dependency-audit"]);
    expect(audit).toContain('node scripts/ci-dependency-audit.mjs --base "$BASE_SHA"');
    expect(audit).not.toMatch(/npm ci/);
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (id !== "dependency-audit") expect(runs(job), id).not.toMatch(/npm audit --audit-level/);
    }
  });
});

describe("ci.yml Android native lane", () => {
  const job = ci.jobs["android-native"];
  const named = (name) => job.steps.find((step) => step.name === name);

  it("runs only when db-scope selects it and the mobile lane passed", () => {
    expect(job.needs).toEqual(["db-scope", "mobile"]);
    expect(job.if).toBe("needs.db-scope.outputs.android_native == 'true' && needs.mobile.result == 'success'");
    const scope = ci.jobs["db-scope"];
    expect(scope.outputs.android_native).toBe("${{ steps.scope.outputs.android_native }}");
    expect(runs(scope)).toContain('node scripts/ci-android-scope.mjs "$paths"');
  });

  it("prebuilds and compiles the debug app from pinned tools, then checks the merged manifest", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.defaults.run["working-directory"]).toBe("apps/mobile");
    expect(job.steps[0].with["persist-credentials"]).toBe(false);
    expect(named("Set up JDK 17").with).toMatchObject({ distribution: "temurin", "java-version": "17" });
    const tools = named("Install pinned Android command-line tools").run;
    expect(tools).toContain("sha256sum --check --strict");
    const sdk = named("Install Android SDK packages").run;
    expect(sdk).toContain("33e16af1a6bbabe12cad54b2117085c07eab7e4fa67cdd831805f0e94fd826c1");
    expect(sdk).toContain("Pkg.Revision = 27.1.12297006");
    expect(named("Generate the Android native project").run).toBe("npx expo prebuild --platform android --no-install --clean");
    const compile = named("Compile the Android debug application");
    expect(compile["working-directory"]).toBe("apps/mobile/android");
    expect(compile.run).toBe("./gradlew :app:assembleDebug --no-daemon --stacktrace");
    expect(job.steps.at(-1).run).toBe("node scripts/verify-android-manifest-permissions.mjs");
  });

  it("builds debug only, with no secret, no signing material and no upload", () => {
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/secrets\.|assembleRelease|bundleRelease|keystore|KEYSTORE|signingConfig|upload-artifact|eas (build|submit)|fastlane|GH_TOKEN|github\.token/);
  });
});

describe("ci.yml database lane", () => {
  const db = ci.jobs.db;
  const step = (name) => db.steps.find((entry) => entry.name === name);

  it("runs only when db-scope selects it, from the changed paths", () => {
    expect(db.needs).toBe("db-scope");
    expect(db.if).toBe("needs.db-scope.outputs.db_changed == 'true'");
    const scope = ci.jobs["db-scope"];
    expect(scope.outputs.db_changed).toBe("${{ steps.scope.outputs.db_changed }}");
    expect(runs(scope)).toContain("git diff --name-only -z --no-renames HEAD^1 HEAD");
    expect(runs(scope)).toContain('node scripts/ci-db-scope.mjs "$paths"');
  });

  it("starts unionground-lab-ci labs it prepares itself, from main's baseline or a replay", () => {
    expect(step("Prepare the disposable labs").run).toContain("node scripts/prepare-ci-disposable-db.mjs");
    expect(step("Prepare the disposable labs").env).toMatchObject({ CI_DB_REQUIRE_RESERVED_PORTS: "1", CI_DB_SENSITIVE_PROOF_TARGET: "1" });
    const names = db.steps.map((entry) => entry.name);
    expect(names.indexOf("Prepare the disposable labs")).toBeLessThan(names.indexOf("Choose the database baseline"));
    const baseline = step("Choose the database baseline");
    expect(baseline.id).toBe("baseline");
    expect(baseline.run).toBe("node scripts/fetch-physical-db-baseline.mjs");
    // The run's own token, read-only: no secret.
    expect(baseline.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    const start = step("Start both labs from the baseline, or replay every migration");
    expect(start.id).toBe("start");
    expect(start.env).toEqual({ BASELINE_MODE: "${{ steps.baseline.outputs.mode }}" });
    expect(start.run).toMatch(/warm\)\n\s+node scripts\/physical-db-baseline\.mjs --restore\n/);
    const cold = start.run.slice(start.run.indexOf("cold)"));
    expect(cold.indexOf("node scripts/start-disposable-db-stack.mjs")).toBeLessThan(cold.indexOf("node scripts/start-sensitive-proof-stack.mjs"));
    // Any other decision, including none, fails before a lab starts.
    expect(start.run).toMatch(/\*\)\n\s+echo "::error::[^\n]*\n\s+exit 1\n\s+;;/);
    expect(start.run.trim().split("\n").at(-1)).toBe('echo "SENSITIVE_PROOF_STACK_STARTED=1" >> "$GITHUB_ENV"');
    // The record of which snapshot and which migrations ride with the proofs.
    expect(step("Retain the sanitized proof report").with.path).toContain("${{ runner.temp }}/physical-db-baseline-record.json");
  });

  it("runs the migration history, the contract and the required proofs against the disposable lab", () => {
    for (const name of ["Migration history", "Database contract"]) {
      expect(step(name).env).toMatchObject({ DB_VERIFY_DISPOSABLE_CONFIRM: "pr-ci-disposable", REQUIRE_DB_VERIFY: "1" });
    }
    expect(step("Migration history").run).toBe("npm run verify:migrations");
    expect(step("Database contract").run).toBe("npm run verify:db");
    expect(step("Database contract").env.DB_VERIFY_PROFILE).toBe("disposable-application");
    const proofs = step("Required database proofs");
    expect(proofs.run).toBe("npm run verify:db-repair-proofs");
    // The scanner is provisioned here, so the pipeline proof is never deferred.
    expect(proofs.env).toMatchObject({ REQUIRE_DB_REPAIR_PROOFS: "1", PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" });
    expect(step("Start the pinned malware scanner").run).toMatch(/clamav\/clamav@sha256:[0-9a-f]{64}/);
  });

  it("stops only what it started, by project, and always", () => {
    const labs = step("Stop and remove both labs");
    expect(labs.if).toBe("always()");
    expect(labs.run).toContain('stop --project-id "$project" --no-backup');
    expect(labs.run).toContain('"$RUNNER_TEMP"/unionground-lab-ci-*)');
    expect(step("Stop the malware scanner and remove its fixtures").if).toBe("always()");
    expect(runs(db)).not.toMatch(/prune|stop --all|docker (?:volume|network) rm|pkill/);
  });
});

describe("disposable-db-baseline.yml", () => {
  const producer = workflow("disposable-db-baseline.yml");
  const action = parse(readFileSync(new URL("../.github/actions/physical-db-baseline/action.yml", import.meta.url), "utf8"));
  const BUILDS = ["build-1", "build-2", "build-3"];
  const REPLAYS = ["replay-1", "replay-2", "replay-3"];
  const MONTHLY = "47 8 3 * *";
  const built = "needs.build-1.outputs.complete == 'true' || needs.build-2.outputs.complete == 'true' || needs.build-3.outputs.complete == 'true'";
  const snapshot = "${{ needs.build-1.outputs.complete == 'true' && needs.build-1.outputs.snapshot || needs.build-2.outputs.complete == 'true' && needs.build-2.outputs.snapshot || needs.build-3.outputs.snapshot }}";

  it("builds on main when a snapshot input changes, weekly, monthly with the full replay and by hand, and runs one unpublished attempt for a builder change", () => {
    expect(Object.keys(producer.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
    expect(producer.on.push.branches).toEqual(["main"]);
    const builder = ["scripts/physical-db-baseline.mjs", "scripts/lib/physical-db-baseline.mjs", "scripts/fetch-physical-db-baseline.mjs",
      ".github/actions/physical-db-baseline/**", ".github/workflows/disposable-db-baseline.yml"];
    expect(producer.on.push.paths).toEqual(expect.arrayContaining(["supabase/**", "config/database-assurance-baseline.json", ...builder]));
    expect(producer.on.pull_request.paths).toEqual(builder);
    expect(producer.on.schedule.map(({ cron }) => cron)).toEqual(["23 7 * * 1", MONTHLY]);
    expect(producer.on.workflow_dispatch.inputs.replay).toMatchObject({ type: "choice", options: ["none", "compare", "publish"], default: "none" });
    expect(producer.permissions).toEqual({ contents: "read" });
    expect(producer.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("tries up to three runners in turn, each told what the last one learned, and publishes only from main", () => {
    expect(Object.keys(producer.jobs)).toEqual([...BUILDS, ...REPLAYS, "watcher-red", "result"]);
    for (const [index, id] of [...BUILDS, ...REPLAYS].entries()) {
      const job = producer.jobs[id];
      expect(job["runs-on"], id).toBe("ubuntu-24.04");
      expect(job["continue-on-error"], id).toBe(true);
      // The base download needs actions: read, and nothing writes.
      expect(job.permissions, id).toEqual({ contents: "read", actions: "read" });
      expect(job.outputs.complete, id).toBe("${{ steps.attempt.outputs.complete }}");
      expect(job.outputs.next, id).toBe("${{ steps.attempt.outputs.next }}");
      expect(job.steps[0].with).toEqual({ "persist-credentials": false });
      expect(job.steps[1]).toMatchObject({ id: "attempt", uses: "./.github/actions/physical-db-baseline" });
      if (index >= 3) continue;
      const { with: inputs } = job.steps[1];
      expect(inputs.attempt).toBe(String(index + 1));
      expect(job.outputs.snapshot).toBe("${{ steps.attempt.outputs.snapshot }}");
      expect(inputs.publish).toMatch(/^\$\{\{ github\.ref == 'refs\/heads\/main'/);
      if (index === 0) {
        expect(job.needs).toBeUndefined();
        expect(job.if).toBeUndefined();
        expect(inputs.publish).toContain("github.event_name != 'pull_request'");
        expect(inputs.path).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.replay == 'publish' && 'from-zero' || 'auto' }}");
      } else {
        const previous = BUILDS[index - 1];
        expect([job.needs].flat()).toContain(previous);
        // The job's own result reads success under continue-on-error, so the
        // chain reads what the previous attempt reported instead.
        expect(job.if).toContain(`needs.${previous}.outputs.complete != 'true'`);
        expect(job.if).toMatch(/^\$\{\{ !cancelled\(\) && github\.event_name != 'pull_request' && /);
        if (index === 2) expect(job.if).toContain("needs.build-2.result != 'skipped'");
        expect(inputs.path).toBe(`\${{ needs.${previous}.outputs.next || (github.event_name == 'workflow_dispatch' && inputs.replay == 'publish' && 'from-zero') || 'auto' }}`);
        expect(inputs.reason).toContain(`needs.${previous}.outputs.reason`);
      }
    }
  });

  it("replays from zero monthly or on request after a built snapshot, compares it, publishes nothing, and stops on a difference", () => {
    for (const [index, id] of REPLAYS.entries()) {
      const job = producer.jobs[id];
      expect(job.needs).toEqual(expect.arrayContaining(BUILDS));
      expect(job.steps[1].with).toEqual({ attempt: `r${index + 1}`, path: "compare", compare: snapshot, publish: "false" });
      if (index === 0) {
        expect(job.if).toBe(`\${{ !cancelled() && ((github.event_name == 'workflow_dispatch' && inputs.replay == 'compare') || (github.event_name == 'schedule' && github.event.schedule == '${MONTHLY}')) && (${built}) }}`);
      } else {
        const previous = REPLAYS[index - 1];
        expect(job.if).toBe(`\${{ !cancelled() && needs.${previous}.result != 'skipped' && needs.${previous}.outputs.complete != 'true' && needs.${previous}.outputs.next != 'stop' }}`);
      }
    }
  });

  it("describes the runner, chooses a base, builds, always cleans up by ledger, and publishes the two snapshot files only after a complete attempt", () => {
    const steps = action.runs.steps;
    const named = (name) => steps.find((entry) => entry.name === name);
    expect(steps[0].name).toBe("Describe this runner");
    expect(steps[0].run).toContain("lscpu");
    expect(steps[0].run).toContain("PHYSICAL_BASELINE_CPU=");
    const base = named("Choose the base snapshot");
    expect(base.if).toBe("inputs.path == 'auto'");
    expect(base.run).toBe("node scripts/fetch-physical-db-baseline.mjs --builder");
    expect(base.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    const build = named("Build the snapshot, archive the lab, restore it into a fresh lab");
    expect(steps.indexOf(build)).toBeGreaterThan(steps.indexOf(base));
    expect(build.run).toContain('node scripts/physical-db-baseline.mjs --build --output "$PHYSICAL_BASELINE_OUTPUT"');
    expect(build.env).toMatchObject({ PHYSICAL_BASELINE_PATH: "${{ inputs.path }}", PHYSICAL_BASELINE_REASON: "${{ inputs.reason }}", PHYSICAL_BASELINE_COMPARE: "${{ inputs.compare }}" });
    const cleanup = named("Remove every lab this attempt started");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toBe('node scripts/physical-db-baseline.mjs --cleanup --output "$PHYSICAL_BASELINE_OUTPUT"');
    const next = named("Choose what a next attempt does");
    expect(next).toMatchObject({ id: "next", if: "always()", run: 'node scripts/physical-db-baseline.mjs --next --output "$PHYSICAL_BASELINE_OUTPUT"' });
    const publish = named("Publish the snapshot");
    expect(publish.if).toBe("success() && inputs.publish == 'true' && inputs.path != 'compare'");
    expect(publish.with).toMatchObject({ name: "physical-disposable-baseline", "if-no-files-found": "error", "compression-level": 0 });
    expect(publish.with.path.trim().split("\n").map((line) => line.trim().split("/").at(-1))).toEqual(["manifest.json", "data.tgz"]);
    // Complete only after every other step, the publish included, passed.
    expect(steps.at(-2)).toBe(publish);
    expect(steps.at(-1)).toMatchObject({ id: "complete", run: 'echo "complete=true" >> "$GITHUB_OUTPUT"' });
    expect(steps.at(-1).if).toBeUndefined();
    expect(action.outputs.complete.value).toBe("${{ steps.complete.outputs.complete }}");
    expect(action.outputs.next.value).toBe("${{ steps.next.outputs.next }}");
    expect(named("Retain the build report and command logs").with.path).toContain("${{ runner.temp }}/physical-db-baseline-record.json");
    const all = steps.map((entry) => entry.run ?? "").join("\n");
    expect(all).not.toMatch(/prune|stop --all|docker (?:volume|network) rm|pkill/);
  });

  it("reports a run with no built snapshot, and a failed full replay in its own issue, through watcher-red on main only", () => {
    const watcher = producer.jobs["watcher-red"];
    expect(watcher.needs).toEqual([...BUILDS, ...REPLAYS]);
    expect(watcher.if).toBe("${{ !cancelled() && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}");
    expect(watcher.permissions).toEqual({ contents: "read", issues: "write" });
    expect(watcher.steps[1]).toEqual({ uses: "./.github/actions/watcher-red", with: {
      workflow: "${{ github.workflow }}", conclusion: `\${{ (${built}) && 'success' || 'failure' }}`, "github-token": "${{ github.token }}" } });
    expect(watcher.steps[2]).toEqual({ if: "${{ needs.replay-1.result != 'skipped' }}", uses: "./.github/actions/watcher-red", with: {
      workflow: "${{ github.workflow }} full replay",
      conclusion: "${{ (needs.replay-1.outputs.complete == 'true' || needs.replay-2.outputs.complete == 'true' || needs.replay-3.outputs.complete == 'true') && 'success' || 'failure' }}",
      "github-token": "${{ github.token }}" } });
  });

  it("colours the run by what the attempts report: red only when none built the snapshot or the full replay failed", () => {
    const result = producer.jobs.result;
    expect(result.needs).toEqual([...BUILDS, ...REPLAYS]);
    expect(result.if).toBe("${{ !cancelled() }}");
    expect(result["continue-on-error"]).toBeUndefined();
    expect(result.permissions).toBeUndefined();
    const [step] = result.steps;
    expect(step.env.BUILT).toBe(`\${{ ${built} }}`);
    expect(step.env.REPLAY).toContain("needs.replay-1.result == 'skipped' && 'skipped'");
    expect(step.run).toMatch(/if \[ "\$BUILT" != "true" \]; then[\s\S]*exit 1/);
    expect(step.run).toMatch(/if \[ "\$REPLAY" = "failed" \]; then[\s\S]*exit 1/);
  });
});

describe("dependency-audit-daily.yml", () => {
  it("audits main once a day into one issue, with issues: write on that job only", () => {
    expect(daily.on.schedule).toHaveLength(1);
    expect(daily.permissions).toEqual({});
    expect(daily.jobs.audit.permissions).toEqual({ contents: "read", issues: "write" });
    const run = runs(daily.jobs.audit);
    expect(run).toContain('node scripts/ci-dependency-audit.mjs --report "$report"');
    for (const verb of ["gh issue list", "gh issue edit", "gh issue create", "gh issue close"]) expect(run).toContain(verb);
  });
});

// Scheduled assurance (docs/contracts/ci.md): each scheduled workflow runs on
// main only, can be dispatched by hand, and reports a red run through the
// shared watcher-red action instead of an alert webhook.
const SCHEDULED = ["coverage-weekly.yml", "dependency-audit-daily.yml"];
const RED_OR_GREEN = "${{ (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')) && 'failure' || contains(needs.*.result, 'success') && 'success' || 'skipped' }}";

describe("scheduled assurance", () => {
  it.each(SCHEDULED)("%s runs on a schedule or by hand, on main only, and tracks its red runs", (name) => {
    const scheduled = workflow(name);
    expect(Object.keys(scheduled.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(scheduled.on.schedule).toHaveLength(1);
    expect(scheduled.concurrency["cancel-in-progress"]).toBe(false);
    const watcher = scheduled.jobs["watcher-red"];
    expect(watcher.needs).toEqual(Object.keys(scheduled.jobs).filter((id) => id !== "watcher-red"));
    expect(watcher.if).toBe("${{ !cancelled() && github.ref == 'refs/heads/main' }}");
    expect(watcher.permissions).toEqual({ contents: "read", issues: "write" });
    const [checkout, track] = watcher.steps;
    expect(checkout.with).toEqual({ "sparse-checkout": ".github/actions/watcher-red", "persist-credentials": false });
    expect(track).toEqual({ uses: "./.github/actions/watcher-red", with: {
      workflow: "${{ github.workflow }}", conclusion: RED_OR_GREEN, "github-token": "${{ github.token }}" } });
    for (const [id, job] of Object.entries(scheduled.jobs)) {
      // A job that needs none runs first, so it carries the main-only gate.
      if (id !== "watcher-red" && !job.needs) expect(job.if, id).toMatch(/github\.ref == 'refs\/heads\/main'/);
      for (const step of job.steps ?? []) if (step.uses?.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"], id).toBe(false);
    }
  });

  it("measures coverage weekly through the same six shards as web-tests, then merges and ratchets", () => {
    const coverage = workflow("coverage-weekly.yml");
    expect(coverage.permissions).toEqual({ contents: "read" });
    expect(coverage.jobs.coverage.strategy.matrix.shard).toEqual(ci.jobs["web-tests"].strategy.matrix.shard);
    expect(runs(coverage.jobs.coverage)).toContain("npm run test:coverage -- --shard=${{ matrix.shard }}/6 --reporter=blob");
    expect(pkg.scripts["test:coverage"]).toBe(`${pkg.scripts.test.replace("vitest run", "vitest run --coverage")}`);
    const ratchet = runs(coverage.jobs.ratchet);
    expect(ratchet).toContain("npx vitest --merge-reports --coverage");
    expect(ratchet).toContain("node scripts/verify-coverage-ratchet.mjs --update");
    expect(ratchet).toContain('ASSURANCE_BASE_REF="$HEAD_SHA" ASSURANCE_HEAD_REF="$HEAD_SHA" node scripts/verify-coverage-ratchet.mjs');
  });
});

describe("ci-dependency-audit", () => {
  const advisory = (name, severity, ghsa) => ({ name, severity, url: `https://github.com/advisories/${ghsa}`, range: "<1.0.0", source: 1 });
  const report = (...vias) => ({ vulnerabilities: Object.fromEntries(vias.map((via, index) => [`p${index}`, { via: [via, "other"] }])) });

  it("keeps high and critical advisories and drops the rest", () => {
    const found = blockingAdvisories(report(
      advisory("a", "high", "GHSA-aaaa-aaaa-aaaa"),
      advisory("b", "critical", "GHSA-bbbb-bbbb-bbbb"),
      advisory("c", "moderate", "GHSA-cccc-cccc-cccc"),
    ));
    expect(found.map((entry) => entry.key)).toEqual(["GHSA-aaaa-aaaa-aaaa a", "GHSA-bbbb-bbbb-bbbb b"]);
  });

  it("fails closed on a report npm could not complete", () => {
    expect(() => blockingAdvisories(null)).toThrow();
    expect(() => blockingAdvisories({ error: { code: "ENOTFOUND" } })).toThrow();
  });

  it("blames a change only for advisories its base did not already carry", () => {
    const base = blockingAdvisories(report(advisory("a", "high", "GHSA-aaaa-aaaa-aaaa")));
    const head = blockingAdvisories(report(advisory("a", "high", "GHSA-aaaa-aaaa-aaaa"), advisory("b", "high", "GHSA-bbbb-bbbb-bbbb")));
    expect(introducedAdvisories(head, base).map((entry) => entry.key)).toEqual(["GHSA-bbbb-bbbb-bbbb b"]);
    expect(introducedAdvisories(base, head)).toEqual([]);
  });
});
