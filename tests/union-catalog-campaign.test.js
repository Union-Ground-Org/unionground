// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportRelease } from '../scripts/union-catalog/export-release.mjs';
import { readRelease } from '../scripts/load-union-catalog.mjs';
import { verifyCampaign } from '../scripts/union-catalog/verify-campaign.mjs';
import { baseFixture, LOCAL_ID, TEST_SALT } from './helpers/union-catalog-fixture.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function fixture() {
  const root = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), 'catalog-campaign-')); dirs.push(root);
  const input = baseFixture(); const snapshot = join(root, 'snapshot');
  mkdirSync(join(snapshot, 'build'), { recursive: true }); mkdirSync(join(snapshot, 'documents'));
  writeFileSync(join(snapshot, 'build/enriched.json'), JSON.stringify(input.enriched));
  writeFileSync(join(snapshot, 'build/source-data.json'), JSON.stringify({ 'index-data.json': { records: input.ledger } }));
  writeFileSync(join(snapshot, 'documents/index.json'), JSON.stringify({ documents: input.documents }));
  const exclusions = join(root, 'exclusions.json');
  writeFileSync(exclusions, JSON.stringify({ schema: 'catalog-exclusions/1', salt: TEST_SALT, hashes: [] }));
  exportRelease({ sourceDir: snapshot, outDir: join(root, 'release'), label: '20260929-01', env: { CATALOG_EXCLUSIONS_FILE: exclusions } });
  return readRelease(join(root, 'release'));
}

describe('campaign-to-unified-release verification', () => {
  it('proves exact mapped coverage and returns counts and hashes only', () => {
    const release = fixture();
    const report = verifyCampaign(release, release, [String(LOCAL_ID)]);
    expect(report.passed).toBe(true);
    expect(report.campaign).toMatchObject({ structures: 1, allHaveSourceProvenance: true });
    expect(report.productionActivated).toBe(false);
    expect(report.campaign.subunits).toBeGreaterThan(0);
    expect(report.campaign.documents).toBeGreaterThan(0);
    const serialized = JSON.stringify(report);
    for (const row of release.release.organizations) expect(serialized).not.toContain(row.name);
    expect(serialized).not.toContain('olms-');
  });
  it('refuses missing, repeated and mismatched campaign identities', () => {
    const release = fixture();
    expect(() => verifyCampaign(release, release, ['999999'])).toThrow(/identity/);
    expect(() => verifyCampaign(release, release, [String(LOCAL_ID), String(LOCAL_ID)])).toThrow(/distinct/);
    release.idMap.label = '20260928-01';
    expect(() => verifyCampaign(release, release, [String(LOCAL_ID)])).toThrow(/belong/);
  });
  it('refuses a falsely complete structure without documents', () => {
    const release = fixture();
    // An internally inconsistent release must fail the existing row/count gate
    // before campaign coverage can give it credit.
    release.release.documents = [];
    expect(() => verifyCampaign(release, release, [String(LOCAL_ID)])).toThrow();
  });
});
