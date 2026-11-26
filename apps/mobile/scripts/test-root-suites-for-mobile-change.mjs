#!/usr/bin/env node
// TEST-UG-MOBILE-TEST-HARNESS-LEDGER-BATCH-3-20261113 (ledger 138): runs the
// root suites under tests/ that the Mobile application check runs for this
// branch's phone change, chosen by the same selection CI uses
// (scripts/lib/ci-mobile-root-impact.mjs), so a native file that a root suite
// reaches is proven before the push (#8559). The changed paths are this
// branch's commits since its merge base with the base ref plus uncommitted and
// untracked files. Needs the root packages installed (npm ci at the root).
//   npm run test:root-suites                        run the selected suites
//   npm run test:root-suites -- --list              print the selection only
//   npm run test:root-suites -- --base origin/Main  compare with another ref
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(mobileRoot, '../..');

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

export function changedPaths(base = 'origin/Main') {
  const [mergeBase] = git(['merge-base', base, 'HEAD']);
  return [...new Set([
    ...git(['diff', '--name-only', `${mergeBase}...HEAD`]),
    ...git(['diff', '--name-only', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf('--base');
  const base = baseAt === -1 ? 'origin/Main' : args[baseAt + 1];
  if (!base) throw new Error('--base needs a ref');
  const { discoverMobileRootSuites, selectMobileRootSuites } = await import(join(repoRoot, 'scripts/lib/ci-mobile-root-impact.mjs'));
  const decision = selectMobileRootSuites({ changedPaths: changedPaths(base), suites: discoverMobileRootSuites({ root: repoRoot }) });
  console.log(`Root suites for this phone change (${decision.mode}, against ${base}): ${decision.suites.length}`);
  if (args.includes('--list')) for (const suite of decision.suites) console.log(suite);
  else if (decision.suites.length > 0) {
    const vitest = join(repoRoot, 'node_modules/.bin/vitest');
    if (!existsSync(vitest)) throw new Error('the root packages are not installed: run npm ci at the repository root first');
    // The same command the Mobile application check runs.
    const run = spawnSync(vitest, ['run', '--pool=threads', '--maxWorkers=2', ...decision.suites], { cwd: repoRoot, stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  }
}
