import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { threadId } from "node:worker_threads";
import pg from "pg";

const installs = existsSync("/usr/lib/postgresql") ? readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a)) : [];
const localBin = installs.map((version) => join("/usr/lib/postgresql", version, "bin"))
  .find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")));

let image;
try { image = execFileSync("docker", ["image", "inspect", "postgres:16", "--format", "{{.Id}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim(); } catch { /* optional local test prerequisite */ }
export const postgresBin = localBin || image;

// Reserve the trailing NUL in sockaddr_un.sun_path (104 bytes on Darwin/BSD,
// 108 on Linux). Include the generated directory and PostgreSQL socket name.
const socketPathByteLimit = ["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform) ? 103 : 107;
const socketName = ".s.PGSQL.55492";
const socketFits = directory => Buffer.byteLength(join(directory, socketName), "utf8") <= socketPathByteLimit;

// pg_ctl runs postgres through /bin/sh with its -o string spliced in
// unquoted, and postgres then reads -k as a comma-separated directory list
// (SplitDirectoriesString). So the directory is quoted twice: first as one
// double-quoted list element ("" for an embedded quote), then as one POSIX
// shell word (' written as '\''). Any byte a directory name may hold then
// reaches postgres intact: an apostrophe, a space, a comma, $ or a backtick.
const shellWord = value => `'${value.replaceAll("'", "'\\''")}'`;
export function pgCtlServerOptions(socket, { durable = true } = {}) {
  return `-k ${shellWord(`"${socket.replaceAll('"', '""')}"`)} -h '' -p 55492${durable ? "" : " -c fsync=off -c synchronous_commit=off -c full_page_writes=off"}`;
}
export const localPostgresBin = localBin;

function socketDirectory(scratchRoot) {
  // PG_SOCKET_ROOT names an optional short directory to try after the runner scratch root.
  const scratch = process.env.PG_SOCKET_ROOT ?? "";
  const candidates = [...new Set([scratchRoot, ...(scratch && existsSync(scratch) ? [scratch] : []), "/tmp"])];
  for (const parent of candidates) {
    // Only the byte limit decides: pgCtlServerOptions quotes the directory, so
    // no character in the parent can break pg_ctl's command. mkdtemp normally
    // appends six ASCII characters; validate the actual result too for
    // platform variation.
    if (!socketFits(join(parent, "pr3802pg-XXXXXX"))) continue;
    const directory = mkdtempSync(join(parent, "pr3802pg-"));
    if (socketFits(directory)) return directory;
    rmSync(directory, { recursive: true, force: true });
  }
  throw new Error("No PostgreSQL socket directory fits the Unix pathname byte limit");
}

// Admission for the heaviest disposable-cluster suites (the demo seed bot
// and window proofs): each builds the full canonical seed in its worker, so
// two of them side by side peak past a small runner's memory (measured
// 12.8 GB together against 8 GB on depot-ubuntu-24.04, #9418) and thrash
// into test timeouts, while either fits alone. Acquire at module import
// (top-level await in the test file), NOT inside a timed hook: explicit
// hook budgets are flat on every runner, so a wait inside beforeAll could
// itself time out behind the longer suite. Only suites that opt in wait;
// every other offlinePostgres caller is unchanged. Release in afterAll,
// after close(). If a run is name-filtered so afterAll never fires, the
// lock is freed when the worker process exits and the next run steals it.
// The lock's own unit test builds a private lock on a scratch path through
// createDisposableClusterLock, so it never waits on or writes into the
// machine-wide file the heavy suites hold.
export function createDisposableClusterLock(lockPath) {
  const owner = `${process.pid}:${threadId}`;
  let held = 0;
  function releaseFile() {
    try { if (readFileSync(lockPath, "utf8") === owner) rmSync(lockPath, { force: true }); } catch { /* Already stolen or gone. */ }
  }
  async function acquire() {
    if (held > 0) { held += 1; return; }
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx");
        try { writeSync(fd, owner); } finally { closeSync(fd); }
        held = 1;
        process.once("exit", releaseFile);
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let ownerPid;
      try { ownerPid = Number(readFileSync(lockPath, "utf8").split(":")[0]); } catch { /* Raced release: retry at once. */ continue; }
      let alive = false;
      try { process.kill(ownerPid, 0); alive = true; } catch { /* ESRCH: the holder exited without releasing. */ }
      if (!alive) { try { rmSync(lockPath, { force: true }); } catch { /* Another waiter stole it first. */ } continue; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  function release() {
    if (held === 0) return;
    held -= 1;
    if (held === 0) releaseFile();
  }
  return { lockPath, acquire, release };
}
export const heavyClusterLock = createDisposableClusterLock(join(process.env.RUNNER_TEMP || tmpdir(), "tvpg-heavy-cluster.lock"));
export const acquireDisposableClusterLock = heavyClusterLock.acquire;
export const releaseDisposableClusterLock = heavyClusterLock.release;

// A temporary Unix-socket database. No TCP listener or existing cluster.
export async function offlinePostgres({ durable = true } = {}) {
  const scratchRoot = process.env.RUNNER_TEMP || tmpdir();
  const root = mkdtempSync(join(scratchRoot, "tvpg-"));
  const data = join(root, "data");
  // Unix socket paths must fit PostgreSQL's limit even under a long TMPDIR.
  // Prefer the runner-owned scratch parent: the container chowns the mounted socket
  // directory to its postgres uid, and a sticky /tmp then refuses the host's
  // rmdir (EPERM on the self-hosted arm64 slots, October 23, 2026). A parent
  // the host user owns has no such rule. Only hosts without a local
  // PostgreSQL take the container path. Bound the complete socket pathname by
  // UTF-8 bytes rather than the parent's JavaScript character count.
  let socket;
  let client;
  let started = false;
  let container;
  const control = (args) => execFileSync(join(localBin, "pg_ctl"), args, { stdio: "pipe" });
  const close = async () => {
    if (client) await client.end();
    if (container) {
      // Only this test's scratch mount: restore host cleanup permissions.
      try {
        execFileSync("docker", ["exec", container, "chmod", "-R", "a+rwX", "/var/lib/postgresql/data"], { stdio: "pipe" });
      } catch {
        execFileSync("docker", ["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "chmod", "--mount", `type=bind,source=${data},target=/data`, image, "-R", "a+rwX", "/data"], { stdio: "pipe" });
      }
      execFileSync("docker", ["exec", container, "chmod", "0777", "/var/run/postgresql"], { stdio: "pipe" });
      // /tmp is sticky on Linux: mode 0777 does not let the host remove a
      // socket directory that the container changed to its postgres UID.
      // Restore ownership of this test's bind mount before removing it.
      if (typeof process.getuid === "function") {
        execFileSync("docker", ["exec", container, "chown", `${process.getuid()}:${process.getgid()}`, "/var/run/postgresql"], { stdio: "pipe" });
      }
      execFileSync("docker", ["stop", "--time", "5", container], { stdio: "pipe" });
      execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
    } else if (started) control(["-D", data, "-m", "fast", "-w", "stop"]);
    // A stopped container can leave another uid's files in its bind mounts.
    // Keep the proof result; report each refused cleanup and try the other root.
    for (const directory of [root, socket].filter(Boolean)) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) {
        let ownerUid = "unknown";
        try { ownerUid = lstatSync(directory).uid; } catch { /* Cleanup diagnostics are best-effort too. */ }
        console.warn(`PostgreSQL scratch cleanup warning: ${error.code ?? "UNKNOWN"} removing ${directory} owner_uid=${ownerUid}`);
      }
    }
  };
  try {
    socket = socketDirectory(scratchRoot);
    mkdirSync(data);
    if (localBin) {
      execFileSync(join(localBin, "initdb"), ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale", ...(!durable ? ["--no-sync"] : [])], { stdio: "pipe" });
      control(["-D", data, "-l", join(root, "postgres.log"), "-o", pgCtlServerOptions(socket, { durable }), "-w", "start"]);
      started = true;
    } else {
      chmodSync(socket, 0o777);
      container = execFileSync("docker", ["run", "--detach", "--pull=never", "--network=none", "--memory=1g", "--memory-swap=1g",
        "--mount", `type=bind,source=${data},target=/var/lib/postgresql/data`,
        "--mount", `type=bind,source=${socket},target=/var/run/postgresql`, "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "PGPORT=55492",
        ...(!durable ? ["--env", "POSTGRES_INITDB_ARGS=--no-sync"] : []),
        image, "postgres", "-c", "listen_addresses=", "-c", "unix_socket_directories=/var/run/postgresql", "-c", "port=55492",
        ...(!durable ? ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"] : [])], { encoding: "utf8", stdio: "pipe" }).trim();
    }
    if (container) {
      // Up to 90 s: a loaded host can take far longer than 15 s to bootstrap the cluster.
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const log = execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        if (log.includes("PostgreSQL init process complete; ready for start up.")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    let lastError;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = new pg.Client({ host: socket, port: 55492, user: "postgres", database: "postgres" });
      try { await candidate.connect(); client = candidate; break; } catch (error) { lastError = error.message; await candidate.end(); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!client) throw new Error("Offline PostgreSQL did not start (" + lastError + "): " + execFileSync("docker", ["logs", container], {encoding:"utf8"}));
    return { client, close };
  } catch (error) { try { await close(); } catch { /* Preserve startup diagnostic. */ } throw error; }
}
