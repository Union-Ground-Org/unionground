import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RLS_TABLE_FORMAT = 'table-files-v1';
export const RLS_TABLE_FOLDER = 'db-contract-tables';
// Source-only verifiers/tests read this checkout's contract wherever they run
// from; the live/deployed checker always supplies its selected DB_CONTRACT_PATH.
export const defaultContractPath = resolve(dirname(fileURLToPath(import.meta.url)), '../db-contract.json');
const TABLE = /^public\.[a-z_][a-z0-9_]*$/u;

export function parseRlsTableFile(name, bytes) {
  const table = name.replace(/\.json$/u, '');
  if (!TABLE.test(table) || name !== `${table}.json`) throw Error(`Invalid RLS table file name: ${name}`);
  const entry = JSON.parse(bytes.toString('utf8'));
  if (!entry || Object.keys(entry).length !== 1 || entry.table !== table) {
    throw Error(`RLS table file ${name} must contain exactly {"table":"${table}"}`);
  }
  return table;
}

// A marker always selects its folder. A stale old count can never rescue a
// missing or invalid new-format export; an unknown marker fails closed too.
export function usesRlsTableFiles(contract) {
  const marker = contract.policyCoverage?.rlsTableFormat;
  if (marker === undefined) return false;
  if (marker !== RLS_TABLE_FORMAT) throw Error(`Unsupported RLS table format: ${marker}`);
  return true;
}

export function readRlsTableInventory(contract, contractPath = defaultContractPath) {
  if (!usesRlsTableFiles(contract)) {
    const count = contract.policyCoverage?.rlsTableCount;
    if (!Number.isSafeInteger(count) || count <= 0) throw Error('Invalid legacy RLS table count');
    return { format: 'count', count, tables: null };
  }
  const folder = join(dirname(contractPath), RLS_TABLE_FOLDER);
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw Error(`Invalid RLS table folder: ${folder}`);
  const names = readdirSync(folder).sort();
  if (!names.length) throw Error(`Empty RLS table folder: ${folder}`);
  const tables = names.map(name => {
    const path = join(folder, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error(`RLS table file must be regular: ${path}`);
    return parseRlsTableFile(name, readFileSync(path));
  });
  return { format: RLS_TABLE_FORMAT, count: tables.length, tables };
}

export function requireRlsTables(contract, requiredTables, contractPath = defaultContractPath) {
  if (!Array.isArray(requiredTables) || !requiredTables.length) throw Error('Required RLS table inventory must be non-empty');
  const inventory = readRlsTableInventory(contract, contractPath);
  if (!inventory.tables) throw Error('Current source checks require the RLS table-file inventory');
  const missing = requiredTables.map(table => table.includes('.') ? table : `public.${table}`)
    .filter(table => !inventory.tables.includes(table));
  if (missing.length) throw Error(`Missing required RLS table files: ${missing.join(', ')}`);
  return inventory.tables;
}

export function assessRlsTables(inventory, rows) {
  const live = new Set(rows.filter(row => row.rls).map(row => `public.${row.tbl}`));
  if (!inventory.tables) return [{ name: 'count of RLS-enabled tables in public',
    ok: inventory.count === live.size, expected: inventory.count, observed: live.size }];
  const expected = new Set(inventory.tables);
  return [...new Set([...expected, ...live])].sort().map(table => ({
    name: `RLS table inventory ${table}`, ok: expected.has(table) === live.has(table),
    expected: expected.has(table) ? 'RLS enabled' : 'absent', observed: live.has(table) ? 'RLS enabled' : 'MISSING',
  }));
}
