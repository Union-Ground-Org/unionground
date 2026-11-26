// Object identities use PostgreSQL's canonical named signatures and qualified
// relation names. Compare Unicode code points, never the host's locale.
const normalized = value => String(value).trim().replace(/\s+/gu, ' ');
const relation = value => value.includes('.') ? value : `public.${value}`;
const identity = (...parts) => parts.map(normalized).join('|');
export const contractInventoryKeys = {
  functions: entry => normalized(entry.sig),
  functionsAbsent: entry => normalized(entry.sig),
  schemaUsage: entry => identity(entry.schema, entry.role),
  roleSettings: entry => entry.role,
  policies: entry => identity(relation(entry.table), entry.name),
  policiesForbidden: entry => identity(relation(entry.table), entry.namePattern),
  tableGrants: entry => identity(relation(entry.table), entry.role),
  columnGrants: entry => identity(relation(entry.table), entry.role, entry.privilege),
  constraints: entry => identity(relation(entry.table), entry.name),
  constraintsAbsent: entry => identity(relation(entry.table), entry.name),
  indexes: entry => identity(relation(entry.table), entry.name),
  triggers: entry => identity(entry.schema, entry.table, entry.name),
  'publication.tables': entry => identity(entry.schema, entry.table),
  cron: entry => entry.jobname,
  'knownGaps.surplusClientTableGrants.entries': entry => identity(relation(entry.table), entry.role),
  'knownGaps.vendorSchemaClientGrants.entries': entry => identity(relation(entry.table), entry.role),
  'knownGaps.publicExecuteOnPrivateFunctions.entries': normalized,
  'functionSweeps.schemas': normalized,
  'functionSweeps.noPublicExecuteInSchemas': normalized,
  'policyCoverage.noPermissivePolicies': relation,
  'policyCoverage.unconditionalPolicyAllowlist': normalized,
  'knownGaps.vendorSchemaClientGrants.schemas': normalized,
};
export const compareIdentity = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function inventories(contract) {
  return Object.entries(contractInventoryKeys).map(([path, key]) => ({
    path, key, entries: path.split('.').reduce((value, part) => value?.[part], contract),
  })).filter(({ entries }) => Array.isArray(entries));
}
export function inventoryOrderIssues(contract) {
  const issues = [];
  for (const { path, key, entries } of inventories(contract)) {
    for (let index = 1; index < entries.length; index += 1) {
      const current = key(entries[index]);
      if (compareIdentity(key(entries[index - 1]), current) <= 0) continue;
      const destination = entries.findIndex(entry => compareIdentity(key(entry), current) > 0);
      issues.push(`${path}[${index}] ${current} belongs before ${path}[${destination}] ${key(entries[destination])}`);
    }
  }
  return issues;
}
export function sortContractInventories(contract) {
  const sorted = structuredClone(contract);
  for (const { key, entries } of inventories(sorted)) entries.sort((a, b) => compareIdentity(key(a), key(b)));
  return sorted;
}
