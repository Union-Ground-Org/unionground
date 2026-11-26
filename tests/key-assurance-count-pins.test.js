// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { reviewedOwnershipIdentityKeys, reviewedKeyAssuranceCounts, planKeyAssuranceCountPins } from '../scripts/lib/key-assurance-count-pins.mjs';
const fks = JSON.parse(readFileSync('scripts/account-case-graph-fks.json')).foreign_keys;
const graph = JSON.parse(readFileSync('scripts/account-case-graph-review.json'));

it('derives ownership from reviewed FK identities, including PostgreSQL text-array columns', () => {
  expect(reviewedOwnershipIdentityKeys([
    { child: 'public.a', parent: 'auth.users', columns: '{owner_id}' },
    { child: 'private.b', parent: 'auth.users', columns: ['user_id'] },
    { child: 'public.c', parent: 'auth.users', columns: '{user_id,tenant_id}' },
    { child: 'auth.sessions', parent: 'auth.users', columns: '{user_id}' },
  ])).toEqual(['private.b.user_id', 'public.a.owner_id']);
  expect(() => reviewedOwnershipIdentityKeys([])).toThrow(/non-empty/);
});
it('validates the reviewed FK/graph join without rewriting any consumer or inventory', () => {
  const counts = reviewedKeyAssuranceCounts(fks, graph);
  expect(counts.foreignKeys).toBe(fks.length);
  expect(counts.statementGates).toBeGreaterThan(0);
  expect(counts.ownershipKeys).toBeGreaterThan(0);
  expect(planKeyAssuranceCountPins(process.cwd()).plan.size).toBe(0);
  const changed = structuredClone(graph); changed.tables.pop();
  expect(() => reviewedKeyAssuranceCounts(fks, changed)).toThrow(/inventories disagree/);
  expect(() => reviewedKeyAssuranceCounts([], graph)).toThrow();
  expect(() => reviewedKeyAssuranceCounts(fks, { ...graph, seeds: [] })).toThrow();
});
