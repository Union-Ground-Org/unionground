# CI lanes and the required `check`

Written November 11, 2026, when `.github/workflows/check.yml` (one serial job,
about 45 minutes) became the parallel lanes of `.github/workflows/ci.yml`.
`docs/contracts/README.md` lists every area contract. `tests/ci-workflow.test.js`, `tests/actions-runner-policy.test.js`
and `tests/watcher-red-action.test.js` pin what this page says.

## Lanes

`ci.yml` runs on every pull request and on pushes to `main`. A newer push to
the same ref cancels the run in flight. Every lane installs its own
dependencies from the npm cache.

| Job | What it runs |
| --- | --- |
| `conventions-and-lint` | `npm run verify:conventions` (with the pull request's base) and `npm run lint` |
| `web-tests (n/6)` | `npm test -- --shard=n/6`: six shards that together run exactly the files `npm test` runs. A two-commit clone (below). The only lane with a browser: Playwright Chromium, cached by version with its download retried, and one bounded attempt at the system libraries |
| `contrast-and-build` | every other step of `npm run check`, in order: contrast audit, contract verifiers, SBOM check, production build, built-bundle checks |
| `mobile` | `npm run check --prefix apps/mobile`, the native app check, including its own production advisory audit. Its Expo doctor step runs with `EXPO_OFFLINE=1`, so package versions are checked against the installed SDK's own list and a new Expo patch release cannot turn unrelated pull requests red; the Expo package set is upgraded together, by hand (`.github/dependabot.yml` ignores it) |
| `security` | the pinned scanners' fixture self-test (`npm run security:scan:self-test`), then the Semgrep, gitleaks and Trivy tree scans (`npm run security:scan`), then `npm audit signatures` for both trees |
| `dependency-audit` | `scripts/ci-dependency-audit.mjs`: `npm audit` at the high level for the web root and `apps/mobile` |
| `db-scope` | from one diff, `scripts/ci-db-scope.mjs`: whether the change has a database input, which decides whether `db` runs; and `scripts/ci-android-scope.mjs`: whether it has an Android native input, which decides whether `android-native` runs |
| `db` | two disposable local Supabase labs restored from `main`'s physical baseline (or replayed from zero), then `npm run verify:migrations`, `npm run verify:db` and `npm run verify:db-repair-proofs` (below) |
| `android-native` | Expo prebuild of `apps/mobile` for Android and a Gradle debug compile, then the merged-manifest permission check ("Android native lane" below) |
| `check` | the aggregate (below) |

When `npm run check` gains a step, add it to a lane in the same change;
`tests/ci-workflow.test.js` fails until some lane runs it.

## What `check` means

`check` needs every lane and `db-scope`, runs even when one failed
(`if: always()`), and passes only when each one's result is `success`. A
failed, cancelled or skipped lane fails it, with two exceptions: `db` may be
skipped when `db-scope` succeeded and answered `db_changed=false`, and
`android-native` may be skipped when `db-scope` succeeded and answered
`android_native=false`. A skipped `db` or `android-native` after a failed
`db-scope`, or after `db-scope` selected it, fails `check`. (`android-native`
also waits for `mobile`; when `mobile` fails, `check` fails on that.)

`check` is the status context the `main` ruleset requires. **Its name must not
change** unless the ruleset changes in the same hour; a renamed job leaves the
required context missing and every pull request blocked. No other job may be
named `check`.

## Pull requests run `main`'s copy of this workflow

Since November 12, 2026 an organization ruleset, "Union Ground trusted CI
workflow", requires `.github/workflows/ci.yml` **from `refs/heads/main`** on
every pull request into `main`. A pull request therefore runs the workflow as
`main` has it, once, and not its own edited copy, so it cannot delete a lane
from its own run. The repository ruleset still
requires the `check` status, which that run produces.

What follows from it:

- **A change to `ci.yml` is not proven by its own pull request.** Its lanes
  run `main`'s version. The first real run of the changed file is the push run
  on `main` after the merge: read it, and be ready to follow up.
- **A broken `ci.yml` on `main` blocks every pull request, including the
  fix.** An organization owner sets the ruleset's enforcement to `disabled`,
  merges the fix, and sets it back to `active`. There are no bypass actors.
- **No `concurrency` block.** A superseded run finishes instead of being
  cancelled (removed in #104).
- A pull request based on another branch, and every push to `main`, still run
  the repository's own copy.

## What blocks a merge and what only reports

Blocks (through `check`): every lane above. In `dependency-audit` a pull request
fails only for a high or critical advisory that its own `package.json` or
`package-lock.json` change introduces in either tree, compared with the same
tree at its base commit (since November 9, 2026). The previous rule, any high advisory anywhere, blocked
every merge from October 23 to November 9, 2026.

Only reports:

- A high or critical advisory already on `main`. Every run prints it as a
  warning, and `.github/workflows/dependency-audit-daily.yml` audits `main`
  once a day into one `Dependency advisories on main` issue, which it opens,
  updates and closes.
- Lint warnings (rules at `warn`).
- Expired security exceptions in per-change lanes (scanner policy).

**The security tree scans** joined the `security` lane on November 11, 2026
(unit 18 of the parity order). Each was red on the tree, and each repair keeps
the policy as strict as it was: no path or rule exclusion was widened, and no
exception covers anything but an exact, reviewed value.

- Semgrep (`node scripts/run-security-scan.mjs semgrep`). The policy listed a
  `workers/` root that this repository does not have, and Semgrep fails the
  whole scan on a missing root; the root is gone from `scan_paths`, and
  `tests/security-scanner-policy.test.js` now requires every listed root to
  exist and every existing delivery root (`api`, `src`, `workers`, `scripts`,
  the three `apps/mobile` roots) to be listed, so a `workers/` added later is
  scanned. Semgrep could also not parse two mobile test files
  (`importOriginal<typeof import('…')>()`); they now name the type first
  (`type M = typeof import('…')`, the form `secureShareIntake.test.ts` already
  used), so the scan parses every file. The four `ERROR` findings are the four
  reviewed weak-hash exceptions, each bound to one occurrence.
- gitleaks (`… gitleaks`). Three `generic-api-key` findings were the synthetic
  Supabase publishable keys `sb_publishable_synthetickey0123` and
  `sb_publishable_testkey123456` in three web tests; each now has its own
  exception bound to the file and the exact value digest, expiring
  May 10, 2027. The three exceptions for `scripts/verify-dues-local.mjs`, a
  file removed from the tree on October 15, 2026 whose fixture keys are still
  in history, are now history-scoped (`lanes: ["history"]`), so they no longer
  apply to the tree scan.
- Trivy (`… trivy`). Its node-forge build-tool entry covered
  GHSA-86w9-cpqp-85rv in node-forge 1.4.0. node-forge 1.4.2 patched it, the
  mobile lockfile resolves 1.4.3, and the pinned Trivy reports nothing for it
  at any severity, so the entry is retired.
  `tests/security-trivy-node-forge-exception.test.js` keeps it
  as a fixture, so the build-tool machinery stays proven.

The tree scans block on any finding above the policy's floor. Trivy also reads
both npm lockfiles, so, unlike `dependency-audit`, it fails every pull request
for a high or critical advisory that reaches `main` in a package it detects,
until the package is updated or the advisory gets a reviewed policy entry.

## Android native lane

Written November 11, 2026 (unit 18 of the parity order). The `mobile` lane
exports both JavaScript
bundles but compiles no native code, so a config plugin, a local native module
or a native dependency bump could break the Android build with every other lane
green.

**When it runs.** On a pull request and on a push to `main`, when `db-scope`
finds an input of the native build in the change and `mobile` passed. The
inputs (`scripts/ci-android-scope.mjs`; `tests/ci-android-scope.test.js` pins
them) are `apps/mobile/app.config.*`, `app.json`,
`eas.json`, `package.json`, `package-lock.json`, `assets/`, `plugins/` and
`modules/`, plus `config/mobile-app-links.json` and `config/sample-backend.json`
(which `app.config.ts` reads), the manifest verifier the lane runs, the scope
script and `ci.yml` itself, so a change to the lane proves the lane. A diff that
cannot be read selects it.

**What it runs.** On `ubuntu-24.04` with a 90-minute limit: JDK 17 (Temurin),
Google's command-line tools checked against a pinned SHA-256, NDK r27b
(27.1.12297006) downloaded with resumption and checked against Google's size
and SHA-1 and a pinned SHA-256, platform 36, build-tools 36.0.0 and CMake
3.22.1; then `npm ci` in `apps/mobile`, `npx expo prebuild --platform android
--no-install --clean`, `./gradlew :app:assembleDebug`, and
`node scripts/verify-android-manifest-permissions.mjs` over Gradle's merged
manifest. It reads no secret and no repository variable, holds no signing
material (Gradle signs a debug build with the debug keystore the template
generates), uploads nothing and leaves no token in its clone.

**Not included:** lane freshness, a runner switch and a merge-group early
stop.

## Database lane

Written November 11, 2026 (units 7 and 7b of the parity order). Before it,
migrations reached `main` with no automated database proof; the proofs last ran
by hand on October 19 and 21, 2026.

**When it runs.** On a pull request and on a push to `main`, only when the
change touches a database input:
`supabase/migrations/`, `supabase/config.toml`, `scripts/db-contract.json`,
`config/database-assurance-baseline.json`, every planned proof file and every
`tests/*-db.test.*`, `tests/helpers/`, the lab, baseline, proof and verifier
scripts, the private-upload pipeline the scanner proof covers, and `ci.yml`
itself (`scripts/ci-db-scope.mjs` is the list; `tests/ci-db-scope.test.js` pins
it). `package.json` and the lockfiles are not inputs: the one dependency that
changes the replay, the `supabase` CLI, is held to
`config/database-assurance-baseline.json` by the conventions check. A diff that
cannot be read (a first push, an unreachable `before`) selects the lane.

**Why the labs start from a snapshot.** Replaying every migration from zero
took 55 minutes for the two labs on GitHub's 2-vCPU runner (PR #81, run
43068498609), and on a slower machine of the same class it failed:
`20260924170000_organization_structure_import.sql` sets its own 60-second
statement limit, and its statement 98 crossed it on the first replay and again
on the replay from zero (run 43082264943). 222 migrations set a limit of their
own, and migrations are never edited. So the snapshot is built on `main`,
where it can try again on another machine, and a pull request restores it.
This snapshot is the physical baseline (`scripts/physical-db-baseline.mjs`).

**The snapshot (`.github/workflows/disposable-db-baseline.yml`).** On a push to
`main` that changes a snapshot input (`supabase/`, the CLI pin, the builder,
fetch and lab scripts, the workflow and its action), every Monday at 07:23 UTC,
on the 3rd of each month at 08:47 UTC (with the full replay below), and by hand.
Since November 12, 2026 (unit 19) it builds **incrementally**, as a production
database is built: an attempt (`.github/actions/physical-db-baseline`) first
prints the runner's CPU (`lscpu`), then
`scripts/fetch-physical-db-baseline.mjs --builder` chooses a base exactly as a
pull request chooses its snapshot (GitHub's artifact digest, the producer run
and commit the manifest names, the same stack inputs, and migrations that are a
prefix of this tree's, byte for byte), but only among producer runs older than
its own. `scripts/physical-db-baseline.mjs --build` restores that base into a
fresh `unionground-lab-ci-*` lab through the same restore a pull request
runs, which applies only the newer migrations. From there both paths are the
same: the exact migration history, a pristine state (no auth user, identity,
session, member profile or stored object), the three pristine-phase proofs, a
`pg_ctl` stop, an archive of the data directory, and a manifest of the
platform, the CLI version and its Linux binary's lockfile integrity, the
Supabase configuration as the labs rewrite it, every migration up to the newest
by name and SHA-256, the database image, engine and extension pins, two schema
digests, the archive's digest and the producing run and commit. The archive is
then restored into a second fresh lab, and must show the same schema with
nothing to apply, before an attempt that passed every step uploads
`physical-disposable-baseline` (kept 14 days). The weekly run refreshes the
same way, so a snapshot never ages out while the builder is healthy. Each
attempt removes every lab it started by its project id, from a ledger written
before the lab starts. A pull request that changes the builder runs one
attempt, takes the incremental path when `main` has a live snapshot, and
publishes nothing.

Why incremental: the from-zero replay failed about half of `main`'s builder
attempts on November 11, 2026, every time on a migration's own 60-second
statement limit (SQLSTATE 57014). The cause is single-thread CPU, not
configuration: `private.account_lifecycle_trigger_surface()` and
`private.account_lifecycle_referential_action_trigger_issues()` take 44.1 to
44.6 seconds each on an AMD EPYC 9V74 runner, with JIT on and off alike (run
43155426062), and 13 migrations call them under a 60-second limit. An
incremental build replays only the migrations a change adds.

**The chain (manifest schema 2, `build`).** `path` is `from-zero` or
`incremental`; `reason` says why. An incremental snapshot names its `base` (the
producer run, commit, manifest SHA-256 and newest migration it was built on),
the migrations `applied` on top (exactly those after the base's newest),
`depth` (incremental builds since the last from-zero replay) and `root` (that
replay's run, commit and manifest). A from-zero snapshot has no base, nothing
applied, depth 0 and no root. Schema 1 manifests, written before November 12,
2026, were all from-zero replays and are read as chain roots. Every restore (a
pull request's, the builder's base and its round trip) refuses a manifest whose
chain is incomplete or disagrees with this tree: applied migrations that are
not exactly those after the base, a base prefix that is not one of the
snapshot's migrations, a base that is not an older run, or a root and depth
that disagree. Each link was verified by the build that made it (the base's
GitHub digest, identity and restore), so a pull request checks the newest link
against its own tree and does not need the expired ones. The `db` job's
summary and `physical-db-baseline-record.json` name how its snapshot was made.

**When the builder replays from zero.**

| Situation | Path |
| --- | --- |
| A live main snapshot fits (same stack inputs, its migrations a prefix of this tree's) | incremental |
| No producer run on `main` yet, or every snapshot expired (bootstrap) | from zero |
| A stack input changed (Supabase configuration, CLI, platform) | from zero |
| None of the five newest snapshots is a prefix of `main`'s migrations (an earlier migration edited, removed or inserted before the newest) | from zero |
| The previous attempt could not restore its base (bytes, identity, chain, runtime pins, history, state or schema) | from zero, next attempt |
| A dispatch with `replay=publish` (a new chain root) | from zero |
| The GitHub API cannot be read, or no run id | the attempt fails; the next runner chooses again |

An attempt that fails is followed by another on another runner, up to three,
told what the last one learned (`next`: the same choice, or from zero when the
base itself was refused or the attempt already replayed from zero). Each
attempt job continues on error and the `Run result` job decides the run's
colour, so a run where attempt 2 published shows green, and one where no attempt
built the snapshot shows red. When all three fail, the `watcher-red` issue opens
and pull requests keep restoring the last good snapshot. It is not a required
check.

**The full replay.** On the 3rd of each month, and on a dispatch with
`replay=compare`, the run also replays every migration from zero after the
build, on up to three runners in turn, and compares the result with the
snapshot the same run built: every identity input but the runtime pins (by
key), the runtime pins as a restore compares them, both schema digests and the
recorded state. It publishes nothing, so it can never replace or block a good
incremental snapshot. A difference stops the replays (another runner would only
repeat it); a replay that cannot finish tries the next runner. A difference, or
three replays that cannot finish, turns the run red and opens a
`watcher-red: Physical database baseline full replay` issue, which only full
replay runs change. It costs about 45 to 90 runner-minutes a month and is the
only automated proof that the migrations still replay from zero (a new
environment, a disaster recovery) and that the incremental chain has not
drifted from what a replay builds. On a difference, dispatch the workflow with
`replay=publish` on `main` to start a new chain from zero, after finding which
migration behaves differently on a restored database.

**What a pull request's `db` job runs.**

1. `scripts/prepare-ci-disposable-db.mjs` prepares two labs in the runner's
   temp directory, each named `unionground-lab-ci-<12 hex>` (the lab name
   `scripts/verify-unionground-db.mjs` and the README require) on its own
   loopback port block in 55000-59999, after reserving that range from the
   kernel's ephemeral ports.
2. `scripts/fetch-physical-db-baseline.mjs` chooses the baseline. It lists the
   producer's completed runs on `main` in this repository (push, schedule or
   dispatch), takes the newest five that published a snapshot, and downloads
   them newest first. A ZIP whose bytes differ from GitHub's own artifact digest
   is refused before it is unpacked. The manifest must name the producing run
   and commit, and its identity must equal this tree's: the same CLI,
   configuration and platform, and every migration up to the snapshot's newest,
   byte for byte. The first snapshot that fits is used.
3. `scripts/physical-db-baseline.mjs --restore` restores it into the shared lab
   and then into the sensitive-rollout proof's lab. For each lab it starts an
   empty stack with its cron launcher paused, checks that the image, engine and available
   extensions match the manifest's pins, replaces the data directory with the
   verified archive, then requires the installed extensions, the migration
   history up to the snapshot, its recorded state and both schema digests.
   Only then does it apply the newer migrations with `supabase migration up`
   and require the full history. The shared lab applies migrations added
   since the event's comparison base under the
   [public-table grant probe](../conventions/public-table-grants.md). Any refusal
   fails the step; a trusted snapshot that does not restore never falls back.
4. Then, in order: `verify:migrations` and `verify:db` (read-only catalog
   checks, `DB_VERIFY_DISPOSABLE_CONFIRM=pr-ci-disposable`), the pinned ClamAV
   daemon with fresh signatures, and `verify:db-repair-proofs`: all 249 planned
   proof files, at least 2,261 cases, none skipped, the real four-kind upload
   pipeline proof demanded (`PRIVATE_FILE_SCANNER_PROOF_REQUIRED=1`). The three
   checks each run even when an earlier one failed, so one run reports all of
   them.

The job records what it used: the step summary names the snapshot's commit,
producer run, newest migration and manifest digest, and the migrations each lab
applied on top; `physical-db-baseline-record.json` carries the same and is kept
14 days with the sanitized proof report. Cleanup always stops each lab by its
own project id and removes only `unionground-lab-ci-*` workdirs and the
scanner it started. Expected: about 40-50 minutes, of which 8-12 restore both
labs and about 26 run the proofs.

**When it replays from zero, and when it fails.** The job never passes without
a database.

- No snapshot exists yet: the producer is not on `main` (this pull request's
  own run, before it merges), or no `main` run has a live snapshot (none built
  yet, or every one expired). Both labs replay every migration from zero, as
  before the snapshot existed, with a `PHYSICAL BASELINE COLD REPLAY` warning
  and the reason in the summary. That replay can still cross a statement limit
  on a slow machine; re-running the job gets another machine.
- The change alters a stack input of the newest snapshot (the Supabase
  configuration or the CLI): no newer migration can bridge that, so both labs
  replay from zero, with the same warning.
- Every otherwise suitable snapshot already contains a migration the grant
  probe needs to apply. The job first looks for an older snapshot and replays
  from zero if none predates all the added migrations.
- Anything else fails the job with a `PHYSICAL BASELINE REFUSED` error: none of
  the five newest snapshots holds a prefix of this branch's migrations (update
  the branch from `main`; a migration added here must sort after `main`'s
  newest), bytes that disagree with GitHub's digest, a manifest that names
  another run or commit, a GitHub API that cannot be read, or any restore
  check above.

**What it never reads.** No secret, no repository variable, no hosted database
URL, no Supabase access token or project ref. The fetch uses the run's own
token with `actions: read`, the one permission the `db` job adds. The only
database URLs are the two loopback labs, written to the job environment by the
prepare script; every verifier, the proof runner and the baseline scripts
refuse anything else (`scripts/lib/assert-exact-target.mjs`,
`assertDisposableProofUrl`, `assertBaselineTarget`).

**Not wired yet**, each for its reason:

- `verify:db:assurance` (`scripts/run-database-assurance.mjs`: RLS, Advisors
  and database lint ratchets). It starts its own pinned PostgreSQL fixture and
  last passed by hand on October 19, 2026; it joins after the lane's first
  green run on GitHub proves the lane's runtime and memory.
- `verify:task-comment:no-fiction`. It has never run against a Union Ground
  lab.
- `test:unionground-db` (`scripts/verify-unionground-db.mjs`). It needs a
  fresh, empty lab of its own and deliberately leaves its fixtures, so it can
  share neither lab: it needs a third lab. The labs are lab-named, so its
  container guard accepts a CI lab without change.
- `verify:db-boundary:local` and `verify:case-search-db`: hand-run proofs. The
  required plan already carries `tests/db-boundary-tenancy-db.test.js`; the case
  search corpus is in the runner's own manual-only list.
- The runner's own manual-only lists (`MANUAL_ONLY_DB_GATES`,
  `MANUAL_ONLY_DB_PROOF_FILES` in `scripts/run-required-db-proofs.mjs`), with
  their reasons, are unchanged.

**Not included:** lane freshness and the merge queue;
the ghcr.io image login and image cache (they need a package login); the
snapshot workflow's cold-versus-warm comparison and its nightly full
required-proof runs on both (a measurement; here the round trip into a fresh
lab is the check, and the pull request runs the full proofs on the restored
labs); its supervisor process and signal relay (the always-run cleanup step
removes the ledger's labs instead); the Depot runner switch and the alert
webhook; proof sharding (one job fits its timeout); and the deployed-database
drift job (there is no deployed database).

## Scheduled assurance

Added November 11, 2026.
These run beside `check`, never inside it, so a red scheduled run blocks
nothing. Each runs on `main` only, on its schedule or by hand
(`workflow_dispatch`), reads no secret beyond the run's own token and no
repository variable, and names no other product's hosts
(`tests/actions-runner-policy.test.js`, `tests/ci-workflow.test.js`).

| Workflow | When (UTC) | What it does | Runner minutes a week |
| --- | --- | --- | --- |
| `dependency-audit-daily.yml` | daily 11:47 | the advisory issue described above | about 7 for its red-run tracker |
| `coverage-weekly.yml` | Saturdays 09:37 | `npm run test:coverage` through the same six shards as `web-tests`, merged from the shards' blob reports, then `scripts/verify-coverage-ratchet.mjs` | about 80 |
| `disposable-db-baseline.yml` | Mondays 07:23, the 3rd of each month 08:47 (with the full replay), and on each `main` push that changes a snapshot input | builds the database snapshot the `db` lane restores, incrementally on the previous one ("Database lane" above) | about 20 per incremental build, about 45 per replay from zero, up to three attempts when one fails |
| `demo-freshness-watch.yml` | every two hours at :37 | reads the demo's public `build-info.json` and compares it with `main` (`docs/contracts/demo-deploy.md`) | about 170 |
| `demo-uptime-watch.yml` | every six hours at :23 | both demo hostnames up, static only and with certificates in date (`docs/contracts/demo-deploy.md`) | about 55 |

About 358 runner minutes a week in all, plus about 45 for each `main` push
that changes a snapshot input. The snapshot builder also runs one unpublished
attempt for a pull request that changes the builder.

**What a red run does.** Every scheduled workflow ends with a `watcher-red`
job that calls `.github/actions/watcher-red` (it has no alert webhook; this
repository has none). A red or timed-out run opens one
`watcher-red: <workflow name>` issue, labelled `watcher-red`; while it stays
red the run only refreshes that issue's body; the next green run comments and
closes it, and a later red reopens the same issue. A cancelled run changes
nothing.

**Coverage has no baseline yet.** `assurance/coverage-baseline.json` does not
exist, and a full coverage pass is not run on a workstation to make one. Until
it is committed, the weekly run measures, writes the totals to its summary and
attaches the baseline the ratchet would record as the
`coverage-baseline-candidate` artifact. Commit that file, after reading it, to
start the ratchet: from then on a total below it fails the run. The weekly run
compares `main` with itself, so it holds the global totals; an
`--all-files` lane, which would hold every file's own floor, is not included
yet.

Not scheduled, each with what would unblock it:

- **Web performance budgets** (a `web-performance-budgets.yml` workflow).
  `scripts/run-web-performance-budgets.mjs` builds production bundles against
  a loopback backend, which this repository's provider contract refuses (a
  production build needs a hosted URL, key and `VITE_UNIONGROUND_SUPABASE_REF`
  together), and its bundle and scenario ceilings were never measured here.
  Unblock: add a fixture-build runner that fits this provider contract, then
  measure the ceilings once on `ubuntu-24.04`.
- **Visual assurance** (a `visual-assurance.yml` workflow). Its jobs follow
  a Production deployment, and this repository has no git-connected
  deployment. The credential-free demo audit could run on a schedule, but
  `scripts/visual-audit-runner.mjs` still picks the demo roles "member" and
  "coordinator" from the role switcher, which here reads Worker,
  Organizer, Committee and so on, so every route fails before it is measured,
  and `config/visual-audit-baseline.json` holds findings not measured on this
  demo. Unblock:
  map the runner to this demo's roles, review the first findings, then
  schedule it. The deployed and Browserbase proofs also need a connected
  deployment and a Union Ground Browserbase project.
- **Flaky-test roll-up** (a `flaky-tests-rollup.yml` workflow). It ranks
  the `flaky-candidates-*` artifacts that merge-group retries upload; this
  repository has no merge queue and no retry, so there is nothing to rank.
- **Exceptions dashboard** (an `exceptions-dashboard.yml` workflow). Hourly,
  so about 720 runner minutes a week, and it compares merged records with a
  Production deployment this repository does not have.

## Web shard clone and browser setup

Each `web-tests` shard clones two commits deep, the merge commit and its
parents, instead of the full history (67 to 159 s a shard on November 11,
2026). Two suites read history. `tests/subprocessor-register.test.jsx` reads
the fork point of `ASSURANCE_BASE_REF` and `HEAD`, and
`tests/repository-conventions.test.js` runs the conventions script, which gets
its base from `CI_BASE_SHA` because `origin/main` is not in the clone. In both
the base is, on a pull request, the event's base commit, which is the merge
commit's first parent; on a push to `main` the pushed commit itself. When `main` moved after the event and GitHub
built the merge commit on the newer `main`, the base is outside the clone, and
the shard fetches the full history first, as it did before.

The Chromium system libraries get one 90-second attempt (a healthy install takes
15 to 20 s). When the package mirror is unreachable, apt keeps retrying for
about 20 minutes; the old second attempt only repeated that wait. The step then
warns and the shard continues with the runner image's own libraries, with which
every suite passed during the November 11 outage.

## Runners

Every job runs on GitHub's standard `ubuntu-24.04` runner, written as a fixed
label. Never Blacksmith (its app is not installed here; owner ruling,
November 9, 2026), never a self-hosted or larger runner, and never a repository
variable. `.github/actionlint.yaml` declares no custom label and no variable,
so actionlint rejects both. One workflow outside `check` reads a secret: the
hand-dispatched `mobile-ios-eas.yml` reads `EXPO_TOKEN` from its protected
`mobile-ios-release` environment (`docs/contracts/mobile-release.md`); the
runner policy test allows that one name in that one file. A runner switch is
deliberately not included: there is no Depot route or budget guard for this
repository.

## Not included

The merge queue, lane freshness, exact-commit reuse, the merge-group early stop
and the lane receipts. The `main` ruleset has no merge queue, so a pull request
needs its own green `check` on its head. The branch need not be up to date
with `main`: the ruleset's up-to-date rule was removed on November 11, 2026.
