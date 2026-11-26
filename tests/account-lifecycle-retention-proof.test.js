// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RAISE_PATTERN_SQL } from '../scripts/account-lifecycle-retention-proof.mjs';

describe('PostgreSQL standard-conforming RAISE word pattern', () => {
  it('uses one backslash per SQL word boundary, not a literal-backslash pattern', () => {
    expect(RAISE_PATTERN_SQL).toBe("'\\mraise\\M'");
    expect(RAISE_PATTERN_SQL).not.toContain('\\\\');
  });
});
