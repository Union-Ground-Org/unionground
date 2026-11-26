#!/usr/bin/env node
// Continuous security lane runner.
//
//   node scripts/run-security-scan.mjs semgrep|gitleaks|gitleaks-history|trivy|all
//   node scripts/run-security-scan.mjs self-test
//
// Every scanner runs from its exact pinned image digest, its JSON report is
// normalized, and `config/security-scanner-policy.json` decides what blocks.
// Reports stay in memory: nothing that could carry a detected value is written
// to disk or to the log. The printed summary carries locations, rule
// identifiers and severities only.
//
// `self-test` proves the gate on synthetic fixtures before the gate is trusted:
// each scanner must report its own fixture, and must not report the safe one.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NORMALIZERS,
  POLICY_PATH,
  REPOSITORY_ROOT,
  applyPolicy,
  formatFinding,
  loadPolicy,
  validatePolicy,
} from "./lib/security-scanner-policy.mjs";

const FIXTURE_ROOT = "tests/fixtures/security-scanners";
const MAX_HISTORY_REFS = 2048;

export function captureHistorySnapshot(policy, { root = REPOSITORY_ROOT, expectedSourceSha = process.env.GITHUB_SHA } = {}) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let source, refs;
  try {
    source = git(["rev-parse", "HEAD"]);
    refs = git(["for-each-ref", "--sort=refname", "--format=%(refname)%09%(objectname)"])
      .split("\n").filter(Boolean).map(row => row.split("\t"));
  } catch { throw new Error("history source snapshot could not be captured within its bounds"); }
  if (!/^[a-f0-9]{40}$/.test(source) || (expectedSourceSha && expectedSourceSha !== source)
      || refs.length > MAX_HISTORY_REFS || refs.some(row => row.length !== 2 || !row[0].startsWith("refs/") || row[0].length > 512 || !/^[a-f0-9]{40}$/.test(row[1]))) {
    throw new Error("history source snapshot differs from its expected commit or exceeds its bounds");
  }
  return { schema: 1, policy_source_sha: source, history_commit_budget: policy.scanners.gitleaks.history_commit_budget, refs: [["HEAD", source], ...refs] };
}

function runHistory(policy) {
  const snapshot = captureHistorySnapshot(policy);
  const bytes = `${JSON.stringify(snapshot)}\n`;
  // Ref names and immutable object IDs only; never scanner findings or values.
  if (process.env.SECURITY_HISTORY_SNAPSHOT_FILE) writeFileSync(process.env.SECURITY_HISTORY_SNAPSHOT_FILE, bytes, { mode: 0o600 });
  console.log(`history source snapshot: ${createHash("sha256").update(bytes).digest("hex")}; policy ${snapshot.policy_source_sha}; ${snapshot.refs.length} roots`);
  return parseJson("gitleaks", runDocker(gitleaksArguments(policy, { history: true, historySnapshot: snapshot }), { label: "gitleaks" }));
}

// Every scanner runs with its output piped, never a TTY, and is asked for
// plain text: a colored or decorated stderr is withheld whole by the failure
// diagnostic, which never strips terminal sequences.
const SCANNER_PLAIN_OUTPUT_ENV = Object.freeze(["--env", "NO_COLOR=1", "--env", "TERM=dumb"]);

function imageReference(scanner) {
  return `${scanner.image}@${scanner.digest}`;
}

const DIAGNOSTIC_TAIL_LINES = 20;
const DIAGNOSTIC_LINE_CHARS = 300;
// Exit statuses docker itself assigns, so the log says which layer failed.
const DOCKER_EXIT_HINTS = Object.freeze({
  125: "docker could not create or start the container: image pull, registry or daemon error",
  126: "the scanner entrypoint could not be invoked",
  127: "the scanner entrypoint was not found",
  137: "the container was killed: SIGKILL, usually out of memory or a cancelled runner",
  143: "the container was terminated: SIGTERM",
});
// Diagnostics read at most this many bytes of stderr; a longer stderr is
// withheld whole and only its lines are counted.
const DIAGNOSTIC_INPUT_BYTES = 1024 * 1024;
// Nothing is decoded, normalized or stripped. One pass over the bounded input
// decides, and any of the following withholds the whole excerpt from both the
// job log and the step summary: a character outside printable ASCII, tab and
// line feed (escape and every other control, DEL, C1 codes, all non-ASCII);
// an escape spelling a reader or parser could decode into other characters;
// URL user information; or a secret-key word. Words are matched on the letters alone, case folded,
// so separators, digits, quoting and line breaks inside or around a word
// cannot hide it. False positives only cost the excerpt.
const DIAGNOSTIC_SECRET_WORDS = Object.freeze([
  "password", "passwd", "passphrase", "secret", "token", "apikey",
  "accesskey", "privatekey", "credential", "authorization", "bearer",
]);
// pwd names a credential only as a key (DB_PWD=, "pwd": ), so a scanner's
// own advice such as "safe.directory $(pwd)" still prints. Any run of
// spaces, tabs, line feeds or quotes may sit between the key and its = or :.
// The last 16 letters seen, enough for the longest word; each word is checked
// only when its final letter arrives.
const DIAGNOSTIC_WORD_WINDOW = 16;
const DIAGNOSTIC_WORDS_BY_FINAL_LETTER = DIAGNOSTIC_SECRET_WORDS.reduce((byFinal, word) => {
  const codes = [...word].map((letter) => letter.charCodeAt(0));
  byFinal[codes.at(-1)] = [...(byFinal[codes.at(-1)] ?? []), codes];
  return byFinal;
}, []);
const WITHHELD_REASONS = Object.freeze({
  bound: `it exceeds the ${DIAGNOSTIC_INPUT_BYTES}-byte diagnostic bound`,
  character: "it holds a character outside plain printable ASCII",
  escape: "it holds an escape spelling",
  url: "it holds URL user information",
  word: "it names a credential",
});
// Credential shapes that carry no secret-key word are masked in place on the
// plain ASCII that passed the checks above. Every pattern either consumes the
// run it scans or fails within a fixed number of characters, and a JWT starts
// only at the beginning of its run, so each replacement runs in linear time.
const DIAGNOSTIC_REDACTIONS = Object.freeze([
  [/\b(?:gh[pousr]_|github_pat_|npm_|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, "[redacted-token]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  // Whatever follows Basic, at any length (a Bearer withholds as a word).
  [/\b(Basic)\b[\s:="']+\S+/gi, "$1 [redacted]"],
  // Any other long run mixing letters and digits is treated as a credential.
  [/[A-Za-z0-9+=_-]+/g, (run) => (run.length >= 24 && /[0-9]/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run)],
]);

function isAsciiLetter(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiLetterOrDigit(code) {
  return (code >= 0x30 && code <= 0x39) || isAsciiLetter(code);
}

function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

// Whether text at index (a backslash, '&' or '%') begins an escape spelling.
// Reads at most two characters ahead.
function escapeSpellingAt(text, index) {
  const code = text.charCodeAt(index);
  const next = text.charCodeAt(index + 1);
  // \u \U \x \N, octal and every other backslash-letter or -digit form
  // (\o{...}, \c, \e), a superset of what any language decodes, and a line
  // continuation, which can join an escape across the break.
  if (code === 0x5c) return isAsciiLetterOrDigit(next) || next === 0x0a;
  // &#119; &#x77; and every named reference, with or without its semicolon
  // (HTML decodes legacy &shy without one).
  if (code === 0x26) return next === 0x23 || isAsciiLetter(next);
  // Every percent escape, punctuation included (%2D spells '-' and splits a
  // word), and %u0077.
  if (code === 0x25) return (hexValue(next) >= 0 || (next | 0x20) === 0x75) && hexValue(text.charCodeAt(index + 2)) >= 0;
  return false;
}

// Whether the URL starting with "://" at index carries user information: an
// '@' before its authority ends at '/', '?' or '#', whitespace and line breaks
// included (https://u:<TAB>value@host), and an '@' anywhere in the rest of
// its whitespace-free run, so an empty user, a user alone and any lenient
// parse are all caught. Returns where the scan stopped so a later "://" it
// already covered is not rescanned.
function urlRunAt(text, index) {
  let end = index + 3;
  let authorityEnded = false;
  let userInfo = false;
  for (; end < text.length; end += 1) {
    const code = text.charCodeAt(end);
    if (code <= 0x20 && authorityEnded) break;
    if (code === 0x2f || code === 0x3f || code === 0x23) authorityEnded = true;
    else if (code === 0x40) userInfo = true;
  }
  return { end, userInfo };
}

// Whether the '=' or ':' at index follows "pwd", in any case, as a key. The
// walk back stops at the first character that is not a gap, and a gap run
// ends at the previous delimiter at the latest, so each character is walked
// at most once and the pass stays linear.
function pwdKeyBefore(text, index) {
  let end = index;
  while (end > 0 && " \t\n\"'".includes(text[end - 1])) end -= 1;
  return end >= 3 && text.slice(end - 3, end).toLowerCase() === "pwd";
}

function endsWithWord(window, seen, word) {
  if (seen < word.length) return false;
  for (let offset = 1; offset <= word.length; offset += 1) {
    if (window[(seen - offset) % DIAGNOSTIC_WORD_WINDOW] !== word[word.length - offset]) return false;
  }
  return true;
}

// One pass over bounded stderr: counts the nonblank lines and finds the first
// reason, if any, to withhold. After a reason is found it only counts lines.
function inspectStderr(text) {
  let lines = 0;
  let lineHasText = false;
  let reason = null;
  const window = new Uint8Array(DIAGNOSTIC_WORD_WINDOW);
  let seen = 0;
  let urlScannedTo = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      if (lineHasText) lines += 1;
      lineHasText = false;
      continue;
    }
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) lineHasText = true;
    if (reason !== null) continue;
    const lower = code | 0x20;
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
      reason = "character";
    } else if ((code === 0x5c || code === 0x26 || code === 0x25) && escapeSpellingAt(text, index)) {
      reason = "escape";
    } else if (code === 0x3a && index >= urlScannedTo && text.startsWith("//", index + 1)) {
      const url = urlRunAt(text, index);
      urlScannedTo = url.end;
      if (url.userInfo) reason = "url";
    } else if ((code === 0x3d || code === 0x3a) && pwdKeyBefore(text, index)) {
      reason = "word";
    } else if (lower >= 0x61 && lower <= 0x7a) {
      window[seen % DIAGNOSTIC_WORD_WINDOW] = lower;
      seen += 1;
      if (DIAGNOSTIC_WORDS_BY_FINAL_LETTER[lower]?.some((word) => endsWithWord(window, seen, word))) reason = "word";
    }
  }
  if (lineHasText) lines += 1;
  return { lines, reason };
}

// Over the bound nothing is inspected; only line feeds are counted.
function countLines(text) {
  let lines = 0;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    if (stop > start) lines += 1;
    start = stop + 1;
  }
  return lines;
}

function stderrExcerpt(stderr) {
  const { lines, reason } = Buffer.byteLength(stderr) > DIAGNOSTIC_INPUT_BYTES
    ? { lines: countLines(stderr), reason: "bound" }
    : inspectStderr(stderr);
  if (reason !== null) return { tail: [], withheld: `stderr withheld (${lines} line(s)): ${WITHHELD_REASONS[reason]}` };
  // Redact before splitting so a credential shape cannot straddle the tail.
  const redacted = DIAGNOSTIC_REDACTIONS.reduce((value, [pattern, replace]) => value.replace(pattern, replace), stderr);
  const tail = redacted.split("\n").map((line) => line.trimEnd()).filter(Boolean)
    .slice(-DIAGNOSTIC_TAIL_LINES)
    .map((line) => (line.length > DIAGNOSTIC_LINE_CHARS ? `${line.slice(0, DIAGNOSTIC_LINE_CHARS)}…` : line));
  return { tail, withheld: null };
}

/**
 * What a failed scanner run may say about itself: its exit status or signal
 * and a bounded, redacted tail of its stderr, where scanners write their fatal
 * error (a vulnerability-DB download failure, a registry rate limit). Never
 * stdout: that is the report, and it can carry detected values. A stderr that
 * is not plain printable ASCII, spells an escape, names a credential or
 * exceeds the input bound is withheld whole; the notice names only the reason
 * and the line count.
 */
export function scannerFailureDiagnostic(label, error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const signal = typeof error?.signal === "string" ? error.signal : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const facts = [
    status === null ? null : `exit ${status}`,
    signal && `signal ${signal}`,
    code && `error ${code}`,
  ].filter(Boolean);
  const hint = status === null ? null : DOCKER_EXIT_HINTS[status];
  const stderr = typeof error?.stderr === "string" || Buffer.isBuffer(error?.stderr) ? String(error.stderr) : "";
  return {
    headline: `${label} scanner failed: ${facts.join(", ") || "no exit status"}${hint ? ` (${hint})` : ""}`,
    ...stderrExcerpt(stderr),
  };
}

export function reportScannerFailure(
  { headline, tail, withheld = null },
  { log = console.error, summaryPath = process.env.GITHUB_STEP_SUMMARY } = {},
) {
  log(`::error title=Security scanner failed::${headline.replace(/%/g, "%25")}`);
  // The runner searches inside a line for legacy commands. Break both command
  // delimiters rather than relying on indentation to make stderr inert.
  const safeTail = tail.map((line) => line.replaceAll("##[", "# #[").replace(/:{2,}/g, (colons) => colons.split("").join(" ")));
  log(withheld ?? (tail.length ? `last ${tail.length} stderr line(s), redacted:` : "the scanner wrote nothing to stderr"));
  for (const line of safeTail) log(`  | ${line}`);
  if (!summaryPath) return;
  const block = withheld ? ["", withheld]
    : safeTail.length ? ["", "```text", ...safeTail.map((line) => line.replace(/`/g, "'")), "```"] : [];
  try {
    appendFileSync(summaryPath, ["### Security scanner failure", "", headline, ...block, ""].join("\n"));
  } catch {
    log("the step summary could not be written; the diagnostic above is complete");
  }
}

export function runDocker(args, { execute = execFileSync, label = null, report = reportScannerFailure } = {}) {
  let failure;
  try {
    return execute("docker", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failure = error;
  }
  // Findings use exit zero. Nonzero means an incomplete/failed scan. The
  // thrown error never carries child-process messages, stdout, stderr or
  // causes; the report says why from the exit status and a checked stderr tail.
  report(scannerFailureDiagnostic(label ?? "security", failure));
  throw new Error(`${label ? `${label} ` : ""}scanner execution failed; no complete report is trusted`);
}

export function parseJson(label, text) {
  const start = text.indexOf("{") === -1 ? text.indexOf("[") : Math.min(
    ...[text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0),
  );
  if (start < 0) throw new Error(`${label} produced no JSON report`);
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new Error(`${label} produced an unreadable JSON report`);
  }
}

export function semgrepArguments(
  policy,
  { target = null, ruleset = null, applyExclusions = true } = {},
) {
  const scanner = policy.scanners.semgrep;
  // The fixture proof targets an excluded directory on purpose, so the
  // self-test drops the production exclusions rather than fighting them.
  const excludes = applyExclusions
    ? (scanner.exclude ?? []).flatMap((entry) => ["--exclude", entry])
    : [];
  return [
    "run", "--rm", "--network", "none", ...SCANNER_PLAIN_OUTPUT_ENV,
    "--env", "SEMGREP_ENABLE_VERSION_CHECK=0",
    "--volume", `${REPOSITORY_ROOT}:/src:ro`,
    "--workdir", "/src",
    imageReference(scanner),
    "semgrep", "scan",
    "--config", ruleset ?? scanner.ruleset,
    "--metrics=off", "--json", "--quiet",
    // Semgrep's 5-second default per rule and file includes parsing, which
    // large delivery files can exceed on a loaded machine. A Timeout is still
    // a scan error that fails the lane; the reviewed policy only sets the bound.
    "--timeout", String(scanner.rule_timeout_seconds),
    ...excludes,
    ...(target === null ? (scanner.scan_paths ?? ["."]) : [target]),
  ];
}

/**
 * Directories the pull-request tree scan leaves out. Only a pull_request run
 * skips them: the merge group, Main push and manual runs scan the whole tree,
 * so no change merges without its retained evidence being read. Only
 * directories present in the checkout are returned, because each becomes a
 * mount point.
 */
export function gitleaksTreeExclusions(policy, { env = process.env, root = REPOSITORY_ROOT } = {}) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return [];
  return (policy.scanners.gitleaks.exclude ?? []).filter((entry) => {
    try {
      return lstatSync(resolve(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Reviewed gitleaks exceptions under a skipped directory cannot match in that
 * run, so they are not reported unused there; the full-tree scans still hold
 * them to account.
 */
export function unusedOutsideExclusions(unused, excludedDirectories) {
  return unused.filter((entry) => entry.scanner !== "gitleaks"
    || !excludedDirectories.some((directory) => entry.path.startsWith(`${directory}/`)));
}

export function gitleaksArguments(
  policy,
  { target = "/repo", history = false, historySnapshot = null, useRepositoryConfig = true, excludedDirectories = [] } = {},
) {
  const scanner = policy.scanners.gitleaks;
  // Gitleaks has no path-exclusion flag, so each skipped directory is masked
  // by an empty tmpfs. History reads Git objects and is never masked. Masks
  // are rooted at /repo, so a self-test fixture scan is never masked.
  const masks = history ? [] : excludedDirectories
    .flatMap((directory) => ["--mount", `type=tmpfs,destination=/repo/${directory}`]);
  const base = [
    "run", "--rm", "--network", "none", ...SCANNER_PLAIN_OUTPUT_ENV,
    "--volume", `${REPOSITORY_ROOT}:/repo:ro`,
    ...masks,
    "--workdir", "/repo",
    imageReference(scanner),
    "detect",
    // The banner is box-drawing art; color is requested off. The pinned
    // image still colors its log lines (October 28, 2026), so a gitleaks
    // failure's stderr stays withheld until upstream honors --no-color.
    "--no-banner", "--no-color",
    `--source=${target}`,
    "--exit-code", "0",
    "--report-format", "json",
    "--report-path", "/dev/stdout",
    // The repository configuration extends the upstream default ruleset and
    // allowlists only the scanner fixtures. The self-test deliberately omits
    // it so the fixture proof cannot be satisfied by the allowlist.
    ...(useRepositoryConfig ? ["--config=/repo/config/gitleaks.toml"] : []),
  ];
  if (history) {
    if (historySnapshot?.schema !== 1 || historySnapshot.history_commit_budget !== scanner.history_commit_budget
        || !/^[a-f0-9]{40}$/.test(historySnapshot.policy_source_sha ?? "")
        || !Array.isArray(historySnapshot.refs) || historySnapshot.refs.length < 1 || historySnapshot.refs.length > MAX_HISTORY_REFS + 1
        || historySnapshot.refs.some(row => !Array.isArray(row) || row.length !== 2 || !/^[a-f0-9]{40}$/.test(row[1]))) {
      throw new Error("history execution requires a bounded immutable ref snapshot");
    }
    const tips = [...new Set(historySnapshot.refs.map(row => row[1]))].sort();
    // Preserve all captured branch/tag coverage without re-resolving mutable
    // refs inside the scanner. The original global commit budget still applies.
    return [...base, `--log-opts=--max-count=${scanner.history_commit_budget} ${tips.join(" ")}`];
  }
  return [...base, "--no-git"];
}

export function trivyArguments(policy, { target = "/repo" } = {}) {
  const scanner = policy.scanners.trivy;
  const skips = (scanner.exclude ?? []).flatMap((entry) => ["--skip-dirs", entry]);
  return [
    "run", "--rm", ...SCANNER_PLAIN_OUTPUT_ENV,
    "--volume", `${REPOSITORY_ROOT}:/repo:ro`,
    "--workdir", "/repo",
    imageReference(scanner),
    "filesystem",
    "--scanners", (scanner.enabled_scanners ?? ["vuln"]).join(","),
    ...skips,
    "--format", "json",
    "--output", "/dev/stdout",
    "--quiet",
    target,
  ];
}

const LANES = Object.freeze({
  semgrep: (policy) => ({
    scanner: "semgrep",
    report: parseJson("semgrep", runDocker(semgrepArguments(policy), { label: "semgrep" })),
  }),
  gitleaks: (policy) => {
    const excludedDirectories = gitleaksTreeExclusions(policy);
    return {
      scanner: "gitleaks",
      excludedDirectories,
      report: parseJson("gitleaks", runDocker(gitleaksArguments(policy, { excludedDirectories }), { label: "gitleaks" })),
    };
  },
  "gitleaks-history": (policy) => ({
    scanner: "gitleaks",
    report: runHistory(policy),
  }),
  trivy: (policy) => ({
    scanner: "trivy",
    report: parseJson("trivy", runDocker(trivyArguments(policy), { label: "trivy" })),
  }),
});

function runLanes(policy, laneNames) {
  const findings = [];
  const scanners = new Set();
  const excludedDirectories = [];
  for (const name of laneNames) {
    const lane = LANES[name];
    if (!lane) throw new Error(`unknown security lane ${name}`);
    const { scanner, report, excludedDirectories: skipped = [] } = lane(policy);
    scanners.add(scanner);
    excludedDirectories.push(...skipped);
    if (skipped.length > 0) console.log(`${name}: pull-request scan skips ${skipped.join(", ")}`);
    findings.push(...NORMALIZERS[scanner](report));
    console.log(`${name}: report received`);
  }
  return { findings, scanners: [...scanners], excludedDirectories };
}

/**
 * The ERROR-severity rule identifiers of the reviewed ruleset, derived from
 * the ruleset file itself rather than a hard-coded list. Blocking fixture
 * coverage is asserted by rule id, so a blocking rule added to the ruleset
 * without an unsafe/safe fixture pair fails the self-test immediately.
 * @returns {string[]} blocking rule ids in ruleset order
 */
export function blockingSemgrepRuleIds(policy, { root = REPOSITORY_ROOT } = {}) {
  const rulesetPath = policy?.scanners?.semgrep?.ruleset;
  if (typeof rulesetPath !== "string" || rulesetPath.length === 0) {
    throw new Error("semgrep ruleset path is not configured");
  }
  let text;
  try {
    text = readFileSync(resolve(root, rulesetPath), "utf8");
  } catch {
    throw new Error("semgrep ruleset is unreadable");
  }
  // The security job runs before `npm ci`, so this reads the reviewed
  // ruleset's fixed layout (`  - id:` items, `    severity:` keys under a
  // top-level `rules:`) without a YAML dependency, and fails closed on drift.
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^rules:\s*$/.test(line));
  if (start === -1) throw new Error("semgrep ruleset carries no rules list");
  const rules = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const item = /^ {2}- id:\s*["']?([^"'\s#]*)["']?\s*(?:#.*)?$/.exec(line);
    if (item) {
      rules.push({ id: item[1], severity: null });
      continue;
    }
    if (/^ {2}-/.test(line)) throw new Error("semgrep ruleset carries a rule that does not start with its id");
    const severity = /^ {4}severity:\s*["']?(\w+)["']?\s*(?:#.*)?$/.exec(line);
    if (severity && rules.length > 0) rules[rules.length - 1].severity = severity[1];
  }
  const ids = [];
  for (const rule of rules) {
    if (rule.severity === null) throw new Error(`semgrep ruleset rule ${rule.id || "without an id"} carries no severity`);
    if (rule.severity.toUpperCase() !== "ERROR") continue;
    if (rule.id.length === 0) throw new Error("semgrep ruleset carries a blocking rule without an id");
    if (ids.includes(rule.id)) throw new Error(`semgrep ruleset duplicates blocking rule id ${rule.id}`);
    ids.push(rule.id);
  }
  if (ids.length === 0) throw new Error("semgrep ruleset has no blocking rules");
  return ids;
}

/**
 * Blocking rule identifiers that produced no finding on the unsafe fixtures.
 * An empty result proves every blocking rule fires on its fixture.
 */
export function uncoveredBlockingRules(blockingRuleIds, unsafeFindings) {
  const reported = new Set(unsafeFindings.map((finding) => finding.identifier));
  return blockingRuleIds.filter((ruleId) => !reported.has(ruleId));
}


function selfTest(policy) {
  const problems = [];
  const fixtureRoot = resolve(REPOSITORY_ROOT, FIXTURE_ROOT);
  if (!existsSync(fixtureRoot)) {
    return [`${FIXTURE_ROOT} is missing; the gate cannot be proven`];
  }

  const semgrepReport = parseJson("semgrep", runDocker(semgrepArguments(policy, {
    target: `${FIXTURE_ROOT}/semgrep`,
    ruleset: policy.scanners.semgrep.ruleset,
    applyExclusions: false,
  }), { label: "semgrep" }));
  const semgrepFindings = NORMALIZERS.semgrep(semgrepReport);
  const semgrepUnsafe = semgrepFindings.filter((finding) => finding.path.includes("/unsafe/"));
  const semgrepSafe = semgrepFindings.filter((finding) => finding.path.includes("/safe/"));
  const blockingRuleIds = blockingSemgrepRuleIds(policy);
  const uncoveredRuleIds = uncoveredBlockingRules(blockingRuleIds, semgrepUnsafe);
  for (const ruleId of uncoveredRuleIds) {
    problems.push(`semgrep rule ${ruleId} produced no finding on its unsafe fixture; add a reviewed unsafe/safe fixture pair`);
  }
  if (semgrepSafe.length > 0) problems.push("semgrep reported its safe fixture");
  const jwtUnsafe = semgrepUnsafe.filter(finding =>
    finding.path.endsWith("/api/jwt-options.js")
      && finding.identifier === "unionground-jwt-verify-without-algorithms");
  if (jwtUnsafe.length !== 4) problems.push("semgrep did not detect all four JWT verification call shapes");

  const gitleaksReport = parseJson("gitleaks", runDocker(gitleaksArguments(policy, {
    target: `/repo/${FIXTURE_ROOT}/gitleaks`,
    useRepositoryConfig: false,
  }), { label: "gitleaks" }));
  const gitleaksFindings = NORMALIZERS.gitleaks(gitleaksReport);
  const gitleaksUnsafe = gitleaksFindings.filter((finding) => finding.path.includes("/unsafe/"));
  const gitleaksSafe = gitleaksFindings.filter((finding) => finding.path.includes("/safe/"));
  if (gitleaksUnsafe.length === 0) problems.push("gitleaks did not report its unsafe fixture");
  if (gitleaksSafe.length > 0) problems.push("gitleaks reported its safe fixture");


  const trivyReport = parseJson("trivy", runDocker(trivyArguments(policy, {
    target: `/repo/${FIXTURE_ROOT}/trivy`,
  }), { label: "trivy" }));
  const trivyFindings = NORMALIZERS.trivy(trivyReport);
  const trivyBlocking = trivyFindings.filter((finding) =>
    policy.scanners.trivy.blocking_severities.includes(finding.severity));
  if (trivyBlocking.length === 0) {
    problems.push("trivy did not report a blocking vulnerability in its fixture");
  }

  console.log(
    `self-test: semgrep ${semgrepUnsafe.length} unsafe / ${semgrepSafe.length} safe covering `
      + `${blockingRuleIds.length - uncoveredRuleIds.length}/${blockingRuleIds.length} blocking rules, `
      + `gitleaks ${gitleaksUnsafe.length} unsafe / ${gitleaksSafe.length} safe, `
      + `trivy ${trivyBlocking.length} blocking`,
  );
  return problems;
}

function main() {
  const requested = process.argv[2] ?? "all";
  let policy;
  try {
    policy = loadPolicy();
  } catch (error) {
    console.error(`SECURITY_SCAN_FAIL: ${POLICY_PATH} is unreadable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const policyProblems = validatePolicy(policy);
  if (policyProblems.length > 0) {
    console.error("SECURITY_SCAN_FAIL: the reviewed scanner policy is invalid");
    for (const problem of policyProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (requested === "self-test") {
    let problems;
    try {
      problems = selfTest(policy);
    } catch (error) {
      console.error(`SECURITY_SCAN_FAIL: the fixture proof could not run: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (problems.length > 0) {
      console.error("SECURITY_SCAN_FAIL: the scanners did not prove themselves on the fixtures");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log("security scanner self-test: every pinned scanner detected its own fixture.");
    return;
  }

  const laneNames = requested === "all"
    ? ["semgrep", "gitleaks", "trivy"]
    : requested.split(",").map((name) => name.trim()).filter(Boolean);

  let result;
  try {
    result = runLanes(policy, laneNames);
  } catch (error) {
    console.error(`SECURITY_SCAN_FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const scheduled = laneNames.includes("gitleaks-history");
  const { blocking, recorded, accepted, unused: unmatched, expired } = applyPolicy(
    result.findings,
    policy,
    {
      scanners: result.scanners,
      lane: scheduled ? "history" : "tree",
      // A build-tool classification is re-proved against the exact lockfile it
      // names on every scan (upstream decision 21 A, October 11, 2026).
      readLockfile: (path) => JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")),
    },
  );
  const unused = unusedOutsideExclusions(unmatched, result.excludedDirectories);

  for (const finding of recorded) console.log(`recorded: ${formatFinding(finding)}`);
  console.log(
    `accepted under reviewed exceptions: ${accepted.length}; recorded below the blocking floor: ${recorded.length}`,
  );

  let failed = false;
  if (unused.length > 0) {
    console.error("SECURITY_SCAN_FAIL: reviewed exceptions no longer match anything. Remove them:");
    for (const entry of unused) {
      console.error(`  - [${entry.scanner}] ${entry.identifier} ${entry.path}`);
    }
    failed = true;
  }
  if (expired.length > 0) {
    const lines = expired.map((entry) =>
      `  - [${entry.scanner}] ${entry.identifier} ${entry.path} expired ${entry.expires_on}`);
    if (scheduled || expired.some(entry => entry.expiry_enforcement === "fail-closed")) {
      console.error("SECURITY_SCAN_FAIL: reviewed exceptions have expired and must be renewed or removed:");
      for (const line of lines) console.error(line);
      failed = true;
    } else {
      console.log("::warning title=Expired security exception::renew or remove the entries below");
      for (const line of lines) console.log(line);
    }
  }
  if (blocking.length > 0) {
    console.error(`SECURITY_SCAN_FAIL: ${blocking.length} finding(s) above the reviewed blocking floor:`);
    for (const finding of blocking) console.error(`  - ${formatFinding(finding)}`);
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`security lane ${laneNames.join(", ")}: no finding above the reviewed blocking floor.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
