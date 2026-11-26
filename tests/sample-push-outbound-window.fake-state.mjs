// The fake Management API state file shared by tests/sample-push-outbound-window.test.js
// and the window tool's processes (tests/sample-push-outbound-window.fake-fetch.mjs).
// Every read-modify-write runs under one lock, so no writer can rename a stale
// copy over another process's update. Without it a clock advance from the test
// reverted the restore's cancellation and let a held opening raise match its
// fence again (BUG-UG-SAMPLE-PUSH-WINDOW-TEST-LOST-UPDATE-REENABLES-AFTER-RESTORE-20261013).
//
// The lock is a sequence of generations: `<file>.held.<n>` names its holder and
// `<file>.released.<n>` ends it, both created exclusively and never changed.
// The tests SIGKILL window processes at arbitrary points, so a waiter releases
// a generation whose holder is dead; because a generation's holder never
// changes, that can never release a live holder's lock.
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));
const nextGeneration = new Map();

const procfs = existsSync("/proc/self/stat");
// The process state and start time from /proc, or null when it is gone.
const procStat = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return { state: fields[0], started: fields[19] };
  } catch {
    return null;
  }
};
// A holder is named by its pid and start time, so a reused pid is not mistaken
// for it. A killed holder stays a zombie until its parent reaps it, and the
// parent may be the process spinning here, so zombies count as dead.
const identityOf = (pid) => (procfs ? `${pid} ${procStat(pid).started}` : String(pid));
const alive = (identity) => {
  const [pid, started] = identity.split(" ");
  if (procfs) {
    const stat = procStat(pid);
    return Boolean(stat) && !"ZX".includes(stat.state) && (started === undefined || stat.started === started);
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const release = (file, generation) => {
  try {
    writeFileSync(`${file}.released.${generation}`, "", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};

export const readState = (file) => JSON.parse(readFileSync(file, "utf8"));

// Runs change(state) under the lock, writes the state back atomically and
// returns what change returned.
export function updateState(file, change) {
  const identity = `${file}.holder.${process.pid}`;
  writeFileSync(identity, identityOf(process.pid));
  let generation = nextGeneration.get(file) ?? 0;
  try {
    for (;;) {
      while (existsSync(`${file}.released.${generation}`)) generation += 1;
      try {
        linkSync(identity, `${file}.held.${generation}`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (!alive(readFileSync(`${file}.held.${generation}`, "utf8"))) release(file, generation);
      else Atomics.wait(pause, 0, 0, 1);
    }
  } finally {
    unlinkSync(identity);
  }
  nextGeneration.set(file, generation + 1);
  try {
    const state = readState(file);
    const result = change(state);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
    return result;
  } finally {
    release(file, generation);
  }
}
