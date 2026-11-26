// @vitest-environment node
// The heavy-cluster admission lock in tamarack-postgres-helper.mjs: one
// holder at a time across processes, refcounted within a thread, and a
// lock left by a dead holder is stolen instead of waited on forever. The
// test drives a private lock on its own scratch path, never the
// machine-wide file the heavy seed suites hold, so it neither waits behind
// them nor writes into their lock.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableClusterLock, heavyClusterLock } from './tamarack-postgres-helper.mjs';

const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'tvpg-lock-test-'));
const lockPath = join(scratch, 'tvpg-heavy-cluster.lock');
const lock = createDisposableClusterLock(lockPath);
const helper = new URL('./tamarack-postgres-helper.mjs', import.meta.url).href;
const childScript = join(scratch, 'child.mjs');
writeFileSync(childScript, `import {createDisposableClusterLock} from ${JSON.stringify(helper)};
const lock = createDisposableClusterLock(process.argv[2]);
await lock.acquire();
process.stdout.write('acquired\\n');
lock.release();
`);
const runChild = () => new Promise((resolve, reject) => {
  execFile(process.execPath, [childScript, lockPath], (error, stdout) => error ? reject(error) : resolve(stdout));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('disposable cluster admission lock', () => {
  it('holds one holder across processes, refcounts within a thread, and steals a dead holder lock', async () => {
    expect(lock.lockPath).not.toBe(heavyClusterLock.lockPath);
    expect(dirname(lock.lockPath)).toBe(scratch);
    await lock.acquire();
    await lock.acquire();
    let childDone = false;
    const waiting = runChild().then((out) => { childDone = true; return out; });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(childDone).toBe(false);
    lock.release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(childDone).toBe(false);
    lock.release();
    await expect(waiting).resolves.toBe('acquired\n');
    writeFileSync(lockPath, '99999999:0');
    await lock.acquire();
    lock.release();
  }, 60000);
});
