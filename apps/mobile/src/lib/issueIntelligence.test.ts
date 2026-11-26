import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { issueSignalCopy, normalizeMemberIssueSignals } from './issueIntelligence';

describe('worker issue signals on the phone', () => {
  it('keeps only known families, retaliation first, and never staff detail', () => {
    const signals = normalizeMemberIssueSignals({
      enabled: true,
      viewer: 'staff',
      signals: [
        { family: 'contract_rights_confusion', confidence: 'strong', evidenceFamilies: ['qa'], contributors: 30 },
        { family: 'retaliation_protected_activity_pressure' },
        { family: 'contract_rights_confusion' },
        { family: 'invented' },
        null,
      ],
    });
    expect(signals).toEqual([
      { family: 'retaliation_protected_activity_pressure', threadKey: 'retaliation-protected-activity-pressure' },
      { family: 'contract_rights_confusion', threadKey: 'contract-rights-confusion' },
    ]);
  });

  it('shows nothing when the switch is off or the payload is malformed', () => {
    expect(normalizeMemberIssueSignals({ enabled: false, signals: [{ family: 'contract_rights_confusion' }] })).toEqual([]);
    expect(normalizeMemberIssueSignals(null)).toEqual([]);
    expect(normalizeMemberIssueSignals({ enabled: true, signals: 'x' })).toEqual([]);
  });

  it('restores the old member-safe copy and routes guidance to existing native features', () => {
    const copy = issueSignalCopy({ family: 'retaliation_protected_activity_pressure', threadKey: 'retaliation-protected-activity-pressure' });
    expect(copy.headline).toBe('You may be dealing with protected-activity pressure.');
    expect(copy.guidance.map((link) => link.route)).toEqual(['/feature/rights', '/feature/cases', '/feature/member-support', '/feature/forms']);
    for (const family of ['contract_rights_confusion', 'retaliation_protected_activity_pressure'] as const) {
      for (const link of issueSignalCopy({ family, threadKey: '' }).guidance) {
        expect(link.route).toMatch(/^\/feature\/(rights|qa|cases|forms|member-support)$/);
      }
    }
  });

  it('wires every visible banner control with a role, label and handler', () => {
    const source = readFileSync(join(__dirname, '..', 'features', 'IssueSignalHomeCard.tsx'), 'utf8');
    const pressables = source.match(/<Pressable[\s\S]*?>/g) ?? [];
    expect(pressables.length).toBe(2);
    for (const pressable of pressables) {
      expect(pressable).toContain('accessibilityRole="button"');
      expect(pressable).toContain('accessibilityLabel=');
      expect(pressable).toContain('onPress=');
    }
    expect(source).toContain("loadMobileMemberIssueSignals");
  });
});
