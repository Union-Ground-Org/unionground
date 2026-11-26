import { describe, expect, it } from 'vitest';

import { passwordIssuedAt } from './passwordIssued';

describe('passwordIssuedAt', () => {
  it('reads the stamp only when it is a non-empty string', () => {
    expect(passwordIssuedAt({ union_ground_password_issued_at: '2026-10-19T14:00:00.000Z' })).toBe('2026-10-19T14:00:00.000Z');
    expect(passwordIssuedAt({ union_ground_password_issued_at: '' })).toBeNull();
    expect(passwordIssuedAt({ union_ground_password_issued_at: 42 })).toBeNull();
    expect(passwordIssuedAt({})).toBeNull();
    expect(passwordIssuedAt(null)).toBeNull();
    expect(passwordIssuedAt(undefined)).toBeNull();
  });
});
