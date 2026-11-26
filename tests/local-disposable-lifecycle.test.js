// @vitest-environment node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { executeOwned, runLocalDatabaseCommand } from "../scripts/run-local-disposable-db.mjs";

async function fixture(run, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "local-db-lifecycle-test-"));
  let prepared;
  const calls = [];
  const options = { tempRoot: root, cli: "fake-supabase", checkPorts: () => {},
    env: { DATABASE_URL: "hosted", SUPABASE_SERVICE_ROLE_KEY: "private", SUPABASE_SECRET_KEY: "private", E2E_SUPABASE_URL: "hosted" }, log: () => {},
    prepare: async ({ tempRoot }) => {
      const workdir = join(tempRoot, "unionground-lab-ci-fixture"); mkdirSync(workdir);
      prepared = { CI_DB_PROJECT_ID: "unionground-lab-ci-0123456789ab", CI_DB_WORKDIR: workdir, SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55002/postgres" };
      return prepared;
    },
    execute: async (command, args, options) => {
      calls.push({ command, args, options: { ...options, env: { ...options.env } } });
      const result = await run(command, args, options);
      if (args.includes("status") && result.status === 0 && result.stdout === undefined) result.stdout = JSON.stringify({
        DB_URL: prepared.SUPABASE_DB_URL, API_URL: "http://127.0.0.1:55001", ANON_KEY: "local-anon",
        SERVICE_ROLE_KEY: "local-service", JWT_SECRET: "local-jwt",
      });
      return result;
    }, ...overrides };
  try {
    const status = await runLocalDatabaseCommand(["proof", "arg with spaces"], options);
    return { status, calls, prepared, retained: existsSync(prepared?.CI_DB_WORKDIR ?? "") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const exit of [0, 7]) test(`stops its target after command exit ${exit}`, async () => {
  const r = await fixture(async (cmd) => ({ status: cmd === "proof" ? exit : 0 }));
  assert.equal(r.status, exit); assert.equal(r.retained, false);
  const proof = r.calls.find(c => c.command === "proof");
  assert.deepEqual(proof.args, ["arg with spaces"]);
  assert.equal(proof.options.env.DATABASE_URL, r.prepared.SUPABASE_DB_URL);
  assert.equal(proof.options.env.SUPABASE_SERVICE_ROLE_KEY, "local-service");
  assert.equal(proof.options.env.SUPABASE_SECRET_KEY, undefined);
  assert.equal(proof.options.env.E2E_SUPABASE_URL, undefined);
  assert.equal(proof.options.env.SUPABASE_URL, "http://127.0.0.1:55001");
  assert.equal(r.calls[0].options.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.deepEqual(r.calls.find(c => c.args.includes("stop")).args, ["--workdir", r.prepared.CI_DB_WORKDIR, "stop", "--project-id", r.prepared.CI_DB_PROJECT_ID, "--no-backup"]);
});

test("start failure still stops the target and never runs the proof", async () => {
  const r = await fixture(async (cmd) => ({ status: cmd === process.execPath ? 5 : 0 }));
  assert.equal(r.status, 5); assert.equal(r.calls.some(c => c.command === "proof"), false); assert.equal(r.retained, false);
});

test("failed stop retains its workdir and reports failure", async () => {
  const r = await fixture(async (cmd, args) => ({ status: args.includes("stop") ? 3 : 0 }));
  assert.equal(r.status, 1); assert.equal(r.retained, true);
});

test("a successful stop with remaining owned containers retains recovery data", async () => {
  const r = await fixture(async cmd => ({ status: 0, ...(cmd === "docker" ? { stdout: "abc123\n" } : {}) }));
  assert.equal(r.status, 1); assert.equal(r.retained, true);
});

test("rejects an API target that differs from the owned SQL target", async () => {
  const r = await fixture(async (cmd, args) => ({ status: 0, ...(args.includes("status") ? { stdout: JSON.stringify({
    DB_URL: "postgresql://postgres:postgres@127.0.0.1:55002/postgres", API_URL: "http://127.0.0.1:54321",
    ANON_KEY: "other-anon", SERVICE_ROLE_KEY: "other-service", JWT_SECRET: "other-jwt",
  }) } : {}) }));
  assert.equal(r.status, 1); assert.equal(r.calls.some(c => c.command === "proof"), false); assert.equal(r.retained, false);
});

test("unreserved ports fail before startup, say why and still clean their workdir", async () => {
  const lines = [];
  const r = await fixture(async () => ({ status: 0 }), { checkPorts: () => { throw new Error("Reserve 55000-59999 first"); }, log: line => lines.push(line) });
  assert.equal(r.status, 1); assert.equal(r.calls.some(c => c.command === process.execPath), false); assert.equal(r.retained, false);
  assert.deepEqual(lines.slice(0, 2), ["Local database proof failed: Reserve 55000-59999 first", "Local database proof failed; attempting owned-target cleanup"]);
});

test("termination still runs cleanup without the cancelled signal", async () => {
  const controller = new AbortController();
  const r = await fixture(async (cmd) => {
    if (cmd === "proof") { controller.abort("SIGTERM"); return { status: null, signal: "SIGTERM" }; }
    return { status: 0 };
  }, { signal: controller.signal });
  assert.equal(r.status, 143); assert.equal(r.retained, false);
  assert.equal(r.calls.at(-1).options.signal, undefined);
});

test("an unowned target is never passed to stop", async () => {
  const r = await fixture(async () => ({ status: 0 }), {
    prepare: async () => ({ CI_DB_PROJECT_ID: "someone-elses-project", CI_DB_WORKDIR: "/outside" }),
  });
  assert.equal(r.status, 1); assert.equal(r.calls.length, 0);
});

test("real command execution is interruptible", async () => {
  const controller = new AbortController();
  const running = executeOwned(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { signal: controller.signal });
  controller.abort("SIGTERM");
  const result = await running;
  assert.equal(result.signal, "SIGTERM");
});

test("captures a local status response without printing it", async () => {
  const result = await executeOwned(process.execPath, ["-e", "process.stdout.write(JSON.stringify({API_URL:'http://127.0.0.1:55001'}))"], { capture: true });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { API_URL: "http://127.0.0.1:55001" });
});

test("hangup reports shell exit 129 after cleanup", async () => {
  const controller = new AbortController();
  const r = await fixture(async (cmd) => {
    if (cmd === "proof") { controller.abort("SIGHUP"); return { status: null, signal: "SIGHUP" }; }
    return { status: 0 };
  }, { signal: controller.signal });
  assert.equal(r.status, 129);
  assert.equal(r.retained, false);
});

test("a real shell hangup reaches the registered handler and cleanup", async () => {
  const module = new URL("../scripts/run-local-disposable-db.mjs", import.meta.url).href;
  const root = mkdtempSync(join(tmpdir(), "owned-hangup-"));
  const source = `import {withShutdownSignals,runLocalDatabaseCommand} from ${JSON.stringify(module)};
    import {mkdirSync} from 'node:fs';
    process.exitCode=await withShutdownSignals(signal=>runLocalDatabaseCommand(['proof'],{
      tempRoot:${JSON.stringify(root)}, cli:'fake', checkPorts:()=>{}, log:()=>{},
      prepare:async({tempRoot})=>{const workdir=tempRoot+'/target';mkdirSync(workdir);return {CI_DB_PROJECT_ID:'unionground-lab-ci-0123456789ab',CI_DB_WORKDIR:workdir,SUPABASE_DB_URL:'postgresql://postgres:postgres@127.0.0.1:55002/postgres'}},
      signal,execute:async(cmd,args)=>{
        if(cmd==='proof'){const alive=setInterval(()=>{},1000);process.stdout.write('ready\\n');await new Promise(r=>signal.addEventListener('abort',r,{once:true}));clearInterval(alive);return {status:null};}
        if(args.includes('stop'))process.stdout.write('cleanup\\n');
        return {status:0,stdout:args.includes('status')?JSON.stringify({DB_URL:'postgresql://postgres:postgres@127.0.0.1:55002/postgres',API_URL:'http://127.0.0.1:55001',ANON_KEY:'local',SERVICE_ROLE_KEY:'local',JWT_SECRET:'local'}):''};
      }}));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "", sent = false;
  child.stdout.on("data", data => { output += data; if (!sent && output.includes("ready")) { sent = true; child.kill("SIGHUP"); } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(result, { code: 129, signal: null }); assert.match(output, /cleanup/);
  } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("interruption kills a surviving descendant after its leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-process-group-"));
  const marker = join(root, "worker");
  const worker = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000)`;
  const leader = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'}); setInterval(()=>{},1000)`;
  const controller = new AbortController();
  let pid;
  const running = executeOwned(process.execPath, ["-e", leader], { signal: controller.signal });
  try {
    for (let n = 0; n < 200 && !existsSync(marker); n++) await new Promise(r => setTimeout(r, 10));
    assert.ok(existsSync(marker), "descendant installed its signal handler");
    pid = Number(readFileSync(marker, "utf8"));
    const aborted = Date.now();
    controller.abort("SIGTERM");
    await running;
    // The caller is held until the default 2000 ms SIGKILL escalation fires
    // (timers may land a millisecond early against Date.now()).
    const held = Date.now() - aborted;
    assert.ok(held >= 1990, `released ${held} ms after the interruption, before the SIGKILL escalation`);
    const state = () => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]; } catch { return null; } };
    // Read once per sample: a zombie can be reaped between two reads, so a
    // second read of the same sample may see it gone (#6880). Gone or zombie
    // both mean the SIGKILL landed; a live descendant stays live all budget.
    let last = state();
    for (const deadline = Date.now() + 5000; last !== null && last !== "Z" && Date.now() < deadline; last = state()) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(last === null || last === "Z", `surviving descendant was killed before completion (last /proc state ${last})`);
  } finally {
    controller.abort("SIGTERM");
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
    await running;
    rmSync(root, { recursive: true, force: true });
  }
});
