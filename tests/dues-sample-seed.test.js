import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260831170500_mi1_dues_sample_seed.sql', 'utf8');

describe('Dues SAMPLE seed contract', () => {
  it('refuses production and leaves Stripe unset behind a service-only boundary', () => {
    expect(sql).toContain('productionprojectref');
    expect(sql).toContain('production project refused');
    expect(sql).toContain('SAMPLE Stripe must remain unset');
    expect(sql).toContain('authorize_dues_sample_seed');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/sk_(?:live|test)_/i);
  });

  it('uses existing lanes only, records a reversible ledger, and verifies two full pages', () => {
    for (const name of ['demo_seed_apply_dues', 'demo_seed_verify_dues', 'demo_seed_remove_dues', 'dues_sample_seed_runs', 'dues_sample_seed_ledger']) {
      expect(sql).toContain(name);
    }
    expect(sql).toContain("'duesStaffObligations', 25, 50");
    expect(sql).toContain("'duesMemberHistory', 25, 50");
    expect(sql).toContain("(ordinal - 10) * 22");
    expect(sql).toContain("'open', open_count");
    expect(sql).toContain("'waived', waived_count");
    expect(sql).toContain("set coverage = 'seeded', evidence_key = 'dues-ledger-transparency'");
    expect(sql).not.toMatch(/insert into\s+(?:auth\.users|public\.organizations|public\.organization_memberships|public\.member_profiles)/i);
  });
});
