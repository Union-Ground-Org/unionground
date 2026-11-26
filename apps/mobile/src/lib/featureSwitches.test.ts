import { describe, expect, it } from 'vitest';

import { featureLimit, featureText, featureTextList, isFeatureEnabled } from './featureSwitches';

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001: native mirror of
// src/lib/featureSwitches.js over get_member_organization_configuration().
describe('native feature switches', () => {
  const member = {
    switches: {
      'features.passkey_enrollment': false,
      'limits.casework.deadline_red_days': 3,
      'lists.casework.management_behavior_categories': ['Intimidation', 'Other'],
      'limits.proof.mode': 'fast',
    },
  };

  it('reads the worker switches map and an admin settings array', () => {
    expect(isFeatureEnabled(member, 'features.passkey_enrollment', true)).toBe(false);
    expect(isFeatureEnabled({ settings: [{ key: 'features.x', value: true }] }, 'features.x')).toBe(true);
    expect(featureLimit(member, 'limits.casework.deadline_red_days', 5)).toBe(3);
    expect(featureText(member, 'limits.proof.mode', 'steady')).toBe('fast');
    expect(featureTextList(member, 'lists.casework.management_behavior_categories')).toEqual(['Intimidation', 'Other']);
  });

  it('falls back for a missing configuration, key or wrongly typed value', () => {
    expect(isFeatureEnabled(null, 'features.x')).toBe(false);
    expect(isFeatureEnabled(undefined, 'features.x', true)).toBe(true);
    expect(featureLimit({ switches: { 'limits.x': 1.5 } }, 'limits.x', 7)).toBe(7);
    expect(featureTextList({ switches: { 'lists.x': 'not a list' } }, 'lists.x', ['a'])).toEqual(['a']);
    expect(isFeatureEnabled({ switches: {} }, 'constructor', false)).toBe(false);
  });
});
