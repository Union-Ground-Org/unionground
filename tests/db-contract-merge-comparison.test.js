// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assessRlsTables } from '../scripts/lib/db-contract-tables.mjs';

const fixture = JSON.parse(readFileSync('tests/fixtures/db-contract-merge/comparison.json'));
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function compare(layout) {
  const root = mkdtempSync(join(tmpdir(), 'db-contract-merge-')); roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n'); };
  const commit = label => { git('add', '.'); git('commit', '-qm', label); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'Main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  put('scripts/db-contract.json', fixture[layout].base);
  if (layout === 'new') for (const table of fixture.catalogBase) put(`scripts/db-contract-tables/${table}.json`, { table });
  const base = commit('documented common base');
  const heads = [];
  for (const branch of ['A', 'B']) {
    git('checkout', '-q', '-b', branch, base);
    if (layout === 'new') {
      for (const [name, entry] of Object.entries(fixture.new[`branch${branch}`])) put(`scripts/db-contract-tables/${name}`, entry);
    } else put('scripts/db-contract.json', fixture[layout][`branch${branch}`]);
    heads.push(commit(`independent addition ${branch}`));
  }
  const merge = spawnSync('git', ['merge-tree', '--write-tree', ...heads], { cwd: root, encoding: 'utf8' });
  const tree = merge.stdout.split('\n')[0];
  return { git, merge, tree, contract: () => JSON.parse(git('show', `${tree}:scripts/db-contract.json`)) };
}

it('replays the old N+1 collision: a clean textual merge leaves the wrong total', () => {
  const result = compare('old');
  expect(result.merge.status, result.merge.stdout + result.merge.stderr).toBe(0);
  const count = result.contract().policyCoverage.rlsTableCount;
  const actual = [...fixture.catalogBase, fixture.additionA, fixture.additionB].map(table => ({ tbl: table.slice(7), rls: true }));
  expect(assessRlsTables({ count, tables: null }, actual)).toEqual([
    expect.objectContaining({ ok: false, expected: 3, observed: 4 }),
  ]);
});

it('merges independent per-table files with an unchanged contract and exact combined coverage', () => {
  const result = compare('new');
  expect(result.merge.status, result.merge.stdout + result.merge.stderr).toBe(0);
  expect(result.contract()).toEqual(fixture.new.base);
  const tables = result.git('ls-tree', '-r', '--name-only', result.tree, '--', 'scripts/db-contract-tables')
    .split('\n').map(path => JSON.parse(result.git('show', `${result.tree}:${path}`)).table);
  const actual = [...fixture.catalogBase, fixture.additionA, fixture.additionB].map(table => ({ tbl: table.slice(7), rls: true }));
  expect(tables).toHaveLength(4);
  expect(assessRlsTables({ tables }, actual).every(check => check.ok)).toBe(true);
});

it('reports the remaining textual conflict for insertions between the same sorted neighbours', () => {
  const result = compare('sameSortedNeighbours');
  expect(result.merge.status).toBe(1);
  expect(result.merge.stdout).toContain('CONFLICT');
  expect(result.merge.stdout).toContain('scripts/db-contract.json');
});
