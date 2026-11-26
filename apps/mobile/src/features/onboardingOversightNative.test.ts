import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nativeSkipDraftFor, nativeSkipReason, nextOpenStep, type NativeOversight } from './onboardingOversightModel';

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const oversight: NativeOversight = {
  state: 'ready',
  stalledAfterDays: 14,
  stalledBelowPercent: 50,
  staffOverridesEnabled: true,
  totalSteps: 3,
  steps: [
    { id: 'step-1', title: 'Welcome', position: 10 },
    { id: 'step-2', title: 'Meet the committee', position: 20 },
    { id: 'step-3', title: 'Read the contract', position: 30 },
  ],
  members: [],
  memberCount: 0,
};

describe('native onboarding oversight (REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001)', () => {
  it('offers the first step the worker has not finished', () => {
    const member = { planId: 'plan-1', memberUserId: 'user-1', memberLabel: 'Morgan', status: 'in_progress', completedStepIds: ['step-1'], completedSteps: 1, percentComplete: 33, autoEnrolled: false, stalled: true };
    expect(nextOpenStep(oversight, member)).toEqual({ id: 'step-2', title: 'Meet the committee', position: 20 });
    expect(nextOpenStep(oversight, { ...member, completedStepIds: ['step-1', 'step-2', 'step-3'] })).toBeNull();
  });

  it('sends a skip only with a trimmed reason of 1 to 500 characters', () => {
    expect(nativeSkipReason('')).toBeNull();
    expect(nativeSkipReason(' \t\n\u00a0')).toBeNull();
    expect(nativeSkipReason('x'.repeat(501))).toBeNull();
    expect(nativeSkipReason('\n Covered at orientation. \t')).toBe('Covered at orientation.');
    expect(nativeSkipReason(` ${'x'.repeat(500)} `)).toBe('x'.repeat(500));
  });

  it('wires live staff to the shared adapter and keeps PREVIEW on the plain roster', () => {
    const screen = source('./MemberSupportScreen.tsx');
    expect(screen).toContain("return mode === 'preview' ? roster : <NativeOnboardingOversight");
    const panel = source('./NativeOnboardingOversight.tsx');
    expect(panel).toContain('adapter.loadOnboardingOversight(actor)');
    expect(panel).toContain('adapter.updateMemberOnboarding(actor, { planId: member.planId, action, stepId, reason })');
    // REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: a skip sends the reason it asked for.
    expect(panel).toContain("change(member, 'skip', next.id, 'Step skipped.', reason)");
    expect(panel).toContain('disabled={disabled || !reason}');
    expect(panel).toContain("change(member, 'reset', null");
    expect(panel).toContain('Alert.alert(');
    expect(panel).toContain('oversight.staffOverridesEnabled');
  });

  // #7022 gate r2s1: a skip reason belongs to the step it was typed for.
  it('closes the skip form and drops its reason when the next step changes', () => {
    const draft = { stepId: 'step-2', text: 'Covered at the committee member meeting' };
    expect(nativeSkipDraftFor(draft, 'step-2')).toBe(draft);
    expect(nativeSkipDraftFor(draft, 'step-3')).toBeNull();
    expect(nativeSkipDraftFor(draft, null)).toBeNull();
    expect(nativeSkipDraftFor(null, 'step-2')).toBeNull();
    const panel = source('./NativeOnboardingOversight.tsx');
    expect(panel).toContain('const openDraft = nativeSkipDraftFor(draft, next?.id);');
    expect(panel).toContain("const reasonText = openDraft?.text ?? '';");
    expect(panel).toContain('onChangeText={(text) => setDraft({ stepId: next.id, text })}');
    expect(panel).not.toMatch(/useState\(''\)|setReasonText|setSkipping/);
  });

  it('keeps "Mark complete" disabled while the skip form is open', () => {
    const panel = source('./NativeOnboardingOversight.tsx');
    expect(panel).toContain('const skipping = openDraft !== null;');
    expect(panel).toMatch(/label=\{`Mark "\$\{next\.title\}" complete for \$\{member\.memberLabel\}`\} busy=\{busy\} disabled=\{disabled \|\| skipping\}/);
  });
});
