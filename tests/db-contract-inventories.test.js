// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventoryOrderIssues, sortContractInventories } from '../scripts/lib/db-contract-inventories.mjs';
import { readRlsTableInventory, requireRlsTables, assessRlsTables } from '../scripts/lib/db-contract-tables.mjs';
import { migrationFiles, stripComments } from './helpers/migration.js';

const contract = JSON.parse(readFileSync('scripts/db-contract.json', 'utf8'));
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(tables = ['public.alpha', 'public.beta']) {
  const root = mkdtempSync(join(tmpdir(), 'db-contract-tables-')); roots.push(root);
  const path = join(root, 'db-contract.json');
  const folder = join(root, 'db-contract-tables'); mkdirSync(folder);
  for (const table of tables) writeFileSync(join(folder, `${table}.json`), JSON.stringify({ table }) + '\n');
  return { root, path, folder, contract: { policyCoverage: { rlsTableFormat: 'table-files-v1' } } };
}

it('keeps every object inventory sorted without changing entries, property order or narrative arrays', () => {
  const before = structuredClone(contract);
  const sorted = sortContractInventories(before);
  expect(inventoryOrderIssues(sorted)).toEqual([]);
  expect(sorted._readme).toEqual(contract._readme);
  expect(sorted.knownGaps._readme).toEqual(contract.knownGaps._readme);
  expect(sorted.functions.map(JSON.stringify).sort()).toEqual(contract.functions.map(JSON.stringify).sort());
  expect(inventoryOrderIssues(contract)).toEqual([]);
});

it('uses complete identities and reports the correct insertion point for unsorted additions', () => {
  const sample = { functions: [{ sig: 'public.z(p_id uuid)' }, { sig: 'public.a(p_id text)' }, { sig: 'public.a(p_id uuid)' }],
    tableGrants: [{ table: 'public.a', role: 'service_role' }, { table: 'public.a', role: 'anon' }],
    policies: [{ table: 'z', name: 'a' }, { table: 'a', name: 'z' }], _readme: ['z', 'a'] };
  expect(inventoryOrderIssues(sample).join('\n')).toMatch(/functions\[1\].*public.a.*before.*public.z/);
  expect(inventoryOrderIssues(sample).join('\n')).toMatch(/tableGrants\[1\].*anon.*before.*service_role/);
  expect(sortContractInventories(sample)._readme).toEqual(['z', 'a']);
  expect(sortContractInventories(sample).functions.map(e => e.sig)).toEqual(['public.a(p_id text)', 'public.a(p_id uuid)', 'public.z(p_id uuid)']);
});

it('reads table files relative to the selected contract and compares names in both directions', () => {
  const f = fixture();
  const inventory = readRlsTableInventory(f.contract, f.path);
  expect(inventory.tables).toEqual(['public.alpha', 'public.beta']);
  expect(inventory.count).toBe(2);
  expect(() => requireRlsTables(f.contract, ['alpha'], f.path)).not.toThrow();
  expect(() => requireRlsTables(f.contract, ['missing'], f.path)).toThrow('public.missing');
  const results = assessRlsTables(inventory, [{ tbl: 'alpha', rls: true }, { tbl: 'gamma', rls: true }]);
  expect(results.filter(r => !r.ok)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: expect.stringContaining('public.beta') }),
    expect.objectContaining({ name: expect.stringContaining('public.gamma') }),
  ]));
  expect(results.some(r => r.ok && r.name.includes('public.alpha'))).toBe(true);
});

it.each(['missing', 'empty', 'bad-json', 'wrong-name', 'wrong-schema', 'symlink', 'subfolder', 'unknown-file'])(
  'fails closed on a %s table folder even if an old number is present', kind => {
    const f = fixture([]); f.contract.policyCoverage.rlsTableCount = 2;
    if (kind === 'missing') rmSync(f.folder, { recursive: true });
    if (kind === 'bad-json') writeFileSync(join(f.folder, 'public.a.json'), '{');
    if (kind === 'wrong-name') writeFileSync(join(f.folder, 'public.a.json'), '{"table":"public.b"}');
    if (kind === 'wrong-schema') writeFileSync(join(f.folder, 'private.a.json'), '{"table":"private.a"}');
    if (kind === 'symlink') symlinkSync(f.path, join(f.folder, 'public.a.json'));
    if (kind === 'subfolder') mkdirSync(join(f.folder, 'public.a.json'));
    if (kind === 'unknown-file') writeFileSync(join(f.folder, 'README.md'), 'not a table');
    expect(() => readRlsTableInventory(f.contract, f.path)).toThrow();
  },
);

it('keeps the retained number format, refuses invalid/unknown formats and guards non-empty inventories', () => {
  const old = readRlsTableInventory({ policyCoverage: { rlsTableCount: 2 } });
  expect(assessRlsTables(old, [{ tbl: 'a', rls: true }, { tbl: 'b', rls: true }]).every(r => r.ok)).toBe(true);
  expect(assessRlsTables(old, [{ tbl: 'a', rls: true }]).some(r => !r.ok)).toBe(true);
  for (const coverage of [{ rlsTableCount: 0 }, {}, { rlsTableFormat: 'unknown', rlsTableCount: 2 }]) {
    expect(() => readRlsTableInventory({ policyCoverage: coverage })).toThrow();
  }
  expect(() => requireRlsTables(fixture().contract, [])).toThrow();
});

it('pins the exact public RLS table identities from reviewed migration DDL, including removals', () => {
  const enabled = new Set();
  for (const { sql } of migrationFiles()) {
    const ddl = stripComments(sql);
    for (const match of ddl.matchAll(/\b(alter\s+table\s+(?:if\s+exists\s+)?|drop\s+table\s+(?:if\s+exists\s+)?)(public\.[a-z_0-9]+)(\s+(?:enable|disable)\s+row\s+level\s+security)?/giu)) {
      const [, operation, table, rls] = match;
      if (/^drop/iu.test(operation) || /disable/iu.test(rls ?? '')) enabled.delete(table);
      else if (rls) enabled.add(table);
    }
  }
  expect(enabled.size).toBeGreaterThan(0);
  expect(readRlsTableInventory(contract).tables).toEqual([...enabled].sort());
});
