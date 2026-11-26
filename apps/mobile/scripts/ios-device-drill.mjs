// iOS physical device-drill recipe.
//
// The Android half of the G6 drill drove its rows with `adb` plus `uiautomator`
// hierarchy dumps. This is the iOS counterpart: it builds the application and
// the repository-owned XCUITest runner in `apps/mobile/ios-drill` from one
// source commit, installs both on the paired iPhone, executes the rows the
// 2026-09-06 matrix could not attempt, and writes per-row evidence in the shape
// `docs/mobile/evidence/android-g6-drill-20260905/operator-result.json` uses.
//
// Everything that needs a Mac lives behind `run()`. The parsing, extraction and
// result-shaping helpers are pure and exported so `tests/ios-xcuitest-drill-runner.test.js`
// can hold the channel to its contract on any platform.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One row of the committed physical matrix, as the runner sees it.
 * @typedef {object} DrillRow
 * @property {string} case
 * @property {string} acceptance
 * @property {'ui-channel' | 'device-settings' | 'gated'} class
 * @property {string | null} gate the independent gate that still holds a `gated` row
 * @property {string | null} test the XCUITest method that executes the row
 * @property {string[]} capabilities
 * @property {string} evidence
 */

/**
 * @typedef {object} DrillManifest
 * @property {string} record
 * @property {string} bundle_id
 * @property {string} url_scheme
 * @property {string} test_target
 * @property {string} test_class
 * @property {string} ios_matrix
 * @property {string} android_matrix
 * @property {string} ui_reason_marker
 * @property {DrillRow[]} rows
 */

/**
 * @typedef {object} DrillOptions
 * @property {string} device
 * @property {string} subject
 * @property {string} out
 * @property {string[]} rows
 * @property {string} signingDonor
 * @property {boolean} allowAirplane
 * @property {boolean} skipBuild
 * @property {boolean} dryRun
 * @property {boolean} help
 */

/**
 * What one row reported from the phone.
 * @typedef {object} ObservedRow
 * @property {string} status
 * @property {string} [notes]
 */

/**
 * @typedef {object} DrillEvidence
 * @property {Record<string, unknown>} trees
 * @property {Record<string, ObservedRow>} rows
 * @property {{ step: string, outcome: string }[]} steps
 * @property {string[]} errors
 */

/**
 * @typedef {object} DrillFacts
 * @property {string} subject
 * @property {boolean} [candidateInstalled]
 * @property {boolean} [runnerInstalled]
 * @property {number | null} [installedBuildNumber]
 * @property {boolean} [settingsRestored]
 * @property {string[]} [settingsUnrestored]
 */

/**
 * What the run itself proved about the phone, as opposed to what it requested.
 * @typedef {object} DerivedFacts
 * @property {boolean} runnerInstalled
 * @property {boolean} settingsRestored
 * @property {string[]} settingsTouched
 * @property {string[]} settingsUnrestored
 */

const here = dirname(fileURLToPath(import.meta.url));

/** @type {string} */
export const DRILL_ROOT = resolve(here, '..', 'ios-drill');

/** @type {string} */
export const REPO_ROOT = resolve(here, '..', '..', '..');

/**
 * The base64 chunk size `DrillChannel.chunkSize` emits with. Changing one
 * without the other silently truncates every captured tree.
 * @type {number}
 */
export const CHUNK_SIZE = 600;

/** @type {readonly string[]} */
export const CLI_FLAGS = Object.freeze([
  '--device',
  '--subject',
  '--out',
  '--rows',
  '--signing-donor',
  '--allow-airplane',
  '--skip-build',
  '--dry-run',
  '--help',
]);

/** @type {readonly string[]} */
const STATUSES = Object.freeze(['pass', 'partial', 'fail', 'not_executed']);

/**
 * `member-journeys` alone emits base64 JSON for more than thirty complete
 * accessibility trees, which is far past Node's 1 MiB default; a child killed
 * with ENOBUFS loses the row payload the harness just produced.
 * @type {number}
 */
const RAW_LOG_LIMIT = 256 * 1024 * 1024;

/**
 * The stamp the build writes into the derived-data directory so a later
 * `--skip-build` run cannot file commit B's evidence from commit A's runner.
 * @type {string}
 */
export const BUILD_STAMP = 'ug-drill-subject.txt';

/** @type {string} */
const APP_PRODUCT = join('Build', 'Products', 'Release-iphoneos', 'UnionGround.app');

/**
 * @param {string} [root]
 * @returns {DrillManifest}
 */
export function loadManifest(root = DRILL_ROOT) {
  const manifest = /** @type {DrillManifest} */ (JSON.parse(readFileSync(join(root, 'row-manifest.json'), 'utf8')));
  // The drill drives the app the build installed: MOBILE_APPLICATION_ID when
  // set (apps/mobile/README.md, "Your own app identity"), else the manifest's
  // placeholder.
  /** @type {string} */
  const applicationId = String(process.env['MOBILE_APPLICATION_ID'] ?? '').trim();
  return applicationId ? { ...manifest, bundle_id: applicationId } : manifest;
}

/** @returns {string} */
export function usage() {
  return [
    'Usage: node apps/mobile/scripts/ios-device-drill.mjs --device <name> --subject <sha> --out <dir> [options]',
    '',
    '  --device <name>         paired iPhone exactly as `xcrun devicectl list devices` names it',
    '  --subject <sha>         the source commit the packages and the runner are both built from',
    '  --out <dir>             evidence directory to create',
    '  --rows <a,b,c>          restrict the run to these matrix rows (default: every executable row)',
    '  --signing-donor <path>  a previously device-signed runner whose profile this build reuses',
    '  --allow-airplane        permit the offline row to switch the radios (USB-attached runs only)',
    '  --skip-build            reuse the runner already built in <out>/derived',
    '  --dry-run               print the plan and exit without touching the Mac or the phone',
    '  --help                  print this text',
  ].join('\n');
}

/**
 * The executable rows enter offline PREVIEW. app.config.ts validates the
 * selected profile's exact SaaS backend and publishable key during prebuild.
 * @param {Record<string, string | undefined>} environment
 * @returns {void}
 */
export function verifyOfflinePreviewProfile(environment) {
  if (environment.EAS_BUILD_PROFILE !== 'unionground-preview'
    || (environment.MOBILE_RELEASE_ENV && environment.MOBILE_RELEASE_ENV !== 'preview')) {
    throw new Error('The offline PREVIEW drill requires EAS_BUILD_PROFILE=unionground-preview and MOBILE_RELEASE_ENV unset or preview. Supply the source-approved SaaS backend settings; SAMPLE profiles cannot run these rows.');
  }
}

/**
 * @param {string[]} argv
 * @param {DrillManifest} [manifest]
 * @returns {DrillOptions}
 */
export function parseArgs(argv, manifest = loadManifest()) {
  /** @type {DrillOptions} */
  const options = {
    device: '',
    subject: '',
    out: '',
    rows: [],
    signingDonor: '',
    allowAirplane: false,
    skipBuild: false,
    dryRun: false,
    help: false,
  };
  /** @type {string[]} */
  const executable = manifest.rows.filter((row) => row.test !== null).map((row) => row.case);
  for (let index = 0; index < argv.length; index += 1) {
    /** @type {string} */
    const flag = String(argv[index]);
    if (!CLI_FLAGS.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    /** @returns {string} */
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined || CLI_FLAGS.includes(value)) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === '--device') options.device = take();
    else if (flag === '--subject') options.subject = take();
    else if (flag === '--out') options.out = take();
    else if (flag === '--signing-donor') options.signingDonor = take();
    else if (flag === '--rows') options.rows = take().split(',').map((value) => value.trim()).filter(Boolean);
    else if (flag === '--allow-airplane') options.allowAirplane = true;
    else if (flag === '--skip-build') options.skipBuild = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else options.help = true;
  }
  if (options.help) return options;
  /** @type {[string, string][]} */
  const required = [['--device', options.device], ['--subject', options.subject], ['--out', options.out]];
  for (const [name, value] of required) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (!/^[0-9a-f]{40}$/u.test(options.subject)) throw new Error('--subject must be a full 40-character commit sha');
  const unknown = options.rows.filter((row) => !executable.includes(row));
  if (unknown.length > 0) throw new Error(`Not an executable drill row: ${unknown.join(', ')}`);
  // A row driven twice would let its first restoration vouch for a second run
  // that never put the phone back; each row runs once per drill.
  const repeated = options.rows.filter((row, index) => options.rows.indexOf(row) !== index);
  if (repeated.length > 0) throw new Error(`Duplicate drill row: ${[...new Set(repeated)].join(', ')}`);
  if (options.rows.length === 0) options.rows = executable;
  return options;
}

/**
 * Reassemble what the runner logged. `DrillChannel` emits every payload as
 * `UGD|<kind>|<key>|<index>|<total>|<base64>`, because os_log truncates long
 * lines; a chunk set that is short, duplicated or undecodable is reported
 * rather than silently dropped.
 * @param {string} rawLog
 * @returns {DrillEvidence}
 */
export function extractEvidence(rawLog) {
  /** @type {Map<string, { kind: string, key: string, total: number, parts: Map<number, string>, invalid: boolean }>} */
  const chunks = new Map();
  /** @type {{ step: string, outcome: string }[]} */
  const steps = [];
  /** @type {string[]} */
  const errors = [];
  for (const line of String(rawLog).split(/\r?\n/u)) {
    const payload = line.match(/UGD\|(TREE|ROW)\|([^|]+)\|(\d+)\|(\d+)\|(.*)$/u);
    if (payload) {
      const kind = String(payload[1]);
      const key = String(payload[2]);
      const index = Number(payload[3]);
      const total = Number(payload[4]);
      const id = `${kind}:${key}`;
      const entry = chunks.get(id) ?? { kind, key, total, parts: new Map(), invalid: false };
      const body = String(payload[5]);
      if (entry.total !== total) { errors.push(`${id}: inconsistent chunk total`); entry.invalid = true; }
      // Indices are zero-based and bounded by the declared total; an exact
      // retransmission of a chunk is harmless, a different payload under the
      // same index is two observations claiming one slot, and neither may be
      // resolved by whichever line came last.
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        errors.push(`${id}: chunk index ${index} outside 0..${total - 1}`);
        entry.invalid = true;
      } else if (entry.parts.has(index) && entry.parts.get(index) !== body) {
        errors.push(`${id}: conflicting chunk ${index}`);
        entry.invalid = true;
      } else {
        entry.parts.set(index, body);
      }
      chunks.set(id, entry);
      continue;
    }
    const stepLine = line.match(/UGD\|STEP\|([^|]+)\|(.*)$/u);
    if (stepLine) steps.push({ step: String(stepLine[1]), outcome: String(stepLine[2]) });
    const errorLine = line.match(/UGD\|ERROR\|([^|]+)\|(.*)$/u);
    if (errorLine) errors.push(`${errorLine[1]}: ${errorLine[2]}`);
  }
  /** @type {Record<string, unknown>} */
  const trees = {};
  /** @type {Record<string, ObservedRow>} */
  const rows = {};
  for (const entry of chunks.values()) {
    if (entry.invalid) continue;
    const missing = [];
    for (let index = 0; index < entry.total; index += 1) if (!entry.parts.has(index)) missing.push(index);
    if (missing.length > 0) {
      errors.push(`${entry.kind}:${entry.key}: ${entry.parts.size} of ${entry.total} chunks (missing ${missing.join(', ')})`);
      continue;
    }
    const ordered = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).map((pair) => pair[1]);
    /** @type {unknown} */
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(ordered.join(''), 'base64').toString('utf8'));
    } catch {
      errors.push(`${entry.kind}:${entry.key}: payload did not decode`);
      continue;
    }
    if (entry.kind === 'TREE') trees[entry.key] = decoded;
    else rows[entry.key] = /** @type {ObservedRow} */ (decoded);
  }
  return { trees, rows, steps, errors };
}

/**
 * Read `xcrun devicectl device info apps --json-output` back. The install is a
 * device fact, so the runner states it only from the device's own answer.
 * @param {string} payload
 * @param {string} bundleId
 * @returns {{ installed: boolean, version: string | null, buildNumber: number | null }}
 */
export function installedAppFacts(payload, bundleId) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { installed: false, version: null, buildNumber: null };
  }
  const result = /** @type {{ result?: { apps?: unknown[] } }} */ (parsed).result ?? {};
  const apps = Array.isArray(result.apps) ? result.apps : [];
  const app = /** @type {{ bundleIdentifier?: string, version?: string, bundleVersion?: string } | undefined} */ (
    apps.find((entry) => /** @type {{ bundleIdentifier?: string }} */ (entry)?.bundleIdentifier === bundleId)
  );
  if (!app) return { installed: false, version: null, buildNumber: null };
  const build = Number.parseInt(String(app.bundleVersion ?? ''), 10);
  return {
    installed: true,
    version: app.version ?? null,
    buildNumber: Number.isFinite(build) ? build : null,
  };
}

/**
 * Authorisation the test process reads with `ProcessInfo.processInfo.environment`
 * has to be serialised into the `.xctestrun`; the host `xcodebuild` environment
 * does not reach a process launched on the phone. This mirrors the working
 * device harness in
 * which writes both collections.
 * @param {string} target
 * @param {Record<string, string>} values
 * @returns {{ deletes: string[][], adds: string[][] }}
 */
export function xctestrunEnvArguments(target, values) {
  /** @type {string[][]} */
  const deletes = [];
  /** @type {string[][]} */
  const adds = [];
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`Unsafe xctestrun variable name: ${name}`);
    if (!/^[A-Za-z0-9_.:@/-]*$/u.test(value)) throw new Error(`Unsafe xctestrun value for ${name}`);
    for (const collection of ['EnvironmentVariables', 'TestingEnvironmentVariables']) {
      deletes.push(['-c', `Delete :${target}:${collection}:${name}`]);
      adds.push(['-c', `Add :${target}:${collection}:${name} string ${value}`]);
    }
  }
  return { deletes, adds };
}

/**
 * A reused `<out>/derived` carries the commit it was built from. `--skip-build`
 * at a different head would otherwise file this subject's evidence from another
 * commit's test code.
 * @param {string} stamp the stamp file's contents, or '' when it is absent
 * @param {string} subject
 * @returns {void}
 */
export function verifyBuildStamp(stamp, subject) {
  const built = String(stamp).trim();
  if (!built) {
    throw new Error('--skip-build needs a runner this recipe built: no subject stamp in <out>/derived. Build once without --skip-build.');
  }
  if (built !== subject) {
    throw new Error(`The runner in <out>/derived was built from ${built}, not the declared subject ${subject}. Rebuild without --skip-build.`);
  }
}

/**
 * Accept a row's own verdict only when the run that produced it is sound. A
 * nonzero `xcodebuild` exit means XCTest recorded at least one failure even
 * though `continueAfterFailure` let the row reach `finish`, and an extraction
 * error means part of the supporting evidence never arrived whole. Neither may
 * certify a `pass`; the reported payload is kept, annotated and downgraded.
 * @param {{ reported?: ObservedRow, evidenceErrors?: string[], commandFailed?: boolean }} input
 * @returns {ObservedRow | undefined}
 */
export function acceptRowVerdict({ reported, evidenceErrors = [], commandFailed = false }) {
  if (!reported) return undefined;
  /** @type {string[]} */
  const reasons = [];
  if (commandFailed) reasons.push('the xcodebuild invocation exited nonzero, so XCTest recorded at least one failure in this run');
  if (evidenceErrors.length > 0) reasons.push(`evidence extraction reported ${evidenceErrors.length} problem(s): ${evidenceErrors.join('; ')}`);
  if (reasons.length === 0) return reported;
  const status = reported.status === 'pass' ? 'partial' : reported.status;
  const notes = [reported.notes ?? '', `Verdict held to "${status}" from the reported "${reported.status}": ${reasons.join('. ')}.`]
    .filter(Boolean)
    .join(' ');
  return { ...reported, status, notes };
}

/**
 * The evidence file a row that this run did not execute still gets, so that no
 * `evidence` path published in `operator-result.json` dangles.
 * @param {DrillRow} row
 * @returns {{ case: string, trees: Record<string, unknown>, rows: Record<string, ObservedRow>, steps: never[], errors: never[], not_executed: string }}
 */
export function stubEvidence(row) {
  return {
    case: row.case,
    trees: {},
    rows: {},
    steps: [],
    errors: [],
    not_executed: row.class === 'gated'
      ? `Held on an independent gate (${row.gate}); this runner did not attempt it.`
      : 'This row was not selected for this run.',
  };
}

/**
 * Facts the run observed rather than assumed: the runner only counts as
 * installed once a test process actually spoke from the phone, and a setting is
 * only restored once the row said so.
 * @param {DrillEvidence[]} evidences
 * @returns {DerivedFacts}
 */
export function deriveFacts(evidences) {
  /** @type {Set<string>} */
  const touched = new Set();
  // Replayed in the order the phone reported them: a setting is restored only
  // if its LAST recorded transition put it back to its original value. A
  // restoration followed by another touch, or a restoration the runner could
  // not complete, leaves the setting unrestored.
  /** @type {Set<string>} */
  const pending = new Set();
  let spoke = false;
  for (const evidence of evidences) {
    if (evidence.steps.length > 0 || Object.keys(evidence.rows).length > 0) spoke = true;
    for (const { step, outcome } of evidence.steps) {
      // A mutation is pending from the moment it is injected; only a confirmed
      // restoration clears it. An unproven readback or a failed restoration
      // leaves it pending, and so unrestored.
      if (step === 'settings-pending' || step === 'settings-unproven' || step === 'settings-touched' || step === 'settings-restore-failed') {
        touched.add(outcome); pending.add(outcome);
      } else if (step === 'settings-restored') pending.delete(outcome);
    }
  }
  const unrestored = [...pending].sort();
  return {
    runnerInstalled: spoke,
    settingsRestored: unrestored.length === 0,
    settingsTouched: [...touched].sort(),
    settingsUnrestored: unrestored,
  };
}

/**
 * Shape the run into the per-row record the Android half files, covering every
 * row the 2026-09-06 matrix blocked on the UI channel. A row the runner did not
 * observe stays `not_executed` with the reason that still holds it; no verdict
 * is ever carried across from the Android matrix.
 * @param {{ manifest: DrillManifest, observed: Record<string, ObservedRow>, facts: DrillFacts }} input
 */
export function buildOperatorResult({ manifest, observed, facts }) {
  const rows = manifest.rows.map((row) => {
    const seen = observed[row.case];
    if (row.class === 'gated') {
      return {
        case: row.case,
        package: 'candidate',
        status: 'not_executed',
        evidence: row.evidence,
        notes: `Not this runner's row: the committed matrix holds it on an independent gate (${row.gate}) as well as the UI channel. The runner exists, the gate does not clear.`,
      };
    }
    if (!seen) {
      return {
        case: row.case,
        package: 'candidate',
        status: 'not_executed',
        evidence: row.evidence,
        notes: 'The runner did not report this row in this run.',
      };
    }
    if (!STATUSES.includes(seen.status)) throw new Error(`${row.case}: unknown status ${seen.status}`);
    return {
      case: row.case,
      package: 'candidate',
      status: seen.status,
      evidence: row.evidence,
      notes: seen.notes ?? '',
    };
  });
  return {
    record: manifest.record,
    subject_sha: facts.subject,
    bundle_id: manifest.bundle_id,
    candidate_installed: Boolean(facts.candidateInstalled),
    runner_installed: Boolean(facts.runnerInstalled),
    installed_build_number: facts.installedBuildNumber ?? null,
    settings_restored: Boolean(facts.settingsRestored),
    settings_unrestored: facts.settingsUnrestored ?? [],
    rows,
  };
}

/**
 * @param {DrillOptions} options
 * @param {DrillManifest} manifest
 */
export function plan(options, manifest) {
  const tests = manifest.rows
    .filter((row) => options.rows.includes(row.case))
    .map((row) => `${manifest.test_target}/${manifest.test_class}/${String(row.test)}`);
  return {
    subject: options.subject,
    device: options.device,
    out: options.out,
    project: join(DRILL_ROOT, 'UnionGroundDrill.xcodeproj'),
    rows: options.rows,
    tests,
    airplaneAuthorised: options.allowAirplane,
    buildProfile: 'unionground-preview',
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function sh(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** @param {DrillOptions} options */
function run(options) {
  verifyOfflinePreviewProfile(process.env);
  const manifest = loadManifest();
  const steps = plan(options, manifest);
  const out = resolve(options.out);
  mkdirSync(join(out, 'logs'), { recursive: true });
  mkdirSync(join(out, 'rows'), { recursive: true });

  const head = sh('git', ['rev-parse', 'HEAD'], REPO_ROOT).trim();
  if (head !== options.subject) throw new Error(`Worktree is at ${head}, not the declared subject ${options.subject}`);
  if (sh('git', ['status', '--porcelain'], REPO_ROOT).trim() !== '') {
    throw new Error('The drill subject must be a clean checkout');
  }

  const mobile = join(REPO_ROOT, 'apps', 'mobile');
  const derived = join(out, 'derived');
  const stamp = join(derived, BUILD_STAMP);
  const appPath = join(out, 'app-derived', APP_PRODUCT);
  if (!options.skipBuild) {
    if (!options.signingDonor) {
      throw new Error('--signing-donor is required: the runner must be re-signed for the paired phone. See docs/mobile/ios-xcuitest-drill-runner.md');
    }
    // The packages under test and the runner must come from this same commit.
    sh('npx', ['--no-install', 'expo', 'prebuild', '--platform', 'ios', '--clean'], mobile);
    sh('xcodebuild', [
      '-workspace', join(mobile, 'ios', 'UnionGround.xcworkspace'),
      '-scheme', 'Union Ground', '-configuration', 'Release',
      '-destination', `platform=iOS,name=${options.device}`,
      '-derivedDataPath', join(out, 'app-derived'), 'build',
    ]);
    sh('xcodebuild', [
      '-project', steps.project, '-scheme', 'UnionGroundDrill',
      '-destination', 'generic/platform=iOS', '-derivedDataPath', derived,
      'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build-for-testing',
    ]);
    sh('bash', [join(DRILL_ROOT, 'sign-runner.sh'), derived, options.signingDonor, options.device]);
    writeFileSync(stamp, `${options.subject}\n`);
  } else {
    verifyBuildStamp(existsSync(stamp) ? readFileSync(stamp, 'utf8') : '', options.subject);
  }

  // Building the candidate is not installing it. Without this the rows would
  // drive whatever older copy the phone already carries, exactly as
  // `apps/mobile/IOS_DEVICE_RUNBOOK.md` warns; the install is then read back
  // from the device rather than assumed.
  if (!existsSync(appPath)) {
    throw new Error(`No candidate application at ${appPath}. Build it in this --out directory before running the rows.`);
  }
  sh('xcrun', ['devicectl', 'device', 'install', 'app', '--device', options.device, appPath]);
  const infoPath = join(out, 'logs', 'installed-app.json');
  sh('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', options.device,
    '--bundle-id', manifest.bundle_id, '--json-output', infoPath]);
  const installed = installedAppFacts(readFileSync(infoPath, 'utf8'), manifest.bundle_id);
  if (!installed.installed) {
    throw new Error(`${manifest.bundle_id} is not installed on ${options.device} after the install step; the rows would drive a stale app.`);
  }
  process.stdout.write(`INSTALLED\t${manifest.bundle_id}\t${installed.version ?? '?'}\t${installed.buildNumber ?? '?'}\n`);

  const xctestrun = join(derived, 'Build', 'Products', 'ios-device-drill.xctestrun');
  // The phone's test process does not inherit this host process's environment.
  const env = xctestrunEnvArguments(manifest.test_target, {
    PSG_DRILL_ALLOW_AIRPLANE: options.allowAirplane ? '1' : '0',
    PSG_DRILL_BUNDLE_ID: manifest.bundle_id,
    PSG_DRILL_URL_SCHEME: manifest.url_scheme,
  });
  for (const args of env.deletes) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', [...args, xctestrun], { stdio: 'ignore' });
    } catch {
      // Deleting a key that is not there yet is the ordinary first-run case.
    }
  }
  for (const args of env.adds) sh('/usr/libexec/PlistBuddy', [...args, xctestrun]);

  /** @type {Record<string, ObservedRow>} */
  const observed = {};
  /** @type {DrillEvidence[]} */
  const evidences = [];
  /** @type {Set<string>} */
  const filed = new Set();
  for (const name of options.rows) {
    const entry = manifest.rows.find((candidate) => candidate.case === name);
    if (!entry || entry.test === null) throw new Error(`${name} has no runner test`);
    const bundle = join(out, 'logs', `${name}.xcresult`);
    // `xcodebuild` refuses to overwrite a result bundle, which would turn a
    // retry of the same row into a swallowed failure.
    rmSync(bundle, { recursive: true, force: true });
    const args = [
      '-xctestrun', xctestrun,
      '-destination', `platform=iOS,name=${options.device}`,
      '-resultBundlePath', bundle,
      `-only-testing:${manifest.test_target}/${manifest.test_class}/${entry.test}`,
      'test-without-building',
    ];
    /** @type {string} */
    let raw;
    /** @type {boolean} */
    let commandFailed = false;
    try {
      raw = execFileSync('xcodebuild', args, { encoding: 'utf8', maxBuffer: RAW_LOG_LIMIT });
    } catch (failure) {
      // A row that fails on the phone still carries its evidence on the log,
      // but the nonzero exit travels with it.
      commandFailed = true;
      const detail = /** @type {{ stdout?: string, stderr?: string }} */ (failure);
      raw = `${detail.stdout ?? ''}${detail.stderr ?? ''}`;
    }
    writeFileSync(join(out, 'logs', `${name}.raw.log`), raw);
    const evidence = extractEvidence(raw);
    evidences.push(evidence);
    writeFileSync(join(out, entry.evidence), `${JSON.stringify({ ...evidence, command_failed: commandFailed }, null, 2)}\n`);
    filed.add(name);
    const accepted = acceptRowVerdict({ reported: evidence.rows[name], evidenceErrors: evidence.errors, commandFailed });
    if (accepted) observed[name] = accepted;
    process.stdout.write(`${name}\t${accepted ? accepted.status : 'not_executed'}\n`);
  }

  // Every row of the result names an evidence path. A row this run did not
  // execute still gets that file, so no published reference dangles.
  for (const row of manifest.rows) {
    if (filed.has(row.case)) continue;
    writeFileSync(join(out, row.evidence), `${JSON.stringify(stubEvidence(row), null, 2)}\n`);
  }

  const derivedFacts = deriveFacts(evidences);
  const result = buildOperatorResult({
    manifest,
    observed,
    facts: {
      subject: options.subject,
      candidateInstalled: true,
      runnerInstalled: derivedFacts.runnerInstalled,
      installedBuildNumber: installed.buildNumber,
      settingsRestored: derivedFacts.settingsRestored,
      settingsUnrestored: derivedFacts.settingsUnrestored,
    },
  });
  writeFileSync(join(out, 'operator-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (derivedFacts.settingsUnrestored.length > 0) {
    process.stderr.write(`SETTINGS_NOT_RESTORED\t${derivedFacts.settingsUnrestored.join(',')}\n`);
  }
  process.stdout.write(`EVIDENCE_DIR\t${out}\n`);
}

/** @param {string[]} [argv] */
export function main(argv = process.argv.slice(2)) {
  const manifest = loadManifest();
  const options = parseArgs(argv, manifest);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan(options, manifest), null, 2)}\n`);
    return;
  }
  run(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (failure) {
    const detail = /** @type {{ message?: string }} */ (failure);
    process.stderr.write(`${detail.message ?? String(failure)}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}
