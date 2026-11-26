// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitleaksArguments, parseJson, reportScannerFailure, runDocker, scannerFailureDiagnostic, semgrepArguments, trivyArguments } from "../scripts/run-security-scan.mjs";
import { applyPolicy, loadPolicy, normalizeSemgrepReport, normalizeGitleaksReport, normalizeTrivyReport } from "../scripts/lib/security-scanner-policy.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// Runs a failed scanner through runDocker and the default reporter and
// returns what reached the job log and the step summary.
function failureSinks(stderr) {
  const directory = mkdtempSync(join(tmpdir(), "scanner-diagnostic-"));
  try {
    const summaryPath = join(directory, "summary.md");
    const lines = [];
    const execute = () => { throw Object.assign(new Error("failed"), { status: 5, stderr }); };
    expect(() => runDocker([], {
      execute,
      label: "semgrep",
      report: (diagnostic) => reportScannerFailure(diagnostic, { log: (line) => lines.push(line), summaryPath }),
    })).toThrow("semgrep scanner execution failed");
    return [lines.join("\n"), readFileSync(summaryPath, "utf8")];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SYNTHETIC_MARKERS = /synthetic|canary|phrase|review-only|CANARY|REVIEW_MARKER|A1b2|61904735|FATAL|scan aborted|context/;

// Every input a reviewer or a hardening record used against the line-level
// redactor of #6078, #6292 and #6347 and the decoders of #6380. Under the
// plain-ASCII rule none of them may print anything from stderr: not the
// value, not the key line, not the unrelated diagnostics around it.
const CREDENTIAL_EXCERPTS = [
  // #6078 rounds 1-3 (Sol 6.1): quoted, plain and YAML block values.
  'password: "synthetic canary phrase"',
  'password: "  synthetic canary phrase"',
  '"password": "  synthetic canary phrase"',
  "password: '  synthetic canary phrase'",
  'password: "\n  synthetic\ncanary phrase\n"',
  'password: "synthetic \\"canary\\" phrase"',
  'password: "synthetic canary phrase',
  'token = "  synthetic canary phrase"',
  "api_key = `  synthetic\ncanary phrase`",
  `password: "${"synthetic canary phrase\n".repeat(25)}"`,
  `credential: \n  ghs_${"A1b2".repeat(9)}`,
  "password: synthetic canary phrase",
  "PASSWORD=synthetic canary phrase",
  "password: |\n  synthetic canary phrase",
  "password: >-\n  synthetic canary\n\n  phrase\nnext: fine",
  "secret: |2\n    synthetic\n    canary phrase",
  "password: | # comment\n  synthetic canary phrase",
  "password: |- # trailing note\n  synthetic canary phrase\nnext: fine",
  "password: > #c\n  synthetic canary\n  phrase",
  "password: |2-\n    synthetic canary phrase",
  "password: |-2\n    synthetic canary phrase",
  "password: >+1\n  synthetic canary\n  phrase",
  "password: >1+\n  synthetic canary\n  phrase",
  "password: >+ # keep\n  synthetic canary phrase\n\n",
  "password: |2- # both\n    synthetic canary phrase",
  "password: |-\t# tab before the comment\n  synthetic canary phrase",
  // #6078 round 5: empty-key values and numbered excerpts.
  'password:\n  "synthetic canary phrase"',
  '{"password":\n"synthetic canary phrase"}',
  '1 | {"password":\n2 | "synthetic canary phrase"}',
  '{"password":\n61904735}',
  '{"secret":\n{"value":"synthetic canary phrase"}}',
  '{"secret": {\n"value":"synthetic canary phrase"}}',
  '1 | {"secret":\n2 | [{"value":"synthetic canary phrase"}]}',
  "password:\nsynthetic canary phrase",
  '{"secret":\n  {\n"value":"synthetic canary phrase"}}',
  "password:\n  'synthetic canary phrase'",
  "password:\n  synthetic\n  canary phrase",
  "password: synthetic\n  canary phrase\nnext: fine",
  "password: 'synthetic\n  canary ''phrase\n  continued'\nnext: fine",
  'password: "synthetic\\\n  canary \\"phrase\\""\nnext: fine',
  'password:\r  "synthetic canary phrase"\rnext: fine',
  '1 | password:\n2 |   "synthetic canary phrase"\n3 | next: fine',
  "1 | password: | # comment\n2 |   synthetic canary phrase\n3 | next: fine",
  "1 | password: synthetic\n2 |   canary\n3 |   phrase\n4 | next: fine",
  '1 | password: "synthetic\n2 | canary phrase"\n3 | next: fine',
  "1 | password: 'synthetic\n2 | canary ''phrase\n3 | continued'\n4 | next: fine",
  "1 │ outer:\n2 │   password: synthetic\n3 │     canary phrase\n4 │   next: fine",
  "1 ┆ password: >2- # comment\n2 ┆   synthetic canary phrase\n3 ┆ next: fine",
  `password: synthetic\n${"  canary phrase\n".repeat(30)}next: fine`,
  'password: """synthetic\n  canary phrase"""\nnext: fine',
  "password: '''synthetic\n  canary phrase'''\nnext: fine",
  "config_1234567890_password: synthetic\n  canary phrase\nnext: fine",
  "password: synthetic token='other'\n  canary phrase\nnext: fine",
  'password: synthetic token="other\n  interim"\n  canary phrase\nnext: fine',
  "password: 'other' token=synthetic\n  canary phrase\nnext: fine",
  '"password"\n : "synthetic canary phrase"\nnext: fine',
  'password: "other", "token"\n : "synthetic canary phrase"\nnext: fine',
  'password: "other\n interim", "token"\n : "synthetic canary phrase"\nnext: fine',
  'password: # comment\n  "synthetic\ncanary phrase"\nnext: fine',
  'password:\n  # comment\n  "synthetic\ncanary phrase"\nnext: fine',
  "password: synthetic\n# comment\n  canary phrase\nnext: fine",
  'password: # comment token="other"\n  "synthetic\ncanary phrase"\nnext: fine',
  "context:\n  password: |\n  synthetic canary phrase\nnext: fine",
  "context:\n  password: |0 # malformed indentation\n\tsynthetic canary phrase\nnext: fine",
  // #6078 round 6: split keys, equal indentation and Semgrep caret rows.
  '1 | "password"\n2 | : "review-only passphrase"',
  '1 | "password"\n2 | \n3 | : "review-only passphrase"',
  ...["|", "│", "┆"].map((gutter) => `10 ${gutter}    "api_key"\n11 ${gutter} :\n12 ${gutter} "review-only passphrase"`),
  'password:\n"review-only passphrase"',
  '1 |   password:\n  |   ^^^^^^^^\n2 |     "review-only passphrase"',
  "1 |     password: review-only\n  |     ^^^^^^^^\n2 |       passphrase",
  "1 |   outer:\n2 |     password: review-only\n  |     ^^^^^^^^\n3 |       passphrase",
  "1 |   password: review-only\n  |\n2 |     passphrase",
  '1 | "password"\n  | ^^^^^^^^^^\n2 | : "review-only passphrase"',
  // #6078 round 7: expressions that continue past their first value.
  '1 | const password = (\n2 | "review-only passphrase"\n3 | );',
  '1 | const password = "prefix" +\n2 |   "review-only passphrase";',
  'const password = "prefix" + "review-only passphrase";',
  'const password = "prefix" "review-only passphrase";',
  'char *password = "prefix"\n"review-only passphrase";',
  'const password = prefix +\n"review-only passphrase";',
  'const password = getSecret(\n"review-only passphrase");',
  'const password = prefix\n+ "review-only passphrase";',
  'const password = "prefix"\n+ "review-only passphrase";',
  'const password = "prefix"\n.concat("review-only passphrase");',
  'password =\n"prefix" +\n"review-only passphrase"',
  'password =\n  getSecret(\n"review-only passphrase")',
  'password: a\n  b +\n"review-only passphrase"',
  "const password = prefix + `review-only\npassphrase`;",
  'const password = prefix ? "x" :\n"review-only passphrase";',
  'password = "prefix" & "review-only passphrase"',
  // #6078 round 8 (#6226): a call or index on the next line.
  '1 | const password = String\n2 | ("review-only passphrase");',
  '1 | const password = "prefix"\n2 | ["concat"]("review-only passphrase");',
  'password = "prefix"\n# note\n+ "review-only passphrase"',
  // #6078 round 9 (#6286): a trailing prefix keyword awaits its operand.
  '1 | const password = await\n2 | Promise.resolve("review-only passphrase");',
  '1 | const password = new\n2 | String("review-only passphrase");',
  '1 | const password = typeof\n2 | lookup("review-only passphrase");',
  '1 | const password = void\n2 | send("review-only passphrase");',
  '1 | const password = delete\n2 | vault["review-only passphrase"];',
  '1 | const password = yield\n2 | fetchSecret("review-only passphrase");',
  // #6292 rounds 1 and 2 (#6294, #6328): trailing and attached comments.
  '1 | const password = await // explanation\n2 | Promise.resolve("review-only passphrase");',
  '1 | const password = prefix + // explanation\n2 | Promise.resolve("review-only passphrase");',
  '1 | const password = fallback || // explanation\n2 | readSecret("review-only passphrase");',
  '1 | const password = await// explanation\n2 | Promise.resolve("review-only passphrase");',
  '1 | const password = prefix +// explanation\n2 | Promise.resolve("review-only passphrase");',
  '1 | password = prefix +# explanation\n2 | fetch("review-only passphrase")',
  // #6295: camelCase and PascalCase keys.
  'const clientSecret = "review-only passphrase";',
  'const accessToken = "review-only passphrase";',
  'refreshToken: "review-only passphrase"',
  'const refreshToken = "passphrase";',
  'const accessToken = "reviewonlypassphrasereviewonlypassphrase";',
  // #6347 round 1 (6468766602): nested template, secret-key segments, block comment.
  "1 | const password = `prefix${\n2 | `;\n3 | review-only passphrase\n4 | `}`;",
  'const secretKey = "review-only passphrase";',
  'secret_key = "review-only passphrase"',
  'const password /* saved credential */ = "review-only passphrase";',
  'const password /* saved credential\n= "review-only passphrase";',
  // #6347 round 2 (6472759066): a line comment before the delimiter, a quoted bracket key.
  'const password // saved credential\n= "review-only passphrase";',
  'config["password"] = "review-only passphrase";',
  'const password # saved\n= "review-only passphrase"',
  "config['secret_key']\n  = 'review-only passphrase'",
  'settings.password = "review-only passphrase";',
  // #6347 round 3 (6473662572): a comment between key and delimiter, an
  // unfinished function initializer, and word-operator continuations.
  'const password /* CANARY */ = "safe";',
  '1 | const password /*\n2 | CANARY\n3 | */ = "safe";',
  '1 | const password = function\n2 | makeValue() { return "CANARY"; }();',
  '1 | const password = key\n2 | in lookup("CANARY")',
  '1 | const password = value\n2 | instanceof Vault("CANARY")',
  // The words in any position, case, separator or disguise.
  'mysecretvalue = "synthetic canary phrase"',
  'passwordless-login: "synthetic canary phrase"',
  'X-Api-Key: "synthetic canary phrase"',
  'Authorization: "synthetic canary phrase"',
  'PRIVATE_KEY = "synthetic canary phrase"',
  'DB_PWD=synthetic canary phrase',
  'PASS_WORD = "synthetic canary phrase"',
  'pass-word: "synthetic canary phrase"',
  'pass​word: "synthetic canary phrase"',
  'pa\u001b[0mssword: "synthetic canary phrase"',
  '\u001b[password: "synthetic canary phrase"',
  "ｐａｓｓｗｏｒｄ: synthetic canary phrase",
  "the value follows synthetic canary phrase\n1 | pass\n2 | word",
  // #6380 round 1 (6474289627) r1s2: a colon-form color escape inside the word,
  // and the other ECMA-48 and 8-bit forms.
  "pass\u001b[38:2::255:0:0mword: REVIEW_MARKER",
  "pass\u001b[38:5:1mword: REVIEW_MARKER",
  "pass\u009b38;5;1mword: REVIEW_MARKER",
  "pass\u001b[?25h\u001b[1 qword: REVIEW_MARKER",
  "pass\u001b]8;;https://example.test\u0007word: REVIEW_MARKER",
  "pass\u001b]0;title\u001b\\word: REVIEW_MARKER",
  // r1s3: a credential word spelled with literal character escapes.
  '{"pass\\u0077ord": "REVIEW_MARKER"}',
  '{"pass\\u{77}ord": "REVIEW_MARKER"}',
  "pass\\x77ord = 'REVIEW_MARKER'",
  "pass\\x{77}ord = 'REVIEW_MARKER'",
  "pass\\U00000077ord = 'REVIEW_MARKER'",
  "pass\\167ord = 'REVIEW_MARKER'",
  "pass%77ord=REVIEW_MARKER",
  "pass%u0077ord=REVIEW_MARKER",
  "pass&#119;ord=REVIEW_MARKER",
  "pass&#x77ord=REVIEW_MARKER",
  "\\u0070\\u0061\\u0073\\u0073\\u0077\\u006f\\u0072\\u0064 = REVIEW_MARKER",
  "pass%5Cu0077ord=REVIEW_MARKER",
  "pass\\u001b[0mword: REVIEW_MARKER",
  "\\u0061ccess_key: REVIEW_MARKER",
  // r1s1: combining marks inside the word.
  "pass\u0301\u0315word: REVIEW_MARKER",
  // #6380 final (6475914716): a leading-zero brace escape, and escapes that
  // only form after stripping a terminal sequence or after NFKC.
  "pass\\u{00000077}ord = 'REVIEW_MARKER'",
  "pass\\u00\u001b[0m77ord: REVIEW_MARKER",
  "pass\\\uff550077ord: REVIEW_MARKER",
  "\u009d0;".repeat(64) + "pass\u009cword: REVIEW_MARKER",
];

const WITHHELD = /^stderr withheld \(\d+ line\(s\)\): it (?:names a credential|holds a character outside plain printable ASCII|holds an escape spelling|holds URL user information)$/;


// The six P1 inputs of #6380 (round 1 6474289627, final 6475914716), each with
// the reason the plain-ASCII rule now gives. None is decoded.
const VERDICT_PROBES = [
  ["r1s1 combining marks inside the word", "pass\u0315\u0300word: REVIEW_MARKER", "character"],
  ["r1s2 colon-form color escape", "pass\u001b[38:2::255:0:0mword: REVIEW_MARKER", "character"],
  ["r1s3 literal backslash-u key", '{"pass\\u0077ord": "REVIEW_MARKER"}', "escape"],
  ["final r2s1 repeated 8-bit OSC introducers", "\u009d0;".repeat(32), "character"],
  ["final r2s2 leading-zero brace escape", "const pass\\u{00000077}ord = 'REVIEW_MARKER';", "escape"],
  ["final r2s3 strip-then-decode", "pass\\u00\u001b[0m77ord: REVIEW_MARKER", "escape"],
  ["final r2s3 NFKC-then-decode", "pass\\\uff550077ord: REVIEW_MARKER", "character"],
];
const REASONS = {
  character: "it holds a character outside plain printable ASCII",
  escape: "it holds an escape spelling",
  url: "it holds URL user information",
  word: "it names a credential",
};

// The three P1 inputs of #6392 round 1 (6476365362).
// The two P1 inputs of #6392's final (6477988080).
const FINAL_PROBES = [
  ["r2s1 a short Bearer token", "FATAL request failed: Bearer CANARY", "word"],
  ["r2s2 a tab inside URL user information", "FATAL GET https://u:\tCANARY@example.test/x", "url"],
  ["r2s2 a line feed inside URL user information", "FATAL GET https://u:\nCANARY@example.test/x", "url"],
  ["r2s2 spaces and line feeds before the user", "FATAL GET https://\n  CANARY @example.test/x", "url"],
  ["a URL with no path before an address later in stderr", "FATAL GET https://example.test\nCANARY@example.test", "url"],
];

const ROUND_ONE_PROBES = [
  ["r1s1 a percent-encoded hyphen inside a key", "FATAL GET https://example.test/?api%2Dkey=CANARY", "escape"],
  ["r1s2 a password-only Redis URL", "REDIS_URL: redis://:CANARY@cache.example:6379", "url"],
  ["r1s3 a legacy named reference without its semicolon", "api&shykey: CANARY", "escape"],
];

function expectWithheldFromBothSinks(stderr, reason) {
  const diagnostic = scannerFailureDiagnostic("semgrep", { status: 5, stderr });
  expect(diagnostic.tail).toEqual([]);
  expect(diagnostic.withheld).toMatch(reason ? new RegExp(`^stderr withheld \\(\\d+ line\\(s\\)\\): ${REASONS[reason]}$`) : WITHHELD);
  for (const text of failureSinks(stderr)) {
    expect(text).toContain("semgrep scanner failed: exit 5");
    expect(text).toContain(diagnostic.withheld);
    expect(text).not.toMatch(SYNTHETIC_MARKERS);
    expect(text).not.toContain("  | ");
  }
}

// Fastest interleaved timing of each input. Noise (a scheduler tick, a GC
// pause, a neighbour on a shared 2-vCPU runner) only ever adds time, so the
// fastest sample is the closest to the work itself, and interleaving spreads a
// slow stretch over every size instead of one size's whole sample. Sampling
// takes at least three rounds and stops once `settled` holds, or after
// fifteen: more samples only bring each fastest time closer to the true cost,
// so work that really grows faster than linear fails every round.
function fastestRuns(inputs, settled) {
  const fastest = inputs.map(() => Infinity);
  for (let round = 1; round <= 15; round += 1) {
    inputs.forEach((stderr, index) => {
      const started = performance.now();
      scannerFailureDiagnostic("semgrep", { status: 5, stderr });
      fastest[index] = Math.min(fastest[index], performance.now() - started);
    });
    if (round >= 3 && settled(fastest)) break;
  }
  return fastest;
}

describe("scanner failure and exception boundaries", () => {
  it("rejects partial stdout on nonzero exit without exposing captured values", () => {
    const execute = () => { const error = new Error("synthetic-sensitive-value"); error.stdout = '{"results":[]}'; error.stderr = "synthetic-sensitive-value"; throw error; };
    const report = () => {};
    expect(() => runDocker([], { execute, report })).toThrow("scanner execution failed");
    try { runDocker([], { execute, report }); } catch (error) {
      expect(String(error)).not.toContain("synthetic-sensitive-value");
      expect(error.cause).toBeUndefined();
    }
  });
  it("reports the scanner, its exit status and a redacted stderr tail, never stdout", () => {
    const token = `ghs_${"A1b2".repeat(9)}`;
    const execute = () => {
      const error = new Error("Command failed");
      Object.assign(error, {
        status: 1,
        signal: null,
        stdout: '{"Results":[{"Secrets":[{"Match":"synthetic-report-value"}]}]}',
        stderr: [
          `2026-10-26T05:24:04Z\tINFO\tusing ${token}`,
          "2026-10-26T05:24:04Z\tFATAL\tFatal error\tinit error: DB error: failed to download vulnerability DB",
          "\t* GET https://mirror.gcr.io/v2/aquasec/trivy-db/manifests/2: TOOMANYREQUESTS: rate exceeded",
        ].join("\n"),
      });
      throw error;
    };
    const reports = [];
    let thrown;
    try { runDocker([], { execute, label: "trivy", report: (diagnostic) => reports.push(diagnostic) }); } catch (error) { thrown = error; }
    expect(thrown.message).toBe("trivy scanner execution failed; no complete report is trusted");
    expect(reports).toHaveLength(1);
    const [{ headline, tail, withheld }] = reports;
    expect(headline).toBe("trivy scanner failed: exit 1");
    expect(withheld).toBeNull();
    expect(tail.at(-2)).toContain("FATAL\tFatal error\tinit error: DB error: failed to download vulnerability DB");
    expect(tail.at(-1)).toContain("TOOMANYREQUESTS: rate exceeded");
    expect(tail.at(-1)).toContain("mirror.gcr.io/v2/aquasec/trivy-db/manifests/2");
    expect(tail).toContain("2026-10-26T05:24:04Z\tINFO\tusing [redacted-token]");
    const text = JSON.stringify(reports);
    expect(text).not.toContain(token);
    expect(text).not.toContain("synthetic-report-value");
  });
  it("names docker-level kills and masks credential shapes that carry no secret-key word", () => {
    expect(scannerFailureDiagnostic("semgrep", { status: 137, signal: null, stderr: "" }))
      .toEqual({ headline: expect.stringContaining("semgrep scanner failed: exit 137 (the container was killed: SIGKILL"), tail: [], withheld: null });
    expect(scannerFailureDiagnostic("gitleaks", { status: null, signal: "SIGTERM", code: "ENOBUFS" }).headline)
      .toBe("gitleaks scanner failed: signal SIGTERM, error ENOBUFS");
    const tail = (stderr) => scannerFailureDiagnostic("trivy", { status: 1, stderr }).tail;
    expect(tail("header Basic abcdefgh1234")).toEqual(["header Basic [redacted]"]);
    expect(tail("header Basic\n  abcdefgh1234\nnext")).toEqual(["header Basic [redacted]", "next"]);
    expect(tail("header Basic YTpi")).toEqual(["header Basic [redacted]"]);
    expect(tail("header basic: x")).toEqual(["header basic [redacted]"]);
    expect(tail(`jwt eyJ${"a".repeat(10)}.${"b".repeat(10)}.sig`)).toEqual(["jwt [redacted-jwt]"]);
    expect(tail(`digest sha256:${"ab12".repeat(16)} path policies/aws/ec2/specify_ami_owners.rego`))
      .toEqual(["digest sha256:[redacted] path policies/aws/ec2/specify_ami_owners.rego"]);
    expect(tail("x".repeat(400))[0]).toHaveLength(301);
    const semgrepExcerpt = "  --> rules.yml:3\n3 |     pattern-inside: foo(...)\n  |     ^^^^^^^^^^^^^^\n4 |     patterns:";
    expect(tail(semgrepExcerpt)).toEqual(semgrepExcerpt.split("\n"));
  });
  it.each(VERDICT_PROBES)("withholds the #6380 P1 input from both sinks without decoding it: %s", (_name, excerpt, reason) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\n${excerpt}\nFATAL scan aborted`, reason);
  });
  it.each(FINAL_PROBES)("withholds the #6392 final P1 input from both sinks: %s", (_name, excerpt, reason) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\n${excerpt}\nFATAL scan aborted`, reason);
  });
  it.each(["Basic YTpi", "Basic a", "basic: x", "Basic='Q'", "Basic\n\tCANARY"])("masks whatever follows Basic in both sinks: %j", (value) => {
    for (const text of failureSinks(`FATAL request failed: ${value}\nFATAL done`)) {
      expect(text).toContain("Basic [redacted]".replace("B", value[0]));
      expect(text).not.toMatch(/YTpi|CANARY|Q'|: a$|: x/);
    }
  });
  it.each(ROUND_ONE_PROBES)("withholds the #6392 round-1 P1 input from both sinks: %s", (_name, excerpt, reason) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\n${excerpt}\nFATAL scan aborted`, reason);
  });
  it.each([
    "redis://:CANARY@cache.example:6379", "https://user:CANARY@ghcr.io/x", "https://CANARY@ghcr.io/x", "ftp://@host",
    "postgres://u:CANARY@db/x?sslmode=require", "https://ghcr.io/x?next=a@b", "git+ssh://CANARY@host:repo", "a://b://CANARY@c",
  ])("withholds the URL with user information %j from both sinks", (url) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\nFATAL GET ${url}: 401\nFATAL scan aborted`, "url");
  });
  it.each(CREDENTIAL_EXCERPTS)("withholds the whole excerpt from both sinks: %j", (excerpt) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\n${excerpt}\nFATAL scan aborted`);
  });
  it.each([
    ["escape", "\u001b"], ["null", "\u0000"], ["bell", "\u0007"], ["backspace", "\b"], ["carriage return", "\r"],
    ["vertical tab", "\v"], ["form feed", "\f"], ["delete", "\u007f"], ["8-bit CSI", "\u009b"], ["next line", "\u0085"],
    ["no-break space", "\u00a0"], ["accented letter", "\u00e9"], ["zero-width space", "\u200b"], ["byte-order mark", "\ufeff"],
    ["line separator", "\u2028"], ["replacement character", "\ufffd"], ["astral character", "\u{1d568}"], ["lone surrogate", "\ud800"],
  ])("withholds an excerpt holding a %s from both sinks", (_name, character) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\nFATAL ${character} REVIEW_MARKER\nFATAL scan aborted`, "character");
  });
  it.each([
    "\\u0041", "\\U00000041", "\\x41", "\\x{41}", "\\N{LATIN CAPITAL LETTER A}", "\\101", "\\0", "\\o{101}", "\\cA", "\\e[0m",
    "\\n", "\\t", "\\\\u0041", "\\\nu0041", "&#65;", "&#x41;", "&#", "&wopf;", "&amp;", "&shy", "&a", "a&b=1", "&Z",
    "%41", "%61", "%30", "%25", "%26", "%23", "%5C", "%5c", "%0A", "%7F", "%C3%A9", "%2D", "%2F", "%20", "%3a", "%u0041", "%U0041",
  ])("withholds an excerpt holding the escape spelling %j from both sinks", (spelling) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\nFATAL ${spelling} REVIEW_MARKER\nFATAL scan aborted`, "escape");
  });
  it("withholds a trivy progress bar, whose carriage return is a control character", () => {
    expectWithheldFromBothSinks("10.25 MiB / 130.00 MiB [---->____] 7.88%\r130.00 MiB / 130.00 MiB [-------->] 100.00%\nFATAL scan aborted", "character");
  });
  it("counts the withheld lines and keeps the notice in the step summary", () => {
    const [log, summary] = failureSinks("FATAL one\n\npassword: synthetic\nFATAL two\n");
    expect(log).toBe("::error title=Security scanner failed::semgrep scanner failed: exit 5\nstderr withheld (3 line(s)): it names a credential");
    expect(summary).toBe("### Security scanner failure\n\nsemgrep scanner failed: exit 5\n\nstderr withheld (3 line(s)): it names a credential\n");
  });
  it("still prints the tail of a plain ASCII excerpt with no escape spelling and no credential word", () => {
    const [log, summary] = failureSinks("FATAL rule parse error at rules.yml:3\tcol 7\nFATAL ##[stop-commands]review-marker");
    expect(log).toContain("last 2 stderr line(s), redacted:");
    expect(log).toContain("  | FATAL rule parse error at rules.yml:3\tcol 7");
    expect(log).toContain("  | FATAL # #[stop-commands]review-marker");
    expect(summary).toContain("```text\nFATAL rule parse error at rules.yml:3\tcol 7\nFATAL # #[stop-commands]review-marker\n```");
  });
  it.each([
    "GET https://ghcr.io/v2/aquasec/trivy-db/manifests/2: 404",
    "path C:/x 50% done; a & b; 100% %g %2 %",
    "regex a\\.b or \\( or \\\\ or a trailing \\",
    "R & D; &;x; & #1 a&&1 &",
    "mail ops@example.test from https://ghcr.io/x and ://",
  ])("still prints punctuation that spells no escape: %j", (line) => {
    expect(scannerFailureDiagnostic("trivy", { status: 1, stderr: line })).toMatchObject({ tail: [line], withheld: null });
  });
  it("withholds a stderr longer than the input bound without inspecting it", () => {
    const stderr = `${"FATAL harmless line\n".repeat(55000)}synthetic canary phrase`;
    expect(Buffer.byteLength(stderr)).toBeGreaterThan(1024 * 1024);
    const diagnostic = scannerFailureDiagnostic("trivy", { status: 1, stderr });
    expect(diagnostic).toEqual({ headline: "trivy scanner failed: exit 1", tail: [], withheld: "stderr withheld (55001 line(s)): it exceeds the 1048576-byte diagnostic bound" });
    expect(scannerFailureDiagnostic("trivy", { status: 1, stderr: Buffer.from(stderr) }).withheld).toBe(diagnostic.withheld);
    // The bound is in bytes: half a mebibyte of two-byte characters is over it.
    expect(scannerFailureDiagnostic("trivy", { status: 1, stderr: "\u00e9".repeat(524289) }).withheld)
      .toBe("stderr withheld (1 line(s)): it exceeds the 1048576-byte diagnostic bound");
  });
  // Each reviewer timing input at its stated size and at twice that size:
  // #6347 rounds 2 and 3 and record #6376 (3.0 s at 153 KB, 12.3 s at 307 KB),
  // #6380 round 1 r1s1 (22.9 s at 524,289 bytes) and final r2s1 (3.8 s at
  // 131,072 bytes). The 1 MiB inputs of #6380 run at half and full size,
  // because twice the bound is withheld unread.
  it.each([
    ["#6347 r3s3 unterminated block comments", (n) => `${"password /* ".repeat(n)}!`, 25600],
    ["#6347 r2s3 overlapping secret-key segments", (n) => `FATAL unexpected identifier secret${"_AAAA".repeat(n)}!`, 40000],
    ["#6380 r1s1 combining-mark run", (n) => `a${"\u0315\u0300".repeat(n)}`, 131072],
    ["#6380 final r2s1 unterminated 8-bit OSC introducers", (n) => "\u009d0;".repeat(n), 32768],
    ["#6380 final r2s1 at the reviewer's 32,000 bytes", (n) => "\u009d0;".repeat(n), 8000],
    ["marks in descending combining class", (n) => `a${"\u0315\u031b\u0301\u0316\u0300".repeat(n)}`, 52428],
    ["characters that decompose to marks", (n) => "\uff9e\uff9f\u0e33\u0eb3".repeat(n), 43690],
    ["JWT starts inside one run", (n) => "eyJ-".repeat(n), 131072],
    ["URL credential starts", (n) => "://a:".repeat(n), 104857],
    ["URL starts in one whitespace-free run", (n) => "https://x/".repeat(n), 52428],
    ["URL starts in short runs", (n) => "://a ".repeat(n), 104857],
    ["percent signs without two hex digits", (n) => "%g%2 ".repeat(n), 104857],
    ["ampersands before punctuation", (n) => "&;& ".repeat(n), 131072],
    ["bearer starts with short values", (n) => "Bearer abc ".repeat(n), 47662],
    ["basic starts with short values", (n) => "Basic a ".repeat(n), 65536],
    ["key delimiters after gaps that are not pwd", (n) => "pw \t\n\"'= ".repeat(n), 58254],
    ["pwd without a key delimiter", (n) => "pwd ".repeat(n), 131072],
    ["one long gap before a key delimiter", (n) => `${" ".repeat(n)}=`, 262144],
    ["long gaps each before a key delimiter", (n) => `${" \t'".repeat(64)}=`.repeat(n), 1365],
    ["basic followed only by whitespace", (n) => `Basic${" ".repeat(n)}`, 262144],
    ["URL starts with whitespace before any delimiter", (n) => "://a \n".repeat(n), 87381],
    ["URL starts whose authority never ends", (n) => `${"://".repeat(n)}${" x".repeat(n)}`, 87381],
    ["runs one short of the long-run rule", (n) => `${"a1".repeat(11)}a `.repeat(n), 21845],
    ["token prefixes with short values", (n) => "ghp_abc ".repeat(n), 65536],
    ["plain lines that print", (n) => "FATAL harmless line at rules.yml:3\n".repeat(n), 14979],
    ["percent escapes", (n) => "%25".repeat(n), 174762],
    ["unterminated escape introducers", (n) => "\\u{12".repeat(n), 104857],
    ["named-reference starts without a semicolon", (n) => `&${"a".repeat(31)} `.repeat(n), 16384],
    ["terminal escapes without a final letter", (n) => "\u001b[1;2;3".repeat(n), 74898],
    ["unterminated operating-system commands", (n) => "\u001b]0;".repeat(n), 131072],
    ["control sequences without a final byte", (n) => `\u001b[${"0:".repeat(n)}`, 262143],
  ])("decides in linear time: %s", (_name, build, count) => {
    const half = build(Math.max(1, Math.floor(count / 2)));
    const small = build(count);
    const large = build(count * 2);
    expect(Buffer.byteLength(small)).toBeLessThanOrEqual(1024 * 1024);
    // The ceilings catch a decision that is slow at the stated size; they take
    // the runner's 3x budget, because the instrumented merge-group shard on
    // GitHub's 2-vCPU runner measured 250-284 ms against a flat 250 (run
    // 41291229032, shard 3/4), while the reviewer inputs above took seconds.
    // The linearity proof is the ratio across a fourfold span, measured in one
    // process on one runner: linear work takes about 4x from half to twice the
    // stated size, quadratic 16x, and 8x sits a factor of two from each (any
    // growth above n^1.5 fails). The constant absorbs timer noise. A twofold
    // span under 2.5x left linear work 25 percent of headroom, and one
    // instrumented shard measured 2.74x (run 41298987695, shard 3/4).
    const within = ([halfMs, smallMs, largeMs]) => smallMs < runnerTimeout(250) && largeMs < runnerTimeout(500)
      && largeMs < 8 * halfMs + 25;
    const [halfMs, smallMs, largeMs] = fastestRuns([half, small, large], within);
    expect(smallMs).toBeLessThan(runnerTimeout(250));
    expect(largeMs).toBeLessThan(runnerTimeout(500));
    expect(largeMs, `${halfMs.toFixed(1)} ms at half size, ${largeMs.toFixed(1)} ms at twice`).toBeLessThan(8 * halfMs + 25);
  });
  it("returns successful stdout unchanged without emitting diagnostics", () => {
    const stdout = '{"results":[],"note":"password: secret ::notice:: ##[warning]"}';
    expect(runDocker([], { execute: () => stdout, report: () => { throw new Error("unexpected diagnostic"); } })).toBe(stdout);
  });
  it("writes inert diagnostic text even when workflow commands occur inside a line", () => {
    const directory = mkdtempSync(join(tmpdir(), "scanner-summary-"));
    try {
      const summaryPath = join(directory, "summary.md");
      const lines = [];
      reportScannerFailure({ headline: "trivy scanner failed: exit 1", tail: ["::stop-commands::x", "FATAL ##[stop-commands]x", "FATAL ::error::x ##[warning]x", "FATAL :::error:::x", "uses `backticks`"] }, { log: (line) => lines.push(line), summaryPath });
      expect(lines[0]).toBe("::error title=Security scanner failed::trivy scanner failed: exit 1");
      for (const line of lines.slice(1)) {
        expect(line).not.toContain("::");
        expect(line).not.toContain("##[");
      }
      expect(lines).toContain("  | : :stop-commands: :x");
      expect(lines).toContain("  | FATAL # #[stop-commands]x");
      expect(readFileSync(summaryPath, "utf8")).toBe(
        "### Security scanner failure\n\ntrivy scanner failed: exit 1\n\n```text\n: :stop-commands: :x\nFATAL # #[stop-commands]x\nFATAL : :error: :x # #[warning]x\nFATAL : : :error: : :x\nuses 'backticks'\n```\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects scanner-reported errors even with a valid empty result list", () => {
    expect(() => normalizeSemgrepReport({ results: [], errors: [{ message: "partial scan" }] })).toThrow(/incomplete/);
    expect(() => normalizeSemgrepReport({})).toThrow(/incomplete/);
    expect(() => normalizeGitleaksReport({})).toThrow(/incomplete/);
    expect(() => normalizeTrivyReport({})).toThrow(/incomplete/);
    expect(normalizeSemgrepReport({ results: [], errors: [] })).toEqual([]);
    expect(normalizeTrivyReport({ SchemaVersion: 2 })).toEqual([]);
  });
  it("does not include a malformed JSON excerpt in errors", () => {
    expect(() => parseJson("semgrep", '{"synthetic-sensitive-value": broken}')).toThrow("semgrep produced an unreadable JSON report");
  });
  it("audits all policy expirations during a gitleaks-only history run", () => {
    const policy = loadPolicy();
    const { expired } = applyPolicy([], policy, { today: "2099-01-01", scanners: ["gitleaks"], lane: "history" });
    expect(expired).toHaveLength(policy.allowlist.filter(entry => entry.classification !== "build-tool").length);
    expect(expired.some(entry => entry.scanner === "semgrep")).toBe(true);
  });
  it("does not let a reviewed Semgrep occurrence cover a second vulnerability", () => {
    const policy = loadPolicy();
    const entry = policy.allowlist.find(e => e.scanner === "semgrep");
    const finding = { scanner: entry.scanner, identifier: entry.identifier, path: entry.path, severity: "ERROR", line: 10 };
    const result = applyPolicy([finding, { ...finding, line: 20 }], policy, { scanners: ["semgrep"] });
    expect(result.accepted).toHaveLength(1);
    expect(result.blocking).toHaveLength(1);
  });
  it("asks every scanner for plain output at the source, never stripping it afterwards", () => {
    const policy = loadPolicy();
    for (const args of [semgrepArguments(policy), gitleaksArguments(policy), trivyArguments(policy)]) {
      expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
      expect(args).not.toContain("-t");
      expect(args).not.toContain("--tty");
      expect(args.join(" ")).toContain("--env NO_COLOR=1 --env TERM=dumb");
    }
    expect(gitleaksArguments(policy)).toEqual(expect.arrayContaining(["--no-banner", "--no-color"]));
  });
  it("still withholds the pinned gitleaks image's colored failure line from both sinks", () => {
    // Captured from the pinned image with --no-banner, --no-color, NO_COLOR=1
    // and TERM=dumb on October 28, 2026: its log lines stay colored.
    expectWithheldFromBothSinks("\u001b[90m8:48PM\u001b[0m \u001b[1m\u001b[31mFTL\u001b[0m\u001b[0m unable to load gitleaks config, err: open /repo/config/missing.toml: no such file or directory\nFATAL scan aborted", "character");
  });
  it("prints the pinned semgrep image's failure advice, whose $(pwd) is not a key", () => {
    const stderr = "Failed to run 'git config --global --add safe.directory *'. Possible reasons:\n- the current working directory is not marked as safe\n    (fix with `git config --global --add safe.directory $(pwd)`)\n\nTry running the command yourself to debug the issue.";
    const [log, summary] = failureSinks(stderr);
    expect(log).toContain("  | - the current working directory is not marked as safe");
    expect(log).toContain("safe.directory $(pwd)");
    expect(summary).toContain("safe.directory $(pwd)");
  });
  it.each([
    "DB_PWD=CANARY", "pwd=CANARY", "PWD: CANARY", '{"pwd": "CANARY"}', "db_pwd = 'CANARY'", "Pwd\n= CANARY", "PWD\t:CANARY", "pwd\"\t=CANARY",
    // #6428 Codex review (PRRT_kwDOSAKzns6xU99g): any length of gap before the delimiter.
    'db_pwd     = "orchard meadow CANARY"', '{"pwd"     : "orchard meadow CANARY"}', `pwd${" \t\n\"'".repeat(40)}= CANARY`,
  ])("withholds pwd used as a key from both sinks: %j", (line) => {
    expectWithheldFromBothSinks(`FATAL source excerpt\n${line}\nFATAL scan aborted`, "word");
  });
  it.each(["cd $(pwd) && make", "pwd and cwd differ", "run pwd; then retry", "pwdx=1", "p w d = 1"])("prints pwd that is not a key: %j", (line) => {
    expect(scannerFailureDiagnostic("semgrep", { status: 7, stderr: line })).toMatchObject({ tail: [line], withheld: null });
  });
  it("includes the production service worker in actual scanner arguments", () => {
    expect(semgrepArguments(loadPolicy())).toContain("public/sw.js");
  });
});
