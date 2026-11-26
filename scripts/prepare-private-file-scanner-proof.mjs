// Prepares the reproducible fixtures the required real-scanner pipeline proof
// needs, and gates the pinned ClamAV container on live, fresh signatures.
//
// Nothing here reads a repository secret. The mutual-TLS material is generated
// at job time into a runner-owned directory and is destroyed with it; the
// Supabase keys written to the status file come from the disposable loopback
// stack that this same job started and will stop.
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, randomBytes, randomInt } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const PROOF_DIRECTORY_PREFIX = "unionground-upload-adapter-proof-";
export const PROOF_ARTIFACT_PREFIX = "unionground-upload-pipeline-proof-";
// Two client leaves, one server leaf. Production hosting terminates the same
// way: ONE server keypair (therefore one PRIVATE_FILE_SCANNER_EXPECTED_SPKI)
// behind two listeners whose per-listener client SAN allowlists make each
// surface's identity independently revocable. The proof mints both so the CI
// lane can exercise the surface-routed policy end to end instead of asserting
// it only in unit tests.
export const SCANNER_CLIENT_IDENTITIES = Object.freeze({
  production: "unionground-upload-proof-client",
  sample: "unionground-upload-proof-sample-client",
});
export const SCANNER_FIXTURE_FILES = [
  "ca.crt", "client.crt", "client.key",
  "sample-client.crt", "sample-client.key",
  "server.crt", "server.key",
];
export const SCANNER_STATUS_KEYS = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"];
export const SCANNER_PROOF_ENV_NAMES = [
  "PRIVATE_FILE_PIPELINE_SCANNER_DIR",
  "PRIVATE_FILE_STORAGE_STATUS_FILE",
  "PRIVATE_FILE_PIPELINE_CLAMD_PORT",
  "PRIVATE_FILE_PIPELINE_ARTIFACT",
];
// The disposable Supabase stack owns 55000-59999 (assertDisposableProofUrl).
// The scanner must never squat a port block a parallel disposable stack needs.
export const DISPOSABLE_PORT_RANGE = { min: 55000, max: 59999 };
export const CLAMD_PORT_RANGE = { min: 60000, max: 64999 };
// The scanner adapter refuses definitions older than 48 hours
// (api/_lib/privateFileScanner.js MAX_SIGNATURE_AGE_MS). Reserve the proof's
// own wall-clock budget so a signature set that would expire mid-proof fails
// here, with a diagnosable message, instead of as an opaque scanner 503.
export const MAX_SIGNATURE_AGE_MS = 48 * 60 * 60 * 1000;
export const SIGNATURE_PROOF_BUDGET_MS = 30 * 60 * 1000;
// Upstream sometimes skips a daily publish, and the set then ages toward the
// cutoff with nothing wrong on our side. Say so at 36 hours, while a fresh
// publish can still arrive in time.
export const SIGNATURE_NOTICE_AGE_MS = 36 * 60 * 60 * 1000;
export const SIGNATURE_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const SIGNATURE_DNS_NAME = "current.cvd.clamav.net";
// Where the pinned clamav image keeps its databases; clamd loads the newest of
// daily.cld (an updated set) and daily.cvd (the bundled one).
export const SIGNATURE_DATABASE_DIRECTORY = "/var/lib/clamav";
export const SIGNATURE_DAILY_FILES = ["daily.cld", "daily.cvd"];
const SIGNATURE_HEADER_BYTES = 512;

export function scannerProofRoot(env = process.env) {
  const runnerTemp = env.RUNNER_TEMP;
  if (typeof runnerTemp === "string" && runnerTemp && isAbsolute(runnerTemp)) return resolve(runnerTemp);
  return "/tmp";
}

export function scannerProofDirectoryPattern(env = process.env) {
  const root = scannerProofRoot(env).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${root}/${PROOF_DIRECTORY_PREFIX}[a-z0-9]+$`);
}

export function isEligibleClamdPort(port) {
  return Number.isInteger(port)
    && port >= CLAMD_PORT_RANGE.min
    && port <= CLAMD_PORT_RANGE.max
    && !(port >= DISPOSABLE_PORT_RANGE.min && port <= DISPOSABLE_PORT_RANGE.max);
}

/** Keeps exactly the three values the pipeline/storage proofs read. Any other
 * key the CLI reports (S3 credentials, the JWT secret) stays out of the file. */
export function scannerStatusFromSupabaseStatus(raw, connectionString) {
  const status = typeof raw === "string" ? JSON.parse(raw) : raw;
  const selected = {};
  for (const key of SCANNER_STATUS_KEYS) {
    const value = status?.[key];
    if (typeof value !== "string" || !value) throw new Error(`Disposable Supabase status is missing ${key}`);
    selected[key] = value;
  }
  const api = new URL(selected.API_URL);
  if (!["127.0.0.1", "localhost"].includes(api.hostname)) {
    throw new Error("The scanner proof accepts only a loopback disposable Supabase API URL");
  }
  const databasePort = Number(new URL(connectionString).port);
  if (Number(api.port) !== databasePort - 1) {
    throw new Error(`Disposable Supabase API port ${api.port} does not pair with database port ${databasePort}`);
  }
  return selected;
}

/** Mirrors api/_lib/privateFileScanner.js signatureIdentity so CI refuses the
 * exact signature sets production would refuse, before the proof starts. */
export function assessSignatureReply(reply, nowMs, { budgetMs = SIGNATURE_PROOF_BUDGET_MS } = {}) {
  const match = /^(ClamAV \d+\.\d+\.\d+)\/(\d+)\/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/
    .exec(typeof reply === "string" ? reply : "");
  if (!match) return { fresh: false, reason: "unreadable-version-reply" };
  const signedAt = Date.parse(`${match[3]} GMT`);
  const version = Number(match[2]);
  if (!Number.isFinite(nowMs) || !Number.isFinite(signedAt) || !Number.isSafeInteger(version) || version <= 0) {
    return { fresh: false, reason: "unreadable-version-reply" };
  }
  if (signedAt > nowMs + SIGNATURE_FUTURE_SKEW_MS) return { fresh: false, reason: "signatures-dated-in-the-future" };
  const ageMs = nowMs - signedAt;
  if (ageMs > signatureStaleAfterMs(budgetMs)) {
    return { fresh: false, reason: "stale-signatures", engine: match[1], signatureVersion: version, ageMs };
  }
  return { fresh: true, engine: match[1], signatureVersion: version, ageMs };
}

/** The age past which CI refuses a signature set: the adapter's 48 hours less
 * the proof's own budget (47.5 hours). */
export function signatureStaleAfterMs(budgetMs = SIGNATURE_PROOF_BUDGET_MS) {
  return MAX_SIGNATURE_AGE_MS - budgetMs;
}

const formatHours = (ms) => (ms / 3600000).toFixed(2);

/** Reads the build time and version from a daily.cvd / daily.cld header
 * (`ClamAV-VDB:<date>:<version>:<sigs>:<flevel>:<md5>:<dsig>:<builder>:<stime>`,
 * first 512 bytes). `stime` is the epoch second clamd reports as the signature
 * date, so the age comes from the files rather than from freshclam output or
 * the DNS record. */
export function parseSignatureFileHeader(header) {
  const text = Buffer.isBuffer(header) ? header.toString("latin1") : String(header ?? "");
  const fields = text.slice(0, SIGNATURE_HEADER_BYTES).split(":");
  if (fields[0] !== "ClamAV-VDB") return null;
  const version = Number(fields[2]);
  const builtAtSeconds = Number(fields[8]);
  if (!Number.isSafeInteger(version) || version <= 0 || !Number.isSafeInteger(builtAtSeconds) || builtAtSeconds <= 0) return null;
  return { signatureVersion: version, builtAtMs: builtAtSeconds * 1000 };
}

/** Age of the newest daily set among the given file headers, with the 36 hour
 * notice and the 47.5 hour stale verdict. */
export function assessSignatureFiles(headers, nowMs, { budgetMs = SIGNATURE_PROOF_BUDGET_MS } = {}) {
  const sets = headers.map(parseSignatureFileHeader).filter(Boolean);
  if (!sets.length || !Number.isFinite(nowMs)) return { readable: false, reason: "unreadable-signature-files" };
  const newest = sets.reduce((best, candidate) => (candidate.signatureVersion > best.signatureVersion ? candidate : best));
  const ageMs = nowMs - newest.builtAtMs;
  if (ageMs < -SIGNATURE_FUTURE_SKEW_MS) return { readable: false, reason: "signatures-dated-in-the-future" };
  return {
    readable: true,
    signatureVersion: newest.signatureVersion,
    builtAtMs: newest.builtAtMs,
    ageMs,
    notice: ageMs >= SIGNATURE_NOTICE_AGE_MS,
    stale: ageMs > signatureStaleAfterMs(budgetMs),
  };
}

/** One line for a set at or past the notice age. `annotate` adds the GitHub
 * Actions annotation prefix so it shows on the run summary. */
export function signatureAgeNoticeLine({ signatureVersion, ageMs }, { annotate = false, budgetMs = SIGNATURE_PROOF_BUDGET_MS } = {}) {
  const text = `ClamAV signature ${signatureVersion} is ${formatHours(ageMs)}h old, past the ${formatHours(SIGNATURE_NOTICE_AGE_MS)}h notice line`
    + `; it is refused at ${formatHours(signatureStaleAfterMs(budgetMs))}h, so a skipped upstream publish now fails the scanner proof.`;
  return annotate ? `::notice title=ClamAV signatures are ageing::${text}` : `NOTICE: ${text}`;
}

/** The daily signature number in a current.cvd.clamav.net TXT value
 * (`<clamav>:<main>:<daily>:<time>:...`), or null. */
export function dnsDailyVersion(record) {
  const daily = Number(String(record ?? "").split(":")[2]);
  return Number.isSafeInteger(daily) && daily > 0 ? daily : null;
}

/** The stale-signatures failure text: measured age, the cutoff, the loaded
 * signature, and the DNS-advertised version, so an upstream gap reads
 * differently from our own update failing. */
export function staleSignatureReason({ reply, assessment, dnsRecord }, { budgetMs = SIGNATURE_PROOF_BUDGET_MS } = {}) {
  const advertised = dnsDailyVersion(dnsRecord);
  let verdict = "upstream state unknown";
  if (advertised === assessment.signatureVersion) verdict = "upstream advertises no newer set, so this is an upstream gap, not a failure on our side";
  else if (advertised > assessment.signatureVersion) verdict = "upstream advertises a newer set than the one loaded, so our update did not fetch it";
  else if (advertised !== null) verdict = "the DNS record is itself behind the loaded set";
  const dns = dnsRecord ? `TXT "${dnsRecord}"` : "TXT could not be read";
  return `stale-signatures: ${assessment.engine} signature ${assessment.signatureVersion} is ${formatHours(assessment.ageMs)}h old, `
    + `past the ${formatHours(signatureStaleAfterMs(budgetMs))}h cutoff (${formatHours(MAX_SIGNATURE_AGE_MS)}h scanner rule less the ${budgetMs / 60000} minute proof budget); `
    + `${SIGNATURE_DNS_NAME} ${dns}; ${verdict} (${reply})`;
}

/** Best effort: the first TXT value of current.cvd.clamav.net, or null. */
export async function lookupSignatureDnsRecord({ resolver, timeoutMs = 5000 } = {}) {
  try {
    const lookup = resolver ?? new Resolver({ timeout: timeoutMs, tries: 2 });
    const records = await lookup.resolveTxt(SIGNATURE_DNS_NAME);
    const first = records?.[0];
    return Array.isArray(first) ? first.join("") : null;
  } catch {
    return null;
  }
}

/** Reads the daily headers from the scanner container publishing `port`. Returns
 * [] when docker or the files are unavailable; the caller then relies on the
 * zVERSION date. */
export function readSignatureHeadersFromContainer(port, { run = execFileSync } = {}) {
  const options = { encoding: "latin1", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 };
  let name;
  try {
    name = String(run("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], options)).split("\n")[0].trim();
  } catch {
    return [];
  }
  if (!name) return [];
  const headers = [];
  for (const file of SIGNATURE_DAILY_FILES) {
    try {
      headers.push(String(run("docker", ["exec", name, "head", "-c", String(SIGNATURE_HEADER_BYTES), `${SIGNATURE_DATABASE_DIRECTORY}/${file}`], options)));
    } catch {
      // daily.cld exists only after an update; daily.cvd only until one replaces it.
    }
  }
  return headers;
}

function portIsFree(port) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

/** Starts at a uniformly random offset (randomInt, no modulo bias) and walks
 * the whole range once, wrapping, so every eligible port is still tried. */
export async function chooseClamdPort(isFree = portIsFree, pickOffset = randomInt) {
  const span = CLAMD_PORT_RANGE.max - CLAMD_PORT_RANGE.min + 1;
  const offset = pickOffset(span);
  for (let attempt = 0; attempt < span; attempt += 1) {
    const port = CLAMD_PORT_RANGE.min + ((offset + attempt) % span);
    if (!isEligibleClamdPort(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`No free scanner port in ${CLAMD_PORT_RANGE.min}-${CLAMD_PORT_RANGE.max}`);
}

function openssl(directory, args) {
  execFileSync("openssl", args, { cwd: directory, stdio: ["ignore", "ignore", "pipe"] });
}

/** Generates a throwaway CA plus a localhost server leaf and a client leaf.
 * The proof's TLS proxy presents the server leaf and demands the client leaf,
 * so the adapter's real mutual-TLS path is exercised, not stubbed. */
export function writeScannerFixtures(directory) {
  const extensions = {
    "server.ext": [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    "client.ext": [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      `subjectAltName=DNS:${SCANNER_CLIENT_IDENTITIES.production}`,
    ],
    "sample-client.ext": [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      `subjectAltName=DNS:${SCANNER_CLIENT_IDENTITIES.sample}`,
    ],
  };
  for (const [name, lines] of Object.entries(extensions)) {
    writeFileSync(join(directory, name), `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  openssl(directory, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-noenc",
    "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=unionground-upload-proof-ca",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  for (const [role, subject] of [
    ["server", "/CN=localhost"],
    ["client", `/CN=${SCANNER_CLIENT_IDENTITIES.production}`],
    ["sample-client", `/CN=${SCANNER_CLIENT_IDENTITIES.sample}`],
  ]) {
    openssl(directory, [
      "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-noenc",
      "-keyout", `${role}.key`, "-out", `${role}.csr`, "-subj", subject,
    ]);
    openssl(directory, [
      "x509", "-req", "-in", `${role}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", `${role}.crt`, "-days", "1", "-extfile", `${role}.ext`,
    ]);
  }
  for (const scratch of [
    "ca.key", "ca.srl",
    "server.csr", "server.ext",
    "client.csr", "client.ext",
    "sample-client.csr", "sample-client.ext",
  ]) {
    rmSync(join(directory, scratch), { force: true });
  }
  return SCANNER_FIXTURE_FILES.map((name) => join(directory, name));
}

export function scannerProofEnvironmentLines(entries) {
  const names = Object.keys(entries);
  if (names.length !== SCANNER_PROOF_ENV_NAMES.length || names.some((name) => !SCANNER_PROOF_ENV_NAMES.includes(name))) {
    throw new Error("The scanner proof exports exactly its four documented environment names");
  }
  return SCANNER_PROOF_ENV_NAMES.map((name) => `${name}=${entries[name]}`);
}

function exportEnvironment(entries) {
  const body = `${scannerProofEnvironmentLines(entries).join("\n")}\n`;
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, body);
  process.stdout.write(body);
}

function exchange(port, command, timeoutMs) {
  return new Promise((resolvePromise) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => socket.write(Buffer.from(`${command}\0`)));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 4096) finish(null);
    });
    socket.once("end", () => finish(received.toString("ascii").replaceAll("\0", "").trim()));
    socket.once("error", () => finish(null));
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

async function pollScanner({ port, deadlineAt, probe }) {
  let last = "no reply";
  while (Date.now() < deadlineAt) {
    const outcome = await probe(port);
    if (outcome.ok) return outcome;
    last = outcome.detail;
    await sleep(3000);
  }
  throw new Error(`Pinned malware scanner never became usable: ${last}`);
}

function requiredClamdPort() {
  const port = Number(process.env.PRIVATE_FILE_PIPELINE_CLAMD_PORT);
  if (!isEligibleClamdPort(port)) {
    throw new Error("PRIVATE_FILE_PIPELINE_CLAMD_PORT must name the prepared scanner port");
  }
  return port;
}

async function awaitScanner() {
  const port = requiredClamdPort();
  await pollScanner({
    port,
    deadlineAt: Date.now() + 300000,
    probe: async (target) => {
      const reply = await exchange(target, "zPING", 5000);
      return reply === "PONG" ? { ok: true } : { ok: false, detail: `PING replied ${reply ?? "nothing"}` };
    },
  });
  process.stdout.write(`Pinned malware scanner answered PING on 127.0.0.1:${port}.\n`);
}

async function assertSignatures() {
  const port = requiredClamdPort();
  let lastStale = null;
  let outcome;
  try {
    outcome = await pollScanner({
      port,
      deadlineAt: Date.now() + 300000,
      probe: async (target) => {
        const reply = await exchange(target, "zVERSION", 5000);
        const assessment = assessSignatureReply(reply, Date.now());
        lastStale = assessment.reason === "stale-signatures" ? { reply, assessment } : null;
        return assessment.fresh
          ? { ok: true, assessment }
          : { ok: false, detail: `${assessment.reason} (${reply ?? "no reply"})` };
      },
    });
  } catch (error) {
    if (!lastStale) throw error;
    // One lookup, after polling gave up: the DNS value is only context for the failure.
    const dnsRecord = await lookupSignatureDnsRecord();
    throw new Error(`Pinned malware scanner never became usable: ${staleSignatureReason({ ...lastStale, dnsRecord })}`, { cause: error });
  }
  process.stdout.write(
    `Pinned malware scanner reports ${outcome.assessment.engine} signature ${outcome.assessment.signatureVersion}, ${formatHours(outcome.assessment.ageMs)}h old.\n`,
  );
  // The notice reads the loaded daily's build time from its file header, not the zVERSION reply.
  const files = assessSignatureFiles(readSignatureHeadersFromContainer(port), Date.now());
  if (files.readable) {
    process.stdout.write(`Signature files: daily ${files.signatureVersion} built ${new Date(files.builtAtMs).toISOString()}, ${formatHours(files.ageMs)}h old.\n`);
  }
  const aged = files.readable ? files : outcome.assessment;
  if (aged.ageMs >= SIGNATURE_NOTICE_AGE_MS) {
    process.stdout.write(`${signatureAgeNoticeLine(aged, { annotate: process.env.GITHUB_ACTIONS === "true" })}\n`);
  }
}

/** --signature-age --directory <database directory>: the monitor for any host
 * that can read the daily files. Prints the age, adds the notice line from 36
 * hours, and fails from the cutoff or when the files cannot be read. */
function signatureAgeFromDirectory(argv) {
  if (argv[0] !== "--directory" || !argv[1]) throw new Error("--signature-age requires --directory <signature database directory>");
  const directory = resolve(argv[1]);
  const headers = readdirSync(directory)
    .filter((name) => SIGNATURE_DAILY_FILES.includes(name))
    .map((name) => readFileSync(join(directory, name)).subarray(0, SIGNATURE_HEADER_BYTES));
  const files = assessSignatureFiles(headers, Date.now());
  if (!files.readable) throw new Error(`Signature age unavailable: ${files.reason} in ${directory}`);
  process.stdout.write(`Signature files: daily ${files.signatureVersion} built ${new Date(files.builtAtMs).toISOString()}, ${formatHours(files.ageMs)}h old.\n`);
  if (files.notice) process.stdout.write(`${signatureAgeNoticeLine(files)}\n`);
  if (files.stale) throw new Error(`Signatures are past the ${formatHours(signatureStaleAfterMs())}h cutoff`);
}

async function prepare() {
  const workdir = process.env.CI_DB_WORKDIR;
  if (!workdir || !isAbsolute(workdir)) throw new Error("CI_DB_WORKDIR must name the started disposable Supabase workdir");
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is required to pair the disposable API and database ports");

  const root = scannerProofRoot();
  const suffix = randomBytes(9).toString("hex");
  const directory = join(root, `${PROOF_DIRECTORY_PREFIX}${suffix}`);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  if (!scannerProofDirectoryPattern().test(directory)) {
    throw new Error(`Refusing an unexpected scanner fixture directory: ${directory}`);
  }
  writeScannerFixtures(directory);

  const rawStatus = execFileSync(
    join(ROOT, "node_modules", ".bin", "supabase"),
    ["--workdir", workdir, "status", "-o", "json"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const status = scannerStatusFromSupabaseStatus(rawStatus.slice(rawStatus.indexOf("{")), connectionString);
  const statusPath = join(directory, "supabase-status.json");
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });

  const clamdPort = await chooseClamdPort();
  exportEnvironment({
    PRIVATE_FILE_PIPELINE_SCANNER_DIR: directory,
    PRIVATE_FILE_STORAGE_STATUS_FILE: statusPath,
    PRIVATE_FILE_PIPELINE_CLAMD_PORT: String(clamdPort),
    PRIVATE_FILE_PIPELINE_ARTIFACT: join(root, `${PROOF_ARTIFACT_PREFIX}${suffix}.json`),
  });
}


// ---------------------------------------------------------------------------
// --canary: the operator-side §6.5 / §6.4 acceptance probe.
//
// This is the authoritative canary, and it is authoritative precisely because
// it runs the SHIPPED adapter — the same three-connection exchange, the same
// post-handshake SPKI assertion before a byte is written, the same
// reply-through-EOF parser, the same engine floor and 48-hour freshness rule
// that api/private-files.js gets in production. A bespoke probe can pass while
// the real path fails; this one cannot.
//
// It is read-only against the scanner alone: no hosted database, no Storage, no
// Vercel involvement. Run it at provisioning before the seven values are set,
// after every certificate renewal, and whenever the on-host watchdog disagrees
// with expectations.
// ---------------------------------------------------------------------------

// The canonical 68-byte EICAR test string, assembled the way the pipeline proof
// assembles it. It is a detection fixture, not malware.
export const CANARY_EICAR = Buffer.from(String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);
export const CANARY_CLEAN = Buffer.from("Union Ground private upload scanner canary fixture");
// The scanner is refused outright at 48 hours. Warn far earlier: at 24 hours
// everything still works, which is the only moment an alert is actionable.
export const CANARY_WARN_AGE_MS = 24 * 60 * 60 * 1000;

/** Turns the two attestations into a pass/fail verdict, so the whole rule is
 * testable without a scanner. `blocked` for EICAR is the only proof that the
 * engine still DETECTS rather than merely answers. */
export function assessCanaryScans({ eicar, clean }, nowMs, { warnAgeMs = CANARY_WARN_AGE_MS } = {}) {
  const failures = [];
  if (eicar?.verdict !== "blocked") failures.push(`EICAR returned ${eicar?.verdict ?? "no verdict"}, not blocked`);
  if (clean?.verdict !== "clean") failures.push(`the clean fixture returned ${clean?.verdict ?? "no verdict"}, not clean`);
  const identity = ["engine", "signatureVersion", "signatureDate"]
    .every((field) => eicar?.[field] !== undefined && eicar?.[field] === clean?.[field]);
  if (!identity) failures.push("the two scans saw different signature identities");
  const signedAt = Date.parse(String(clean?.signatureDate ?? ""));
  const ageMs = Number.isFinite(signedAt) && Number.isFinite(nowMs) ? nowMs - signedAt : Number.NaN;
  if (!Number.isFinite(ageMs)) failures.push("the signature date could not be read");
  else if (ageMs > warnAgeMs) failures.push(`signatures are ${(ageMs / 3600000).toFixed(2)}h old, past the ${(warnAgeMs / 3600000)}h warn threshold`);
  return {
    ok: failures.length === 0,
    failures,
    engine: clean?.engine,
    signatureVersion: clean?.signatureVersion,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    scannerSpki: clean?.scannerSpki,
  };
}

/** Assembles the adapter's seven-value configuration from the offline CA
 * directory ops/scanner/bin/generate-ca.sh writes. The pin is DERIVED from
 * server.crt rather than typed in, so the probe cannot pass against a value
 * that has drifted away from the listener. */
export function canaryConfigurationFromDirectory(directory, {
  host, port, identity = "unionground-scanner-canary", engineMin = "1.5.4", readFile = readFileSync,
} = {}) {
  const pem = (name) => readFile(join(directory, name), "utf8");
  const spki = createHash("sha256")
    .update(new X509Certificate(pem("server.crt")).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  return {
    host, port: Number(port), ca: pem("ca.crt"), cert: pem(`${identity}.crt`), key: pem(`${identity}.key`),
    expectedSpki: spki, engineMin,
  };
}

function canaryArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = String(argv[index] ?? "");
    if (!name.startsWith("--")) throw new Error(`Unexpected canary argument ${name}`);
    flags[name.slice(2)] = argv[index + 1];
  }
  for (const required of ["directory", "host", "port"]) {
    if (!flags[required]) throw new Error(`--canary requires --${required}`);
  }
  return flags;
}

async function runCanary() {
  const flags = canaryArguments(process.argv.slice(3));
  // Imported here rather than at module scope so the CI provisioning paths keep
  // their existing, minimal import graph.
  const { scanPrivateFileWithClamd } = await import(pathToFileURL(join(ROOT, "api", "_lib", "privateFileScanner.js")).href);
  const config = canaryConfigurationFromDirectory(resolve(flags.directory), flags);
  const eicar = await scanPrivateFileWithClamd(CANARY_EICAR, { config, timeoutMs: 20000 });
  const clean = await scanPrivateFileWithClamd(CANARY_CLEAN, { config, timeoutMs: 20000 });
  const assessment = assessCanaryScans({ eicar, clean }, Date.now());
  // The attestation §6.3 asks to be recorded, minus anything about the fixtures
  // themselves. No digest of member data ever exists here: both inputs are
  // constants in this file.
  process.stdout.write(`${JSON.stringify({
    host: flags.host, port: Number(flags.port), identity: flags.identity ?? "unionground-scanner-canary",
    engine: assessment.engine, signatureVersion: assessment.signatureVersion,
    signatureDate: clean.signatureDate, ageHours: assessment.ageMs === null ? null : Number((assessment.ageMs / 3600000).toFixed(2)),
    scannerSpki: assessment.scannerSpki, engineMin: config.engineMin,
    eicarVerdict: eicar.verdict, cleanVerdict: clean.verdict,
    ok: assessment.ok, failures: assessment.failures,
    checkedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  if (!assessment.ok) throw new Error(`Scanner canary failed: ${assessment.failures.join("; ")}`);
}

async function main() {
  const mode = process.argv[2] ?? "--prepare";
  if (mode === "--prepare") return prepare();
  if (mode === "--await-scanner") return awaitScanner();
  if (mode === "--assert-signatures") return assertSignatures();
  if (mode === "--canary") return runCanary();
  if (mode === "--signature-age") return signatureAgeFromDirectory(process.argv.slice(3));
  throw new Error(`Unsupported mode ${mode}; use --prepare, --await-scanner, --assert-signatures, --signature-age or --canary`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
