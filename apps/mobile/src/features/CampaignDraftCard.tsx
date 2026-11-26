import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '../components/Text';

import { Body, Button, Card, Heading } from '../components/ui';
import {
  campaignDraftProblem,
  DRAFT_MAX_OPTIONS,
  DRAFT_MIN_OPTIONS,
  emptyCampaignDraft,
  saveCampaignDraftArgs,
  stepCampaignCloseDay,
  stepCampaignCloseTime,
  stepQuorum,
  type CampaignDraft,
  type CampaignDraftProblem,
  type CampaignScope,
  type DraftOption,
} from '../lib/campaignDraft';
import { useNativeUi } from '../lib/useNativeUi';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import { SavedWorkCheckFailed } from '../components/SavedWorkCheckFailed';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { saveMobileCampaignDraft } from '../services/campaignRegistry';
import { haptics } from '../services/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { Stepper } from './AppointmentHoursCard';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

type Outcome = { tone: 'error' | 'status'; text: string } | null;

// #9240 pull request C (design R-9240D, row C): an open campaign draft waits
// through a foreground session check on the shared draft hook (memory only),
// so the same person returns to it after the Campaigns screen remounts behind
// the session check. The holder keys it to the person, every role set, the hat
// and the organization (the organization kind, so a chapterless union-wide
// manager keeps one too); any confirmed chapter or organization change,
// sign-out, another account, MFA or an authoritative refusal retires it. An
// open draft is a held value; a closed card holds nothing. The draft keeps its
// own audience, so a save goes only to the audience it was written for. A save
// makes a new draft with no key, so a save with no answer stays locked as
// unconfirmed (Check, Save again, Cancel) until a deliberate tap, after an
// unmount too, and nothing is ever sent again on its own. Every save ends at
// the 20-second deadline.
const campaignSurface = defineRetainedSurface<Held<CampaignDraft | null>>('campaign-draft');
// The Campaigns screen's registry read is this editor's fresh read, so the
// screen hands an authoritative refusal of it here, and the held draft retires.
export function useCampaignDraftRefusal(): (error: unknown) => void {
  return useRetainedDraft<CampaignDraft | null>({ surface: campaignSurface, item: 'new', empty: null, fresh: false, scope: 'organization' }).refused;
}
const CAMPAIGN_FAILURES: Record<string, NativeUiKey> = {
  refused: 'This account cannot write a campaign for that audience.',
  failed: 'The draft could not be saved. Try again.',
};

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 3 of 4): Campaigns' "Write a draft" form. A campaign manager
// writes a vote or a pulse survey (title, optional Spanish title, details,
// close time, quorum for a vote, and 2 to 20 choices), as the website's
// Campaigns page does, for the scopes the registry says this account may
// manage. The saved draft is listed with Publish; `onSaved` reloads the list.
//
// The save rules #9099 parts 1 and 2 ended with (reviews R-9216, R-9216b,
// R-9219). save_vote_campaign_draft makes a new draft's id itself (an id sent
// by the phone means "update that draft"), so the phone cannot reuse one id
// across retries or prove that a save with no answer committed. Such a save
// keeps the draft open, locked and marked unconfirmed, with three choices:
// check the campaign list, save again (it may make a second draft) or cancel.
// Nothing in the list is taken as proof that this draft was saved, and the
// draft is cleared only by a save that succeeds or by Cancel.
//
// R-9224 R1: the screen keeps this card mounted once it has offered
// authoring, and a refreshed registry that withdraws the draft's audience
// does not remove an open draft. The draft stays, read only, with its
// uncertainty line, Check and Cancel; Save is withdrawn and a plain line says
// the permission changed (the website says so too, CampaignsView.jsx). A
// closed card with no audience to offer draws nothing.
export function CampaignDraftCard({ canManageChapter, canManageUnion, onSaved }: {
  canManageChapter: boolean;
  canManageUnion: boolean;
  onSaved: () => void;
}) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, null);
  const { t, locale } = useNativeUi();
  const theme = useTheme();
  const firstScope: CampaignScope = canManageChapter ? 'chapter' : 'union';
  // The card is shown only once the registry read has said who may write, so
  // that read is this editor's fresh read.
  const retained = useRetainedDraft<CampaignDraft | null>({ surface: campaignSurface, item: 'new', empty: null, fresh: true, scope: 'organization' });
  const held = retained.value;
  const open = held !== null;
  const draft = held ?? emptyCampaignDraft(new Date(), firstScope);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  // A save with no answer may have committed: the draft is then locked.
  const locked = retained.pending === 'uncertain';
  const sending = retained.pending === 'sending';
  // The draft's audience as the registry now reports it.
  const allowed = draft.scope === 'union' ? canManageUnion : canManageChapter;
  const permissionGone = open && !allowed;
  const frozen = busy || sending || locked || permissionGone;
  const [outcome, setOutcome] = useBusinessDraftState<Outcome>(null);
  // A second Save before React commits busy is refused here.

  function change(patch: Partial<CampaignDraft>) {
    retained.set((current) => (current ? { ...current, ...patch } : current));
  }

  function changeOption(index: number, patch: Partial<DraftOption>) {
    retained.set((current) => (current ? { ...current, options: current.options.map((option, at) => (at === index ? { ...option, ...patch } : option)) } : current));
  }

  function problemText(problem: NonNullable<CampaignDraftProblem>): string {
    if (problem === 'title') return t('Give the campaign a title of 3 to 160 characters.');
    if (problem === 'details') return t('Keep the details to 1,000 characters.');
    if (problem === 'closes') return t('Pick a closing time that has not passed.');
    if (problem === 'quorum') return t('A vote needs a quorum of at least 1.');
    return t('Give every choice a label, with 2 to 20 choices.');
  }

  async function save() {
    await operate(true, async () => {
    const current = requests.capture().isCurrent;
    if (permissionGone || !retained.shown || !held) return;
    const problem = campaignDraftProblem(held, new Date());
    if (problem) {
      setOutcome({ tone: 'error', text: problemText(problem) });
      return;
    }
    // One attempt at a time, held through an unmount and settled after it.
    const attempt = retained.begin();
    if (!attempt?.value) return;

    setOutcome(null);
    try {
      await withReadDeadline(saveMobileCampaignDraft(writer, saveCampaignDraftArgs(attempt.value)));
      attempt.settle('done');
      if (await writer.isCurrent() && current()) void haptics.success();
      setOutcome({ tone: 'status', text: t('Draft saved. Publish it from the list when it is ready.') });
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setOutcome({ tone: 'status', text: t('Draft saved. Refresh to see it in the list.') }), refresh: onSaved });
    } catch (error) {
      const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
      // Ledger 714: the writer's own refusal before sending, never a copied marker.
      const sessionRefused = error instanceof WriterSessionChanged && businessRpcProvenance(error) === null;
      // A code means the server answered and refused, so nothing was saved;
      // the deadline is a save with no answer.
      const unconfirmed = error instanceof ReadDeadlineError || (!sessionRefused && !(typeof code === 'string' && code !== ''));
      const failure = code === '42501' ? 'refused' : 'failed';
      attempt.settle(unconfirmed ? 'uncertain' : { failed: failure });
      setOutcome(unconfirmed ? null : { tone: 'error', text: t(CAMPAIGN_FAILURES[failure]!) });
    }

    });
  }

  const closesDay = draft.closesAt.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  // Set on the phone's clock, so the time names the phone's zone.
  const closesTime = draft.closesAt.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const context = `${closesDay} ${closesTime}`;
  const inputStyle = [styles.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }];
  // A failure held with the draft shows after a remount, when this mount has
  // no outcome of its own; an unconfirmed save says so whenever it is shown.
  const heldFailure = retained.failed ? CAMPAIGN_FAILURES[retained.failed] : undefined;
  const shownOutcome: Outcome = outcome ?? (open && heldFailure ? { tone: 'error', text: t(heldFailure) } : null);
  const outcomeView = <>
    {locked ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('We could not confirm this draft was saved. Check the campaign list first: saving it again may make a second draft.')}</Body> : null}
    {shownOutcome ? <Body accessibilityRole={shownOutcome.tone === 'error' ? 'alert' : undefined} style={shownOutcome.tone === 'error' ? { color: theme.destructive } : undefined}>{shownOutcome.text}</Body> : null}
  </>;
  const field = (label: string, value: string, onChange: (value: string) => void, max: number, multiline = false) => (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      placeholder={label}
      placeholderTextColor={theme.quietForeground}
      keyboardAppearance={theme.appearance}
      maxLength={max}
      multiline={multiline}
      editable={!frozen}
      style={multiline ? [...inputStyle, styles.details] : inputStyle}
    />
  );

  // Nothing held shows while the session check is unresolved; a failed check
  // says so to an officer who can write campaigns (#9459 M1-21).
  if (!retained.shown) {
    return retained.checkFailed && (canManageChapter || canManageUnion)
      ? <Card><Heading level={3}>{t('New campaign')}</Heading><SavedWorkCheckFailed /></Card>
      : null;
  }
  if (!open && !canManageChapter && !canManageUnion) return null;

  return (
    <Card>
      <Heading level={3}>{t('New campaign')}</Heading>
      <Body muted>{t('Write a vote or a pulse survey. It stays a draft until you publish it.')}</Body>
      {!open ? <>
        {outcomeView}
        <Button disabled={busy} label={t('Write a draft')} onPress={() => { retained.set(() => emptyCampaignDraft(new Date(), firstScope)); setOutcome(null); }} />
      </> : <>
        <View style={styles.actions} accessibilityRole="radiogroup" accessibilityLabel={t('Campaign type')}>
          <Button label={t('Vote')} selected={draft.kind === 'ballot'} variant={draft.kind === 'ballot' ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ kind: 'ballot' })} />
          <Button label={t('Pulse survey')} selected={draft.kind === 'pulse'} variant={draft.kind === 'pulse' ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ kind: 'pulse' })} />
        </View>
        {canManageChapter && canManageUnion ? (
          <View style={styles.actions} accessibilityRole="radiogroup" accessibilityLabel={t('Who can respond')}>
            <Button label={t('My campaign')} selected={draft.scope === 'chapter'} variant={draft.scope === 'chapter' ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ scope: 'chapter' })} />
            <Button label={t('Whole union')} selected={draft.scope === 'union'} variant={draft.scope === 'union' ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ scope: 'union' })} />
          </View>
        ) : <Body muted>{draft.scope === 'chapter' ? t('For workers in your campaign.') : t('For all eligible union workers.')}</Body>}
        {field(t('Title in English'), draft.titleEn, (titleEn) => change({ titleEn }), 160)}
        {field(t('Title in Spanish (optional)'), draft.titleEs, (titleEs) => change({ titleEs }), 160)}
        {field(t('Details (optional)'), draft.bodyEn, (bodyEn) => change({ bodyEn }), 1000, true)}
        <Stepper label={t('Closes')} value={closesDay} earlier={t('Earlier day')} later={t('Later day')} context={context} disabled={frozen}
          onEarlier={() => change({ closesAt: stepCampaignCloseDay(draft.closesAt, -1) })} onLater={() => change({ closesAt: stepCampaignCloseDay(draft.closesAt, 1) })} />
        <Stepper label={t('At')} value={closesTime} earlier={t('Close earlier')} later={t('Close later')} context={context} disabled={frozen}
          onEarlier={() => change({ closesAt: stepCampaignCloseTime(draft.closesAt, -1) })} onLater={() => change({ closesAt: stepCampaignCloseTime(draft.closesAt, 1) })} />
        {draft.kind === 'ballot' ? (
          <Stepper label={t('Quorum')} value={String(draft.quorumTarget)} earlier={t('Lower quorum')} later={t('Raise quorum')} context={t('Quorum')} disabled={frozen}
            onEarlier={() => change({ quorumTarget: stepQuorum(draft.quorumTarget, -1) })} onLater={() => change({ quorumTarget: stepQuorum(draft.quorumTarget, 1) })} />
        ) : null}
        {draft.options.map((option, index) => (
          <View key={index} style={[styles.option, { borderColor: theme.border }]}>
            {field(t('Choice {number}', { number: index + 1 }), option.labelEn, (labelEn) => changeOption(index, { labelEn }), 160)}
            {field(t('Choice {number} in Spanish (optional)', { number: index + 1 }), option.labelEs, (labelEs) => changeOption(index, { labelEs }), 160)}
            {draft.options.length > DRAFT_MIN_OPTIONS ? (
              <Button label={t('Remove this choice')} accessibilityLabel={t('Remove choice {number}', { number: index + 1 })} variant="secondary" disabled={frozen}
                onPress={() => change({ options: draft.options.filter((_, at) => at !== index) })} />
            ) : null}
          </View>
        ))}
        {draft.options.length < DRAFT_MAX_OPTIONS ? (
          <Button label={t('Add a choice')} variant="secondary" disabled={frozen} onPress={() => change({ options: [...draft.options, { labelEn: '', labelEs: '' }] })} />
        ) : null}
        {outcomeView}
        {permissionGone ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Your permission to write campaigns for this audience changed, so this draft cannot be saved here. It stays below to copy from; cancel when you are done.')}</Body> : null}
        <View style={styles.actions}>
          {locked ? <Button label={t('Check the campaign list')} variant="secondary" disabled={busy || sending} onPress={() => void operate(true, async () => { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await onSaved(); })} /> : null}
          {permissionGone ? null : <Button label={locked ? t('Save again') : t('Save draft')} busy={busy} onPress={() => { void save(); }} disabled={Boolean(busy) || sending} />}
          <Button label={t('Cancel')} variant="secondary" disabled={busy || sending} onPress={() => { retained.discard(); setOutcome(null); }} />
        </View>
      </>}
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16 },
  details: { minHeight: 96, paddingTop: spacing.sm, textAlignVertical: 'top' },
  option: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
