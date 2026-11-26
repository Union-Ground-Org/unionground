// Reviewed source inventories are the pins. Counts are diagnostics derived at
// runtime, never rewritten into verifier/test source by a migration renumber.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { deriveRelations } from '../account-case-graph-inventory.mjs';
import { readRlsTableInventory } from './db-contract-tables.mjs';

export function reviewedOwnershipIdentityKeys(fks) {
  const array = pg.types.getTypeParser(1009);
  const keys = fks.filter(f => f.parent === 'auth.users' && /^(public|private)\./u.test(f.child))
    .flatMap(f => {
      const columns = Array.isArray(f.columns) ? f.columns : array(f.columns);
      return columns.length === 1 ? [`${f.child}.${columns[0]}`] : [];
    }).sort();
  if (!keys.length) throw Error('Reviewed ownership FK inventory must be non-empty');
  if (new Set(keys).size !== keys.length) throw Error('Duplicate reviewed ownership FK identity');
  return keys;
}
export function reviewedKeyAssuranceCounts(fks, graph) {
  if (!Array.isArray(fks) || !fks.length || !Array.isArray(graph.tables) || !graph.tables.length
    || !Array.isArray(graph.seeds) || !graph.seeds.length
    || JSON.stringify(deriveRelations(fks, graph.seeds)) !== JSON.stringify(graph.tables)) {
    throw Error('Reviewed FK and graph inventories disagree; repair their merge before verification');
  }
  return { foreignKeys: fks.length, statementGates: graph.tables.length,
    ownershipKeys: reviewedOwnershipIdentityKeys(fks).length };
}
export function planKeyAssuranceCountPins(root) {
  const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const fks = read('scripts/account-case-graph-fks.json').foreign_keys;
  const graph = read('scripts/account-case-graph-review.json');
  const contract = read('scripts/db-contract.json');
  const counts = reviewedKeyAssuranceCounts(fks, graph);
  const rls = readRlsTableInventory(contract, join(root, 'scripts/db-contract.json'));
  const grants = contract.tableGrants.length + contract.knownGaps.surplusClientTableGrants.entries.length;
  if (!grants || !contract.policies.length || !contract.functions.length) throw Error('Reviewed contract inventories must be non-empty');
  return { plan: new Map(), counts: { ...counts,
    migrations: readdirSync(join(root, 'supabase/migrations')).filter(path => path.endsWith('.sql')).length,
    publicRlsTables: rls.count, grantRows: grants, policies: contract.policies.length, functions: contract.functions.length } };
}
// Keep the renumber command's API while eliminating its shared source edits.
export function refreshKeyAssuranceCountPins(root) {
  return planKeyAssuranceCountPins(root).counts;
}
