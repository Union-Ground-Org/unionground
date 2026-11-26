// Bind a research campaign to the existing unified catalog release. This is
// offline preparation only: it never connects to a database or activates data.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readRelease, planRelease, compareReleases } from '../load-union-catalog.mjs';

export function verifyCampaign(current, previous, ledgerIds) {
  const plan = planRelease(current, { previousRelease: previous.release });
  if (!Array.isArray(ledgerIds) || !ledgerIds.length || ledgerIds.some((id) => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(ledgerIds).size !== ledgerIds.length) {
    throw new Error('Campaign must name distinct numeric ledger IDs');
  }
  if (current.idMap.schema !== 'union-catalog-id-map/1' || current.idMap.label !== current.release.label) throw new Error('Campaign ID map does not belong to this release');
  const organizations = new Map(current.release.organizations.map((row) => [row.catalog_key, row]));
  const keys = ledgerIds.map((id) => current.idMap.organizations?.[id]);
  if (keys.some((key) => typeof key !== 'string' || !organizations.has(key)) || new Set(keys).size !== keys.length) throw new Error('Campaign identity missing or ambiguous in the release');
  const selected = new Set(keys);
  const coverage = keys.map((key) => ({
    sources: organizations.get(key).source_urls?.length ?? 0,
    duplicate: Boolean(organizations.get(key).duplicate_of),
    subunits: current.release.subunits.filter((row) => row.catalog_key === key).length,
    documents: current.release.documents.filter((row) => row.catalog_key === key).length,
  }));
  if (coverage.some((row) => row.duplicate || !row.sources || !row.subunits || !row.documents)) throw new Error('A campaign structure lacks published identity, provenance, sub-units or resources');
  const comparison = compareReleases(previous.release, current.release);
  if (comparison.organizationsRetiredShare > 0.03 || comparison.subunitsRetiredShare > 0.1) throw new Error('Campaign would trip the existing withdrawal guard');
  const sum = (field) => coverage.reduce((n, row) => n + row[field], 0);
  // Counts and hashes only: no dataset values, contacts, exclusions or keys.
  return {
    schema: 1, passed: true, releaseLabel: current.release.label,
    previousReleaseLabel: previous.release.label,
    artifactSha256: plan.artifactSha256, sourceSha256: current.release.sourceSha256,
    idMapSha256: current.manifest.idMap.sha256,
    campaign: { structures: selected.size, subunits: sum('subunits'), documents: sum('documents'), allHaveSourceProvenance: true },
    counts: plan.rows,
    comparison: {
      organizationsAdded: comparison.organizationsAdded, organizationsRetired: comparison.organizationsRetired,
      subunitsAdded: comparison.subunitsAdded, subunitsRetired: comparison.subunitsRetired,
      candidateRenames: comparison.candidateRenames.length,
    },
    databaseConnected: false, productionLoaded: false, productionActivated: false,
  };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--release', '--previous', '--campaign'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Use --release DIR --previous DIR --campaign FILE');
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error('Use --release DIR --previous DIR --campaign FILE');
  const ids = JSON.parse(readFileSync(options['--campaign'], 'utf8'));
  const report = verifyCampaign(readRelease(options['--release']), readRelease(options['--previous']), ids);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
