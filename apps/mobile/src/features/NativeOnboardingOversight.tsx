// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (native):
// the staff onboarding roster with the organization's stalled flag and
// audited complete / skip / reset of the worker's next step. Live accounts
// only. PREVIEW keeps its plain roster, so a fixture never looks like a live
// staff control.

// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: a skip asks for a
// reason first and sends it; the server refuses a skip without one.

import { useEffect, useState, type ReactNode } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Heading } from '../components/ui';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { NATIVE_SKIP_REASON_MAX, nativeSkipDraftFor, nativeSkipReason, nextOpenStep, type NativeOversight, type NativeOversightMember, type NativeSkipDraft } from './onboardingOversightModel';

import { typeface } from '../theme/typeface';
type OversightAction = 'complete' | 'skip' | 'reset';

type OversightAdapter = {
  loadOnboardingOversight: (actor: unknown) => Promise<unknown>;
  updateMemberOnboarding: (actor: unknown, input: { planId: string; action: OversightAction; stepId: string | null; reason?: string | null }) => Promise<unknown>;
};

export function NativeOnboardingOversight({ adapter, actor, busy, disabled = false, commit, reloadKey, fallback }: {
  adapter: OversightAdapter;
  actor: unknown;
  busy: boolean;
  disabled?: boolean;
  commit: (operation: () => Promise<unknown>, success: string) => Promise<boolean>;
  reloadKey: unknown;
  /** The plain workspace roster, shown until (or unless) the oversight read answers. */
  fallback: ReactNode;
}) {
  const theme = useTheme();
  const [oversight, setOversight] = useState<NativeOversight | null>(null);
  useEffect(() => {
    let current = true;
    adapter.loadOnboardingOversight(actor)
      .then((next) => {
        const value = next as NativeOversight;
        if (current) setOversight(value.state === 'ready' ? value : null);
      })
      .catch(() => { if (current) setOversight(null); });
    return () => { current = false; };
  }, [adapter, actor, reloadKey]);
  if (!oversight) return <>{fallback}</>;
  const change = (member: NativeOversightMember, action: OversightAction, stepId: string | null, success: string, reason: string | null = null) =>
    commit(() => adapter.updateMemberOnboarding(actor, { planId: member.planId, action, stepId, reason }), success);
  return <View style={styles.section}>
    <Heading level={3}>Worker progress</Heading>
    {!oversight.staffOverridesEnabled ? <Body muted>{'Staff changes to worker onboarding are turned off in Feature switches & limits.'}</Body> : null}
    {oversight.memberCount > oversight.members.length ? <Body muted>{`Showing ${oversight.members.length} of ${oversight.memberCount} workers.`}</Body> : null}
    {oversight.members.length === 0 ? <Body muted>No plans have been started.</Body> : null}
    {oversight.members.map((member) => <OversightRow key={member.planId} {...{ oversight, member, busy, disabled, change }} />)}
  </View>;
}

function OversightRow({ oversight, member, busy, disabled, change }: {
  oversight: NativeOversight;
  member: NativeOversightMember;
  busy: boolean;
  disabled: boolean;
  change: (member: NativeOversightMember, action: OversightAction, stepId: string | null, success: string, reason?: string | null) => Promise<boolean>;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState<NativeSkipDraft | null>(null);
  const next = nextOpenStep(oversight, member);
  // The open skip form and its reason belong to one step; a new next step
  // starts closed and empty.
  const openDraft = nativeSkipDraftFor(draft, next?.id);
  const skipping = openDraft !== null;
  const reasonText = openDraft?.text ?? '';
  const reason = nativeSkipReason(reasonText);
  const skip = async () => {
    if (!next || !reason) return;
    if (await change(member, 'skip', next.id, 'Step skipped.', reason)) setDraft(null);
  };
  return <View style={[styles.row, { borderColor: member.stalled ? theme.destructive : theme.border }]}>
        <Heading level={3}>{member.memberLabel}</Heading>
        <Body>{`${member.completedSteps} of ${oversight.totalSteps} steps (${member.percentComplete}%) · ${member.status.replace(/_/g, ' ')}`}</Body>
        {member.stalled ? <View style={[styles.flag, { backgroundColor: theme.muted }]}>
          <Text style={[styles.flagText, { color: theme.foreground }]}>{`Stalled: under ${oversight.stalledBelowPercent}% complete more than ${oversight.stalledAfterDays} days after onboarding was assigned`}</Text>
        </View> : null}
        {member.autoEnrolled ? <Body muted>Enrolled automatically</Body> : null}
        {oversight.staffOverridesEnabled && next ? <View style={styles.actions}>
          <Button label={`Mark "${next.title}" complete for ${member.memberLabel}`} busy={busy} disabled={disabled || skipping} onPress={() => { void change(member, 'complete', next.id, 'Step marked complete.'); }} />
          {skipping ? <>
            <TextInput
              accessibilityLabel={`Why skip "${next.title}" for ${member.memberLabel}?`}
              multiline
              maxLength={NATIVE_SKIP_REASON_MAX}
              value={reasonText}
              onChangeText={(text) => setDraft({ stepId: next.id, text })}
              placeholder="Reason for skipping (staff see it in Worker progress)"
              placeholderTextColor={theme.quietForeground}
              keyboardAppearance={theme.appearance}
              style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
            />
            {reason ? null : <Body muted>Write a reason first.</Body>}
            <Button label="Skip with this reason" variant="secondary" busy={busy} disabled={disabled || !reason} onPress={() => { void skip(); }} />
            <Button label="Cancel" variant="secondary" onPress={() => setDraft(null)} />
          </> : <Button label={`Skip "${next.title}" for ${member.memberLabel}`} variant="secondary" busy={busy} disabled={disabled} onPress={() => setDraft({ stepId: next.id, text: '' })} />}
        </View> : null}
        {oversight.staffOverridesEnabled && (member.completedSteps > 0 || member.status !== 'not_started') ? <Button
          label={`Reset onboarding progress for ${member.memberLabel}`}
          variant="danger"
          busy={busy}
          disabled={disabled}
          onPress={() => Alert.alert(
            'Reset onboarding progress?',
            `Reset all onboarding progress for ${member.memberLabel}? This cannot be undone.`,
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset', style: 'destructive', onPress: () => { void change(member, 'reset', null, 'Onboarding progress reset.'); } }],
          )}
        /> : null}
      </View>;
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: { gap: spacing.xs, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  flag: { borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  flagText: { fontSize: 14, lineHeight: 20, ...typeface.controlStrong },
  actions: { gap: spacing.sm },
  input: { minHeight: 96, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
});
