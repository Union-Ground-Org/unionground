import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
// Live screens for feature addresses that opened only the generic evidence
// screen (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
//): Campaigns, Be heard, Search, Casework, Case queue and Forms. Each
// reads and writes through the same server authorities the web pages use;
// preview sessions keep their own fixture screens in FeatureScreen.
import { campaignPublishWithdrawn, isCampaignCloseDateRefusal } from '../../../../src/lib/campaignPublish.js';
import { formatZoneInstant, groupTimeZone } from '../../../../src/lib/zoneTime.js';
import { CampaignDraftCard, useCampaignDraftRefusal } from './CampaignDraftCard';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { CaseRowPressable } from '../components/CaseRowPressable';
import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../components/ui';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { deviceCalendarDay, deviceDateTime, deviceZonedDateTime, formatBallotClosingTime, parseDatabaseTimestamp, sentMeta } from '../lib/evidenceTimestamp';
import { formTemplateBlurb } from '../lib/featureCatalog';
import { healthNoticeFor } from '../lib/formHealthNotice';
import { BE_HEARD_READERS, BE_HEARD_RETENTION, BE_HEARD_URGENT_ROUTE } from '../lib/sensitiveInputDisclosure';
import { memberCaseStep } from '../lib/caseStepLabels';
import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import { nativeCatalogLabel, nativeUiText, type NativeUiKey } from '../lib/nativeUiCopy';
import { type SignatureStrokes } from '../lib/signatureStrokes';
import { useNativeUi } from '../lib/useNativeUi';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import {
  BE_HEARD_CATEGORIES,
  BE_HEARD_DETAILS_MAX,
  BE_HEARD_TITLE_MAX,
  beHeardCategoryLabel,
  beHeardDraftProblem,
  beHeardStatusLabel,
  BE_HEARD_SEND_REFUSED,
  loadMyBeHeardReports,
  sendBeHeardReport,
  type BeHeardDraft,
  type BeHeardReport,
} from '../services/beHeard';
import {
  changeCampaign,
  loadCampaignRegistryPage,
  type CampaignAction,
  type CampaignFilter,
  type CampaignRegistryPage,
  type StaffCampaign,
} from '../services/campaignRegistry';
import { loadChapterActiveCases, loadChapterCaseDeadlines, loadChapterCases, type ChapterActiveCases, type ChapterCaseDeadline, type ChapterCaseRow } from '../services/chapterCaseQueue';
import { haptics } from '../services/haptics';
import {
  COSIGNED_FORM_TEMPLATE_KEYS,
  FORM_DATE_PATTERN,
  FormActionError,
  cleanFormAnswers,
  formIsEditable,
  formIsSealed,
  formStatusLabel,
  formTemplateForNewStart,
  loadFormTemplates,
  loadMyForms,
  loadMyOpenFormDraft,
  missingRequiredFields,
  myFormWasFiled,
  openFormAnswers,
  readStoredFormAnswers,
  sameStoredAnswers,
  saveMyFormDraft,
  signMyForm,
  startableFormTemplates,
  submitMyForm,
  templateForForm,
  unsavedAnswerFields,
  type FormAnswerValue,
  type FormAnswers,
  type FormSaved,
  type FormField,
  type FormTemplate,
  type MemberForm,
  type OpenedForm,
  type StoredAnswers,
} from '../services/memberForms';
import { FormFileError, listFormFiles, reviewedManifest, shareFilingCopy, type FormFile, type FormFileTarget } from '../services/formFiles';
import { loadCosigning, type Cosigning } from '../services/formCosigners';
import { LiveCosignRequests } from './forms/LiveCosignRequests';
import { LiveFormCosigners } from './forms/LiveFormCosigners';
import { startFormFileRead } from './forms/LiveFormAttachments';
import { LIVE_SEARCH_SOURCES, LIVE_SEARCH_SOURCE_LIMIT, loadLiveSearchIndex, type LiveSearchIndex, type LiveSearchRow, type LiveSearchScope } from '../services/memberSearch';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { NativeUnitChoice, useNativeUnitContext } from './NativeUnitSettings';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { LiveFormFiling } from './forms/LiveFormFiling';
import type { KeptFormEditor } from './forms/keptFormEditor';
import { presentSearchRow, pressSearchRow } from './searchRowPresentation';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

import { typeface } from '../theme/typeface';
function ChoiceChips<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly { key: T; label: string }[];
  value: T | null;
  onChange: (next: T) => void;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.wrap}>
      {options.map((item) => {
        const selected = value === item.key;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="radio"
            accessibilityLabel={item.label}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => { void haptics.select(); onChange(item.key); }}
            style={({ pressed }) => [styles.chip, { backgroundColor: selected ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Text style={[styles.chipText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type Outcome = { text: string; error: boolean };
export type FormOutcome = Outcome;

// An outcome line that VoiceOver also speaks: the live region below it does
// nothing on iOS, and the control the person pressed has just changed state.
function useAnnouncedOutcome(owner: string): [Outcome | null, (next: Outcome | null) => void] {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const announce = useAccessibilityAnnouncementQueue(owner);
  const set = useCallback((next: Outcome | null) => {
    setOutcome(next);
    if (next) announce(next.text);
  }, [announce]);
  return [outcome, set];
}

function useBusinessOutcome(owner: string): [Outcome | null, (next: Outcome | null) => void] {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, owner);
  const [outcome, setOutcome] = useBusinessDraftState<Outcome | null>(null);
  const announce = useAccessibilityAnnouncementQueue(`${owner}:${writer.userId ?? 'signed-out'}`);
  const set = useCallback((next: Outcome | null) => {
    const ticket = requests.capture();
    setOutcome(next);
    if (next) void writer.isCurrent().then((current) => { if (current && ticket.isCurrent()) announce(next.text); });
  }, [announce, setOutcome, writer, requests]);
  return [outcome, set];
}

function StatusChip({ label }: { label: string }) {
  const theme = useTheme();
  return <View style={[styles.status, { backgroundColor: theme.secondary }]}><Text style={[styles.statusText, { color: theme.secondaryForeground }]}>{label}</Text></View>;
}

// ---------------------------------------------------------------- Campaigns

const CAMPAIGN_FILTERS: readonly { key: CampaignFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
];
const CAMPAIGN_STATE_LABELS: Record<StaffCampaign['state'], string> = { draft: 'Draft', open: 'Open', closed: 'Closed' };
// The web registry's own confirmation copy (campaigns.confirm.* in
// src/lib/i18n/locales/en), so a staff member reads the same promise on both.
const CAMPAIGN_CONFIRM: Record<CampaignAction, { title: string; body: string; button: string; done: string }> = {
  publish: { title: 'Publish campaign?', body: 'Publishing opens responses and locks the campaign copy and options.', button: 'Publish now', done: 'Campaign published.' },
  close: { title: 'Close campaign?', body: 'Closing stops responses. Eligible workers can see vote results immediately.', button: 'Close now', done: 'Campaign closed.' },
  deleteDraft: { title: 'Delete this draft?', body: 'This draft was never published, so no worker has seen it. Deleting it cannot be undone.', button: 'Delete draft', done: 'Draft deleted.' },
};

// The website's line (campaigns.organizationVotesElsewhere), with the phone's
// names for the hats and the members' Voting screen. Its last sentence names
// ballots only: the phone's Voting screen has no list of campaign pulses.
const CAMPAIGNS_ORGANIZATION_VOTES_ELSEWHERE = 'Votes and pulses for the whole organization are run by an organization-wide Admin or Campaign chair, so they are not listed here. Workers find the votes under Votes.';

function campaignKey(campaign: Pick<StaffCampaign, 'kind' | 'id'>): string {
  return `${campaign.kind}-${campaign.id}`;
}

export function LiveCampaignsScreen() {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const [filter, setFilter] = useBusinessDraftState<CampaignFilter>('all');
  const requests = useBusinessRequests(writer, filter);
  const [page, setPage] = useBusinessDraftState<CampaignRegistryPage | null>(null, filter);
  const [error, setError] = useBusinessDraftState<string | null>(null, filter);
  const [reload, setReload] = useBusinessDraftState(0);
  const [moreBusy, setMoreBusy] = useBusinessState(false);
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [notice, setNotice] = useBusinessOutcome('campaigns-live');
  const request = useRef(0);
  //  part 3: who may write a draft, kept apart from the page so a filter
  // change or a reload does not close a draft being written.
  const [authoring, setAuthoring] = useBusinessDraftState<{ chapter: boolean; union: boolean } | null>(null);
  // R-9224 R1: once offered, the draft card stays mounted, so a refreshed
  // answer that withdraws authority cannot remove an open or unconfirmed
  // draft; the card itself withdraws Save and says why.
  const [draftCardShown, setDraftCardShown] = useBusinessDraftState(false);
  const { t, catalogLabel } = useNativeUi();
  //  pull request C: an authoritative refusal of the registry read
  // retires a held campaign draft.
  const draftRefusal = useCampaignDraftRefusal();
  const refuseDraft = useRef(draftRefusal);
  refuseDraft.current = draftRefusal;

  const reread = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++request.current;
    setPage(null); setError(null);
    try {
      const next = await loadCampaignRegistryPage(filter);
      if (at !== request.current || !ticket.isCurrent()) return false;
      setPage(next); setAuthoring({ chapter: next.canManageChapter, union: next.canManageUnion });
      if (next.canManageChapter || next.canManageUnion) setDraftCardShown(true);
      return true;
    } catch (error) { if (at === request.current && ticket.isCurrent()) { setError('The campaigns didn’t load. Try again.'); refuseDraft.current(error); } return false; }
  }, [filter, requests, setPage, setError, setAuthoring, setDraftCardShown]);
  useEffect(() => { void reread(); return () => { request.current += 1; }; }, [reread, reload]);

  async function loadMore() {
    if (!page?.nextCursor || moreBusy) return;
    const at = request.current;
    const ticket = requests.capture();
    setMoreBusy(true);
    try {
      const next = await loadCampaignRegistryPage(filter, page.nextCursor);
      if (at !== request.current || !ticket.isCurrent()) return;
      setPage((current) => {
        if (!current) return next;
        // A campaign that changed state can reappear on a later page; it is
        // listed once, in its latest form.
        const seen = new Set(next.campaigns.map(campaignKey));
        return { ...next, campaigns: [...current.campaigns.filter((item) => !seen.has(campaignKey(item))), ...next.campaigns] };
      });
    } catch {
      if (at === request.current && ticket.isCurrent()) setNotice({ text: 'More campaigns didn’t load. Try again.', error: true });
    } finally {
      setMoreBusy(false);
    }
  }

  function confirm(action: CampaignAction, campaign: StaffCampaign) {
    const copy = CAMPAIGN_CONFIRM[action];
    Alert.alert(copy.title, `${campaign.titleEn}\n\n${copy.body}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: copy.button, style: action === 'publish' ? 'default' : 'destructive', onPress: () => { void run(action, campaign); } },
    ]);
  }

  async function run(action: CampaignAction, campaign: StaffCampaign) {
    await operate(campaignKey(campaign), async () => {
    const current = requests.capture().isCurrent;

    setNotice(null);
    try {
      await changeCampaign(writer, action, campaign);
      if (current()) request.current += 1;
      setPage(previous => previous ? { ...previous, campaigns: action === 'deleteDraft'
        ? previous.campaigns.filter(item => campaignKey(item) !== campaignKey(campaign))
        : previous.campaigns.map(item => campaignKey(item) === campaignKey(campaign) ? { ...item, state: action === 'publish' ? 'open' : 'closed' } : item) } : previous);
      if (await writer.isCurrent() && current()) void haptics.success();
      setNotice({ text: CAMPAIGN_CONFIRM[action].done, error: false });
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setNotice({ text: t(BUSINESS_SAVED_STALE), error: false }), refresh: reread });
    } catch (error) {
      setNotice({ text: action === 'publish' && isCampaignCloseDateRefusal(error, campaign.closesAt)
        ? t('The close date has passed. Change it before publishing.')
        : 'The campaign did not change. Refresh and try again.', error: true });
    }

    });
  }

  const options = CAMPAIGN_FILTERS.map((item) => ({ key: item.key, label: page ? `${item.label} ${page.counts[item.key]}` : item.label }));
  return (
    <Screen>
      <Heading>{catalogLabel('Campaigns')}</Heading>
      <Body muted>{t('Write a vote or pulse draft here, then publish it with clear eligibility and close it explicitly. To change a draft, delete it and write it again.')}</Body>
      {authoring && draftCardShown ? (
        <CampaignDraftCard canManageChapter={authoring.chapter} canManageUnion={authoring.union} onSaved={() => { setFilter('all'); setReload((value) => value + 1); }} />
      ) : null}
      {/*  (B-43), twin of the website's: the organization's ballots
          and pulses are not in this list for a reader who cannot manage that
          scope. Members still see the ballots on Voting, so the screen says
          where; the phone has no pulse list, so it names ballots only. */}
      {page?.organizationVotesElsewhere ? <Body muted>{t(CAMPAIGNS_ORGANIZATION_VOTES_ELSEWHERE)}</Body> : null}
      <Button label={t('Refresh')} disabled={busy !== null} variant="secondary" onPress={() => void operate('refresh', async () => { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await reread(); })} />
      <ChoiceChips label="Filter campaigns" options={options} value={filter} onChange={setFilter} />
      {notice ? (
        <View accessibilityLiveRegion="polite" accessibilityRole={notice.error ? 'alert' : 'text'}>
          <Body style={notice.error ? { color: theme.destructive } : undefined}>{notice.text}</Body>
        </View>
      ) : null}
      {error ? (
        <Card><Heading level={3}>Campaigns unavailable</Heading><Body muted>{error}</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card>
      ) : page === null ? (
        <StateMessage title="Loading campaigns" body="Getting the campaigns your role can manage." />
      ) : page.campaigns.length === 0 ? (
        <StateMessage title={filter === 'all' ? 'No campaigns yet' : `No ${CAMPAIGN_FILTERS.find((item) => item.key === filter)?.label.toLocaleLowerCase()}`} body={t('A draft you write appears here, ready to publish.')} />
      ) : (
        <>
          {page.campaigns.map((campaign) => {
            // Ledger 526: the close time names its zone, as the chapter notices do.
            const closes = deviceZonedDateTime(campaign.closesAt);
            const rowBusy = busy === campaignKey(campaign);
            return (
              <Card key={campaignKey(campaign)}>
                <View style={styles.row}>
                  <Text style={[styles.eyebrow, { color: theme.primary }]}>{campaign.kind === 'ballot' ? 'Vote' : 'Pulse'}</Text>
                  <StatusChip label={CAMPAIGN_STATE_LABELS[campaign.state]} />
                </View>
                <Heading level={3}>{campaign.titleEn}</Heading>
                <Body muted>{campaign.scope === 'union' ? 'All eligible union workers' : 'Workers in your campaign'}</Body>
                <Body muted>{[
                  closes ? `${campaign.state === 'closed' ? 'Closed' : 'Closes'} ${closes}` : null,
                  `${campaign.optionCount} ${campaign.optionCount === 1 ? 'option' : 'options'}`,
                  campaign.quorumTarget !== null ? `Quorum ${campaign.quorumTarget}` : null,
                ].filter(Boolean).join(' · ')}</Body>
                {campaign.state === 'draft' && campaignPublishWithdrawn(campaign.closesAt) ? <Body>{t('The close date has passed. Change it before publishing.')}</Body> : null}
                {campaign.state === 'draft' ? (
                  <View style={styles.actions}>
                    {!campaignPublishWithdrawn(campaign.closesAt) && <Button label={rowBusy ? 'Working…' : 'Publish'} accessibilityLabel={`Publish ${campaign.titleEn}`} disabled={busy !== null} onPress={() => confirm('publish', campaign)} />}
                    <Button label="Delete draft" accessibilityLabel={`Delete draft ${campaign.titleEn}`} variant="secondary" disabled={busy !== null} onPress={() => confirm('deleteDraft', campaign)} />
                  </View>
                ) : campaign.state === 'open' ? (
                  <Button label={rowBusy ? 'Working…' : 'Close'} accessibilityLabel={`Close ${campaign.titleEn}`} variant="secondary" disabled={busy !== null} onPress={() => confirm('close', campaign)} />
                ) : null}
              </Card>
            );
          })}
          {page.nextCursor ? <Button label={moreBusy ? 'Loading…' : 'Show more campaigns'} variant="secondary" disabled={moreBusy} onPress={() => { void loadMore(); }} /> : null}
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- Be heard

//  pull request C (design R-9240D, row C): an unsent report waits through
// a foreground session check on the shared draft hook (memory only), keyed to
// the person, every role set, the hat, the organization and the chapter; any
// confirmed chapter or organization change, sign-out, another account, MFA or
// an authoritative refusal of the sent-reports read retires it. The composer
// needs no read of its own (a failed history read never hid it), so only the
// provider's reads conceal it. A report inserts a new row with no key, so a
// send with no answer stays locked as unconfirmed (Send again, Discard) until
// a deliberate tap, after an unmount too; nothing is sent again on its own.
// Every send ends at the 20-second deadline.
const beHeardSurface = defineRetainedSurface<Held<BeHeardDraft>>('be-heard');
const BE_HEARD_EMPTY: BeHeardDraft = { category: null, title: '', details: '' };
// The service names a refusal the server gave, and an incomplete report it
// never sent; anything else (no answer, the deadline) may have landed.
function beHeardOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ReadDeadlineError) return true;
  // Ledger 714: the writer's own refusal before sending, never a copied marker.
  if (error instanceof WriterSessionChanged && businessRpcProvenance(error) === null) return false;
  if (!(error instanceof Error)) return true;
  return error.message !== BE_HEARD_SEND_REFUSED && error.message !== 'The report is not complete.';
}

export function LiveBeHeardScreen() {
  const { catalogLabel, t } = useNativeUi();
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, null);
  const theme = useTheme();
  const { dashboard } = useApp();
  const userID = dashboard?.member.id ?? '';
  const draft = useRetainedDraft<BeHeardDraft>({ surface: beHeardSurface, item: 'report', empty: BE_HEARD_EMPTY, fresh: true });
  const { category, title, details } = draft.value;
  const refused = useRef(draft.refused);
  refused.current = draft.refused;
  const [sending, setSending] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof sending>(setSending, false);
  const [notice, setNotice] = useBusinessOutcome('be-heard-live');
  const [sent, setSent] = useBusinessDraftState<BeHeardReport[] | null>(null);
  const [sentError, setSentError] = useBusinessDraftState(false);
  const [reload, setReload] = useBusinessDraftState(0);

  const reads = useRef(0);
  const reread = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++reads.current;
    setSentError(false);
    try { const reports = await loadMyBeHeardReports(userID); if (at !== reads.current || !ticket.isCurrent()) return false; setSent(reports); }
    catch (error) { if (at === reads.current && ticket.isCurrent()) { setSentError(true); refused.current(error); } return false; }
    return true;
  }, [userID, requests, setSent, setSentError]);
  useEffect(() => { void reread(); return () => { reads.current += 1; }; }, [reread, reload]);

  const problem = beHeardDraftProblem({ category, title, details });
  async function send() {
    await operate(true, async () => {
    const current = requests.capture().isCurrent;
    if (problem !== null || sending || !draft.shown) return;
    // One attempt at a time, held through an unmount and settled after it.
    const attempt = draft.begin();
    if (!attempt) return;

    setNotice(null);
    try {
      await withReadDeadline(sendBeHeardReport(writer, attempt.value));
      // A sent report never becomes the next one's silent default.
      attempt.settle('done');
      if (await writer.isCurrent() && current()) void haptics.success();
      setNotice({ text: 'Sent to your campaign. A committee member or campaign lead reads it; a reply is not guaranteed.', error: false });
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setNotice({ text: t(BUSINESS_SAVED_STALE), error: false }), refresh: reread });
    } catch (nextError) {
      const unknown = beHeardOutcomeUnknown(nextError);
      attempt.settle(unknown ? 'uncertain' : { failed: 'refused' });
      setNotice(unknown ? null : { text: nextError instanceof Error ? nextError.message : 'Your report was not sent.', error: true });
    }

    });
  }

  const inputStyle = [styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }];
  const uncertain = draft.pending === 'uncertain';
  const locked = sending || draft.pending !== false;
  // A refusal held with the report shows after a remount too.
  const heldFailure = draft.failed === 'refused' && !notice ? BE_HEARD_SEND_REFUSED : null;
  return (
    <Screen>
      <Heading>{catalogLabel('Be heard')}</Heading>
      <Body muted>Report a workplace issue, raise a safety concern, ask a question, or send app feedback to your campaign.</Body>
      <Card><Body>{BE_HEARD_READERS}</Body><Body muted>{BE_HEARD_RETENTION}</Body><Body muted>{BE_HEARD_URGENT_ROUTE}</Body></Card>
      {/* Nothing held shows while the session check is unresolved. */}
      {draft.shown ? <>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Choose one topic</Text>
      <ChoiceChips label="Topic" options={BE_HEARD_CATEGORIES} value={category} onChange={(next) => draft.set({ category: next })} />
      <TextInput
        accessibilityLabel="Title"
        maxLength={BE_HEARD_TITLE_MAX}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={title}
        onChangeText={(next) => draft.set({ title: next })}
        editable={!locked}
        placeholder="A few words about it"
        placeholderTextColor={theme.quietForeground}
        style={inputStyle}
      />
      <TextInput
        accessibilityLabel="Your message"
        multiline
        maxLength={BE_HEARD_DETAILS_MAX}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={details}
        onChangeText={(next) => draft.set({ details: next })}
        editable={!locked}
        placeholder="What should the campaign know?"
        placeholderTextColor={theme.quietForeground}
        style={[...inputStyle, styles.multiline]}
      />
      {uncertain ? <Body accessibilityRole="alert">{t('We could not confirm your report was sent. Check What you sent first: sending it again may send it twice.')}</Body> : null}
      <Button label={sending || draft.pending === 'sending' ? 'Sending…' : uncertain ? t('Send again') : 'Send to the campaign'} disabled={problem !== null || sending || draft.pending === 'sending'} onPress={() => { void send(); }} />
      {uncertain ? <Button label={t('Discard this report')} variant="secondary" disabled={sending} onPress={() => { draft.discard(); setNotice(null); }} /> : null}
      {problem && !uncertain ? <Body muted>{problem}</Body> : null}
      {heldFailure ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{heldFailure}</Body> : null}
      </> : null}
      {notice ? (
        <View accessibilityLiveRegion="polite" accessibilityRole={notice.error ? 'alert' : 'text'}>
          <Body style={notice.error ? { color: theme.destructive } : undefined}>{notice.text}</Body>
        </View>
      ) : null}
      <Heading level={2}>What you sent</Heading>
      {sentError ? (
        <Card><Body muted>Your sent reports didn’t load.</Body><Button label="Try again" variant="secondary" onPress={() => setReload((value) => value + 1)} /></Card>
      ) : sent === null ? (
        <StateMessage compact title="Loading your reports" body="Getting the reports you sent." />
      ) : sent.length === 0 ? (
        <StateMessage compact title="Nothing sent yet" body="Reports you send appear here with their status." />
      ) : sent.map((report) => (
        <Card key={report.id}>
          <View style={styles.row}>
            <Text style={[styles.eyebrow, { color: theme.primary }]}>{beHeardCategoryLabel(report.category)}</Text>
            <StatusChip label={beHeardStatusLabel(report.status)} />
          </View>
          <Heading level={3}>{report.title}</Heading>
          {/* The Eastern send time Be heard has shown since REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103. */}
          <Body muted>{sentMeta(report.createdAt)}</Body>
        </Card>
      ))}
    </Screen>
  );
}

// ---------------------------------------------------------------- Search

const LIVE_SEARCH_SCOPES: readonly { key: 'all' | LiveSearchScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cases', label: 'Issues' },
  { key: 'forms', label: 'Forms' },
  { key: 'events', label: 'Meetings' },
  { key: 'rights', label: 'Rights' },
  { key: 'ballots', label: 'Votes' },
];
const LIVE_SEARCH_RECENTS_CAP = 3;
const SOURCE_NAMES: Record<LiveSearchScope, string> = { cases: 'cases', forms: 'forms', events: 'events', rights: 'rights articles', ballots: 'ballots' };

export function LiveSearchScreen() {
  const { catalogLabel, language, locale } = useNativeUi();
  const theme = useTheme();
  const router = useRouter();
  const { dashboard } = useApp();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | LiveSearchScope>('all');
  const [index, setIndex] = useState<LiveSearchIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadLiveSearchIndex().then((next) => {
      if (active) setIndex(next);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [reload]);

  const haystack = useMemo(() => {
    const rows: LiveSearchRow[] = (dashboard?.cases ?? []).map((item) => ({ id: `cases:${item.id}`, scope: 'cases', title: `${item.reference} · ${item.title}`, body: `${item.caseType} · ${memberCaseStep(item)}`, href: `/issue/${item.id}` }));
    const t = nativeUiText(language);
    const indexed = (index?.rows ?? []).map((row) => {
      if (row.ballot) {
        const { closesAtMs, closed } = row.ballot;
        const when = formatBallotClosingTime(closesAtMs, language);
        return {
          ...row,
          body: when ? t(closed ? 'Closed {when}' : 'Closes {when}', { when }) : t(closed ? 'Closed' : 'Votes is open'),
        };
      }
      return row.eventDay
        ? { ...row, body: [deviceCalendarDay(row.eventDay, locale), row.body].filter(Boolean).join(' · ') }
        : row;
    });
    return [...rows, ...indexed];
  }, [dashboard, index, language, locale]);
  const needle = query.trim().toLocaleLowerCase();
  const scoped = scope === 'all' ? haystack : haystack.filter((item) => item.scope === scope);
  const results = needle ? scoped.filter((item) => `${item.title} ${item.body}`.toLocaleLowerCase().includes(needle)) : scoped.slice(0, LIVE_SEARCH_RECENTS_CAP);
  const unavailable = (index?.unavailable ?? []).filter((source) => scope === 'all' || scope === source);
  const full = index ? LIVE_SEARCH_SOURCES.filter((source) => (scope === 'all' || scope === source) && index.rows.filter((row) => row.scope === source).length >= LIVE_SEARCH_SOURCE_LIMIT) : [];
  const open = useCallback((href: string) => { router.push(href as never); }, [router]);
  const searchPending = index === null && !failed && scope !== 'cases';

  return (
    <Screen>
      <Heading>{catalogLabel('Search')}</Heading>
      <Body muted>Search the issues, forms, meetings, rights articles and votes you can already open.</Body>
      <TextInput
        accessibilityLabel="Search"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        returnKeyType="search"
        value={query}
        onChangeText={setQuery}
        placeholder="Weingarten, an issue number, a vote…"
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <ChoiceChips label="Search scope" options={LIVE_SEARCH_SCOPES} value={scope} onChange={setScope} />
      {failed ? (
        <Card><Body muted>Search didn’t load. Your issues are still searchable.</Body><Button label="Try again" variant="secondary" onPress={() => setReload((value) => value + 1)} /></Card>
      ) : index === null && scope !== 'cases' ? (
        <StateMessage compact title="Loading search" body="Getting the records you can open." />
      ) : null}
      {unavailable.length ? <Body muted>{`These didn’t load, so they are not searched: ${unavailable.map((source) => SOURCE_NAMES[source]).join(', ')}.`}</Body> : null}
      {needle && full.length ? <Body muted>{`Only the latest ${LIVE_SEARCH_SOURCE_LIMIT} ${full.map((source) => SOURCE_NAMES[source]).join(', ')} are searched here.`}</Body> : null}
      <Text accessibilityRole="header" style={[styles.eyebrow, { color: theme.mutedForeground }]}>
        {needle ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : results.length < scoped.length ? `Showing ${results.length} of ${scoped.length}` : 'In this scope'}
      </Text>
      {/* "No matches" waits until every source has answered; until then only
          cases have been searched. */}
      {results.length === 0 ? (searchPending
        ? <Body muted>No issue matches yet. Forms, meetings, rights articles and votes are still loading.</Body>
        : <StateMessage title="No matches you can open" body="Try another word from an issue, form, meeting, rights article or vote." />) : results.map((item) => {
        const row = presentSearchRow(item);
        if (row.kind === 'pressable') {
          return (
            <Pressable key={item.id} accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel} onPress={() => { void haptics.select(); pressSearchRow(row, open); }}>
              {({ pressed }) => <Card style={{ opacity: pressed ? 0.82 : 1 }}><Heading level={3}>{item.title}</Heading><Body muted>{item.body}</Body></Card>}
            </Pressable>
          );
        }
        return (
          <View key={item.id} accessible accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel}>
            <Card><Heading level={3}>{item.title}</Heading><Body muted>{item.body}</Body></Card>
          </View>
        );
      })}
    </Screen>
  );
}

// ---------------------------------------------------------------- Casework (steward desk)

const STEWARD_DESK_SECTIONS = STAFF_HAT_FUNCTIONS.steward.filter((item) => item.key.startsWith('steward-'));

function ChapterCaseCard({ item, onOpen }: { item: ChapterCaseRow; onOpen: (id: string) => void }) {
  const theme = useTheme();
  return (
    <CaseRowPressable reference={item.reference} visible={[item.status, item.title, item.meta]} onPress={() => { void haptics.select(); onOpen(item.id); }}>
      {({ pressed }) => (
        <Card style={{ opacity: pressed ? 0.82 : 1 }}>
          <View style={styles.row}>
            <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.reference}</Text>
            <StatusChip label={item.status} />
          </View>
          <Heading level={3}>{item.title}</Heading>
          <Body muted>{item.meta}</Body>
        </Card>
      )}
    </CaseRowPressable>
  );
}

function useChapterCases(): { chapterID: string | null; cases: ChapterCaseRow[] | null; error: string | null; retry: () => void } {
  const { dashboard } = useApp();
  const chapterID = dashboard?.member.chapterID ?? null;
  const [cases, setCases] = useState<ChapterCaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setCases(null);
    setError(null);
    void loadChapterCases(chapterID).then((rows) => {
      if (active) setCases(rows);
    }).catch((nextError: unknown) => {
      if (active) setError(nextError instanceof Error && nextError.message.startsWith('Select a campaign') ? nextError.message : 'The campaign’s issues didn’t load. Try again.');
    });
    return () => { active = false; };
  }, [chapterID, reload]);
  return { chapterID, cases, error, retry: () => setReload((value) => value + 1) };
}

export function LiveCaseworkDeskScreen() {
  const { catalogLabel } = useNativeUi();
  const router = useRouter();
  const { cases, error, retry } = useChapterCases();
  return (
    <Screen>
      <Heading>{catalogLabel('Issue work')}</Heading>
      <Body muted>Your committee desk. Each section opens its own screen; the campaign’s issues are below.</Body>
      {STEWARD_DESK_SECTIONS.map((item) => (
        <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={item.label} accessibilityHint={item.blurb} onPress={() => { void haptics.select(); router.push(item.href as never); }}>
          {({ pressed }) => <Card style={{ opacity: pressed ? 0.82 : 1 }}><Heading level={3}>{item.label}</Heading>{item.blurb ? <Body muted>{item.blurb}</Body> : null}</Card>}
        </Pressable>
      ))}
      <Heading level={2}>Campaign issues</Heading>
      <Body muted>Current issues in your selected campaign.</Body>
      {error ? (
        <Card><Body muted>{error}</Body><Button label="Try again" variant="secondary" onPress={retry} /></Card>
      ) : cases === null ? (
        <StateMessage compact title="Loading issues" body="Getting the campaign’s issues." />
      ) : cases.length === 0 ? (
        <StateMessage compact title="No issues yet" body="Issues opened in this campaign appear here." />
      ) : cases.map((item) => <ChapterCaseCard key={item.id} item={item} onOpen={(id) => router.push(`/issue/${id}` as never)} />)}
    </Screen>
  );
}

// ---------------------------------------------------------------- Case queue (coordinator desk)

export function LiveCaseQueueScreen() {
  const { catalogLabel, language, t } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refreshTime = () => setNow(Date.now());
    const timer = setInterval(refreshTime, 60000);
    // A mounted queue can survive suspended JavaScript timers. Recompute
    // its local clock immediately on return, without fetching the queue.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshTime();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  const { chapterID, cases, error, retry } = useChapterCases();
  // Every active case of the chapter, whatever its age, read apart from the
  // newest 100 cases the list below shows (ledger 173); it is read again with
  // them, so Try again reads both.
  const [activeCases, setActiveCases] = useState<ChapterActiveCases | null | 'failed'>(null);
  useEffect(() => {
    if (cases === null) {
      setActiveCases(null);
      return undefined;
    }
    let live = true;
    setActiveCases(null);
    void loadChapterActiveCases(chapterID).then((rows) => {
      if (live) setActiveCases(rows);
    }).catch(() => {
      if (live) setActiveCases('failed');
    });
    return () => { live = false; };
  }, [cases, chapterID]);
  const activeRows = activeCases && activeCases !== 'failed' ? activeCases.rows : null;
  // Ledger 474: a failed active-case read keeps the newest cases already
  // loaded; only the active section says it did not load, listing the active
  // cases among those newest ones.
  const activeFailed = activeCases === 'failed';
  //: a read stopped at its page cap counts only the rows it read.
  const activeCapped = activeCases !== null && activeCases !== 'failed' && activeCases.capped;
  const [deadlines, setDeadlines] = useState<ChapterCaseDeadline[] | null | 'failed'>(null);
  const activeIDs = useMemo(() => (activeRows ?? []).map((item) => item.id), [activeRows]);
  useEffect(() => {
    if (activeRows === null) {
      setDeadlines(null);
      return undefined;
    }
    let active = true;
    setDeadlines(null);
    void loadChapterCaseDeadlines(activeIDs).then((rows) => {
      if (active) setDeadlines(rows ?? 'failed');
    }).catch(() => {
      if (active) setDeadlines('failed');
    });
    return () => { active = false; };
  }, [activeRows, activeIDs]);
  const references = useMemo(() => new Map([...(cases ?? []), ...(activeRows ?? [])].map((item) => [item.id, item.reference])), [cases, activeRows]);
  const otherCases = (cases ?? []).filter((item) => item.status !== 'active');
  const shownActive = activeRows ?? (activeFailed ? (cases ?? []).filter((item) => item.status === 'active') : []);
  const open = (id: string) => router.push(`/issue/${id}` as never);

  return (
    <Screen>
      <Heading>{catalogLabel('Issue queue')}</Heading>
      <Body muted>The campaign’s issue load: active issues and the step deadlines coming up.</Body>
      {error ? (
        <Card><Body muted>{error}</Body><Button label="Try again" variant="secondary" onPress={retry} /></Card>
      ) : cases === null || (activeRows === null && !activeFailed) ? (
        <StateMessage compact title="Loading the queue" body="Getting the campaign’s issues." />
      ) : (
        <>
          <Heading level={2}>Upcoming deadlines</Heading>
          {activeFailed ? (
            <Body muted>The deadlines didn’t load with the active issues.</Body>
          ) : deadlines === null ? (
            <StateMessage compact title="Loading deadlines" body="Getting the open step deadlines." />
          ) : deadlines === 'failed' ? (
            <Body muted>The deadlines didn’t load. The issues below are still current.</Body>
          ) : deadlines.length === 0 ? (
            <Body muted>No open step deadlines on active issues.</Body>
          ) : deadlines.map((item) => {
            // Match the website's procedural clocks: a missed clock, or an
            // elapsed instant (including earlier today), needs attention.
            const overdue = item.status === 'missed' || Date.parse(item.dueAt) < now;
            const stamp = formatZoneInstant(parseDatabaseTimestamp(item.dueAt), language, groupTimeZone(item.timeZone));
            const due = t('Due {date}', { date: stamp ?? t('time unavailable') });
            return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${references.get(item.caseID) ?? 'Issue'}, ${item.label}, ${due}${overdue ? `, ${t('Overdue')}` : ''}`} onPress={() => { void haptics.select(); open(item.caseID); }}>
              {({ pressed }) => (
                <Card style={{ opacity: pressed ? 0.82 : 1 }}>
                  <Text style={[styles.eyebrow, { color: theme.primary }]}>{references.get(item.caseID) ?? 'Issue'}</Text>
                  <Heading level={3}>{item.label || 'Step deadline'}</Heading>
                  {overdue ? <StatusPill label={t('Overdue')} state="attention" /> : null}
                  <Body muted>{due}</Body>
                </Card>
              )}
            </Pressable>;
          })}
          {/*: this list is the open chapter's active cases; cases granted
              from other chapters, which the coordinator figures also count, are
              not in it. A failed or capped read shows no number here: the
              notice below says what is shown. */}
          <Heading level={2}>{activeFailed || activeCapped ? t('Active issues in this campaign') : t('Active issues in this campaign ({count})', { count: shownActive.length })}</Heading>
          <Body muted>{t('Issues from other campaigns that are shared with you are not listed here.')}</Body>
          {activeFailed ? (
            <Card><Body muted>Older active issues didn’t load. Below are the active issues among the campaign’s newest. Try again to load them all.</Body><Button label="Try again" variant="secondary" onPress={retry} /></Card>
          ) : null}
          {/* Ledger 472: the read stops at its page cap; say so instead of a silent count. */}
          {activeCases && activeCases !== 'failed' && activeCases.capped ? <Body muted>{`Showing the first ${shownActive.length.toLocaleString('en-US')} active issues. The campaign may have more that are not listed here.`}</Body> : null}
          {shownActive.length === 0 && !activeFailed ? <Body muted>No active issues in this campaign.</Body> : shownActive.map((item) => <ChapterCaseCard key={item.id} item={item} onOpen={open} />)}
          {otherCases.length ? <Heading level={2}>Other issues</Heading> : null}
          {otherCases.map((item) => <ChapterCaseCard key={item.id} item={item} onOpen={open} />)}
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- Forms

// The co-signed alliance grievance and attachments stay on the website until
// the second part of REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 .

// One open editor. ownerID is the member it was opened for and generation
// tells it apart from any editor opened before or after it, so a save, sign or
// submit that finishes late changes only the editor that started it (gate
// stage 136 on, r1). dataVersion is a sealed form's stored envelope
// version, the baseline its next save names; dirty marks answers not yet saved.
export type FormEdit = {
  ownerID: string;
  generation: number;
  template: FormTemplate;
  formID: string | null;
  answers: FormAnswers;
  step: number;
  dataVersion: string | null;
  status: string;
  reviewNote: string;
  signatureCurrent: boolean;
  signatureStale: boolean;
  dirty: boolean;
  // Answers of saves whose reply never came (gate stage 138 on, r3s3).
  unconfirmed: FormAnswers[];
  // An ordinary form's answers as last known to be stored, which its next
  // save names as its base: {} for a new form . Absent on an editor
  // kept from an older build, which then saves as before.
  baseAnswers?: StoredAnswers;
  // An ordinary form's answers typed here that a refusal did not save, kept
  // beside the stored ones until the member uses or drops them ( G7-3).
  rejected?: FormAnswers | null;
  // The server refused a save because this form is no longer the member's
  // editable one. That refusal is final: nothing is sent for this editor
  // again .
  closed: boolean;
  // The attachments the member was shown, which a signature covers; null
  // until they are read (part 2 of).
  files: FormFile[] | null;
  // The unit a resumed form was made for; its saves keep it.
  boundUnit?: { unitId: string | null };
};

// The newest few unconfirmed sealed saves are kept; an older one could only
// match stored answers that a newer save has already been checked against.
const UNCONFIRMED_SAVE_LIMIT = 5;

const FORM_FAILURE_TEXT: Record<Exclude<FormActionError['reason'], 'failed'>, NativeUiKey> = {
  unavailable: 'This form’s answers can’t be opened right now. Nothing was changed. Try again later, or ask your campaign for help.',
  'session-changed': 'You were signed out or switched accounts, so this form was not saved.',
  'signature-required': 'Draw and save your signature before submitting.',
  'attachments-pending': 'Wait until every attachment has finished uploading and its safety check, then submit again.',
  closed: 'This form was already submitted or replaced, so nothing was saved. Go back to All forms to see it.',
  'form-changed': 'This form was changed on another device. Review the answers below, then sign again.',
  'attachments-changed': 'The attachments changed on another device. Review them below, then sign again.',
  'unit-required': 'Choose the unit for this form first.',
};

// Whether two lists name the same confirmed files, the ones a signature covers.
function sameManifest(left: readonly FormFile[], right: readonly FormFile[]): boolean {
  return JSON.stringify(reviewedManifest(left)) === JSON.stringify(reviewedManifest(right));
}

function formFailureText(error: unknown, fallback: NativeUiKey): NativeUiKey {
  if (!(error instanceof FormActionError) || error.reason === 'failed') return fallback;
  return FORM_FAILURE_TEXT[error.reason];
}

function FormFieldInput({ field, value, onChange }: { field: FormField; value: FormAnswerValue | undefined; onChange: (next: FormAnswerValue) => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const label = field.required ? t('{label} (required)', { label: field.label }) : field.label;
  if (field.type === 'select' || field.type === 'radio') {
    return (
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
        <ChoiceChips label={field.label} options={field.options.map((option) => ({ key: option.value, label: option.label }))} value={typeof value === 'string' ? value : null} onChange={onChange} />
      </View>
    );
  }
  if (field.type === 'multiselect') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
        <View accessibilityLabel={field.label} style={styles.wrap}>
          {field.options.map((option) => {
            const selected = chosen.includes(option.value);
            return (
              <Pressable
                key={option.value}
                accessibilityRole="checkbox"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: selected }}
                onPress={() => { void haptics.select(); onChange(selected ? chosen.filter((item) => item !== option.value) : [...chosen, option.value]); }}
                style={({ pressed }) => [styles.chip, { backgroundColor: selected ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}
              >
                <Text style={[styles.chipText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }
  if (field.type === 'checkbox') {
    const checked = value === true;
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={field.label}
        accessibilityState={{ checked }}
        onPress={() => { void haptics.select(); onChange(!checked); }}
        style={({ pressed }) => [styles.checkRow, { opacity: pressed ? 0.82 : 1 }]}
      >
        <View style={[styles.checkBox, { borderColor: checked ? theme.primary : theme.mutedForeground, backgroundColor: checked ? theme.primary : 'transparent' }]}>
          {checked ? <Text style={[styles.checkMark, { color: theme.primaryForeground }]}>✓</Text> : null}
        </View>
        <Text style={[styles.fieldLabel, styles.switchLabel, { color: theme.foreground }]}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={field.label}
        multiline={field.type === 'textarea'}
        maxLength={field.maxLength ?? undefined}
        keyboardType={field.type === 'number' ? 'numeric' : 'default'}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={typeof value === 'string' ? value : ''}
        onChangeText={onChange}
        placeholder={field.type === 'date' ? 'YYYY-MM-DD' : undefined}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, field.type === 'textarea' ? styles.multiline : null, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      {field.type === 'date' && typeof value === 'string' && value.trim() && !FORM_DATE_PATTERN.test(value.trim()) ? <Body muted>{t('Write the date as year-month-day, for example 2026-11-13.')}</Body> : null}
    </View>
  );
}

// REQ-UG-NATIVE-FMLA-FORMS-SHOW-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261113
//: the GINA safe-harbor notice and the no-diagnosis hint, in the
// member's language, wherever the phone shows an FMLA form: on its cards, and
// before the first step of its editor, as on the web .
function FormHealthNotice({ templateKey, language }: { templateKey: string; language: 'en' | 'es' }) {
  const theme = useTheme();
  const lines = healthNoticeFor(templateKey, language);
  if (!lines.length) return null;
  return (
    <View style={[styles.healthNotice, { borderColor: theme.border }]}>
      {lines.map((text, index) => <Body key={text} style={index ? styles.healthHint : undefined}>{text}</Body>)}
    </View>
  );
}

// kept: the feature route's hold on the open editor across a return to the
// foreground, when this screen unmounts and mounts again (, gate stage
// 172 r1s1); see forms/keptFormEditor.ts.
// Every editor opened in this app run takes a generation no earlier editor
// had, across every Forms screen: a screen that mounts after a return to the
// foreground counts on from here, so work started for a closed editor can
// never match the next one (ledger 223, gate stage 183 r10s1).
let lastFormEditorGeneration = 0;
function nextFormEditorGeneration(after: number): number {
  lastFormEditorGeneration = Math.max(lastFormEditorGeneration, after) + 1;
  return lastFormEditorGeneration;
}

export function LiveFormsScreen({ kept }: { kept?: KeptFormEditor<FormEdit, Outcome> } = {}) {
  const theme = useTheme();
  const { language, locale, t } = useNativeUi();
  const { dashboard, duesContext, session, mode } = useApp();
  const authenticatedMode = mode === 'authenticated';
  const userID = dashboard?.member.id ?? '';
  // The signed-in member. Unlike the dashboard, it stays set while a return
  // to the foreground re-checks the session and reloads the dashboard.
  const sessionUserID = session?.user.id ?? '';
  const runsDues = duesContext?.runsDues ?? null;
  const [templates, setTemplates] = useState<FormTemplate[] | null>(null);
  const [forms, setForms] = useState<MemberForm[] | null>(null);
  // Co-signers on the member's forms and their invitations to co-sign; null
  // while unread or when the read failed, which hides only those sections.
  const [cosigning, setCosigning] = useState<Cosigning | null>(null);
  // The approved form whose filing copy is being prepared, and whether the
  // last try needs the member to verify it is them first.
  const [filing, setFiling] = useState<string | null>(null);
  const [filingStepUp, setFilingStepUp] = useState(false);
  const [error, setError] = useState<NativeUiKey | null>(null);
  const [reload, setReload] = useState(0);
  // The kept editor as this screen first rendered it. Work can change the
  // kept editor between that render and the subscription below (gate stage
  // 180, r8s1), so the subscription reads it again.
  const [firstRead] = useState<FormEdit | null>(() => kept?.read() ?? null);
  const [editing, setEditingState] = useState<FormEdit | null>(firstRead);
  // True while the screen may still show firstRead after the kept editor moved
  // on: nothing is written back until the newer editor is on screen.
  const behindKept = useRef(false);
  const reconciled = useRef(false);
  // The editor as last rendered or set here, for the async save, sign and
  // submit steps, which must send the answers on screen.
  const editingRef = useRef<FormEdit | null>(null);
  editingRef.current = editing;
  // A save, signature or submission an earlier Forms screen started for this
  // member is still running (gate stage 176, r3s1): none starts here until it
  // ends and its result has reached the kept editor.
  const [heldAtMount] = useState(() => kept?.busy(sessionUserID) ?? false);
  const [saving, setSaving] = useState(heldAtMount);
  const [submitting, setSubmitting] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  // The newest request to open the editor. A Start lookup that finishes after
  // the member opened another form is ignored (gate stage 121 on, r3s1).
  const openRequest = useRef(0);
  // A kept editor keeps its generation; the next one opened counts on from it.
  const editorGeneration = useRef(editing?.generation ?? 0);
  // The newest list read. A signature saved while a read is pending makes
  // that read stale, so an unsigned row it carries never replaces the signed
  // one (gate stage 138 on, r3s4).
  const listRead = useRef(0);
  const [notice, setNoticeState] = useAnnouncedOutcome('forms-live');

  // Work this screen started can finish after it unmounts, when a return to
  // the foreground re-checks the session (gate stage 176, r3s1 and r4s1). Its
  // changes to the editor and its notice then go to the editor the route
  // keeps, or to the Forms screen showing it now, instead of vanishing.
  const mounted = useRef(true);
  const keptRef = useRef(kept);
  keptRef.current = kept;
  const ownerRef = useRef(sessionUserID);
  ownerRef.current = sessionUserID;
  const [lineage] = useState(() => kept?.lineage() ?? 0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // A plain value replaces only the editor it was meant for: the one on screen
  // before the change, whose generation is read before editingRef moves.
  const setEditing = (next: FormEdit | null | ((current: FormEdit | null) => FormEdit | null), generation = editingRef.current?.generation) => {
    if (mounted.current) {
      setEditingState(next);
      return;
    }
    keptRef.current?.relay(lineage, ownerRef.current, typeof next === 'function'
      ? next
      : (current) => (current && current.generation === generation ? next : current));
  };
  const setNotice = useCallback((next: Outcome | null) => {
    if (mounted.current) setNoticeState(next);
    else if (next) keptRef.current?.relayNotice(lineage, ownerRef.current, next);
  }, [lineage, setNoticeState]);
  const showNotice = useRef(setNoticeState);
  showNotice.current = setNoticeState;
  const heldOpen = useRef(heldAtMount);
  useEffect(() => {
    if (!kept) return undefined;
    // Only work an earlier screen started; this screen's own work settles itself.
    const ended = () => {
      if (!heldOpen.current) return;
      heldOpen.current = false;
      setSaving(false);
      setSubmitting(false);
      listRead.current += 1;
      setReload((value) => value + 1);
    };
    const relayed = kept.takeNotice(sessionUserID);
    if (relayed) showNotice.current(relayed);
    const unlisten = kept.listen(sessionUserID, {
      update: (update) => setEditingState(update),
      notice: (next) => showNotice.current(next),
      idle: ended,
    });
    // Work that ended between this screen's first render and now: its changes
    // are in the kept editor (a new version, or a close after a submission),
    // and its hold has gone.
    if (!reconciled.current) {
      reconciled.current = true;
      const latest = kept.read();
      if (latest !== firstRead) {
        behindKept.current = true;
        setEditingState(latest);
      }
    }
    if (!kept.busy(sessionUserID)) ended();
    return unlisten;
  }, [kept, sessionUserID]);
  // Per-unit settings: a member of several units picks the unit before
  // the new-form picker shows that unit's forms. Held, the context is legacy
  // and the screen is unchanged.
  const unitWorkflow = useNativeUnitContext();
  const unitContext = unitWorkflow.context && !unitWorkflow.context.legacy ? unitWorkflow.context : null;
  const unitLoading = authenticatedMode && !unitWorkflow.context && !unitWorkflow.error;
  const unitChosen = Boolean(unitContext?.effective && !unitContext.needsChoice);

  useEffect(() => {
    let active = true;
    const read = ++listRead.current;
    setError(null);
    void Promise.all([loadFormTemplates(language === 'es'), loadMyForms(userID)]).then(([nextTemplates, nextForms]) => {
      if (!active || read !== listRead.current) return;
      setTemplates(nextTemplates);
      setForms(nextForms);
      void loadCosigning(userID, new Set(nextForms.map((form) => form.id))).then((next) => {
        if (active && read === listRead.current) setCosigning(next);
      }, () => {
        if (active && read === listRead.current) setCosigning(null);
      });
    }).catch(() => {
      if (active) setError('Your forms didn’t load. Try again.');
    });
    return () => { active = false; };
  }, [language, userID, reload]);

  const unitForms = unitChosen ? unitContext?.effective?.forms ?? null : null;
  const startable = useMemo(() => {
    const all = startableFormTemplates(templates ?? []);
    return unitForms ? all.filter((template) => unitForms.includes(template.key)) : all;
  }, [templates, unitForms]);
  const labelFor = (form: MemberForm) => templateForForm(templates ?? [], form)?.label ?? startable.find((template) => template.key === form.templateKey)?.label ?? form.templateKey.replaceAll('_', ' ');

  const updateEditing = (next: FormEdit | null) => {
    const generation = editingRef.current?.generation;
    editingRef.current = next;
    setEditing(next, generation);
  };

  // An editor opened for one member closes when another signs in, or on
  // sign-out. It follows the signed-in session, not the dashboard: every
  // return to the foreground (after the file picker or a share sheet) clears
  // the dashboard while the session is re-checked, and that moment is not
  // another member . Each request still runs on the session pinned
  // for it and stops when the member changes (services/memberForms.ts).
  useEffect(() => {
    if (editingRef.current && editingRef.current.ownerID !== sessionUserID) {
      editingRef.current = null;
      setEditing(null);
      setNotice(null);
    }
  }, [sessionUserID, setNotice]);

  // The route keeps the open editor, and nothing once it closes, for the
  // signed-in member only.
  useEffect(() => {
    if (behindKept.current && editing === firstRead) return;
    behindKept.current = false;
    kept?.write(editing && editing.ownerID === sessionUserID ? editing : null);
  }, [editing, firstRead, kept, sessionUserID]);

  // Saves the open editor's answers when they changed, or when the form has no
  // id yet, and resolves to the form's id. Answers typed while the save is
  // pending stay on screen and stay unsaved (dirty); a closed editor stays
  // closed (gate stage 118 on). Signing and submitting pass always, so
  // they save first: a sealed save names the version the editor opened, so answers
  // changed on the website since then refuse the save and stop the signature,
  // and an ordinary save makes the stored answers the ones on screen; an
  // unchanged save keeps an earlier signature (gate stage 136 on, r1s1).
  async function persist(always = false): Promise<FormSaved> {
    const snapshot = editingRef.current;
    if (!snapshot) throw new FormActionError('failed');
    if (snapshot.closed) throw new FormActionError('closed');
    if (snapshot.formID && !snapshot.dirty && !always) return { formID: snapshot.formID, dataVersion: snapshot.dataVersion, answers: cleanFormAnswers(snapshot.template, snapshot.answers) };
    // Per-unit settings: a member of several units saves only once the
    // unit for this work is chosen; a resumed form keeps the unit it was made
    // for. Held, the context is legacy and this is skipped.
    const bound = snapshot.boundUnit;
    if (unitLoading || (unitContext && !unitChosen && !bound)) throw new FormActionError('unit-required');
    const unit = unitContext ? { unitId: bound ? bound.unitId : unitContext.unitId, actorId: unitContext.actorId, chapterId: unitContext.chapterId, organizationId: unitContext.organizationId } : null;
    // The first save makes the form this unit's: the open editor keeps that
    // unit from then on and stops offering the unit choice (ledger 231).
    const binding = unit && !bound ? { boundUnit: { unitId: unit.unitId } } : {};
    const { generation } = snapshot;
    let saved: FormSaved;
    try {
      saved = await saveMyFormDraft(snapshot.template, snapshot.answers, snapshot.step, {
        ownerID: snapshot.ownerID,
        formID: snapshot.formID,
        dataVersion: snapshot.dataVersion,
        unconfirmed: snapshot.unconfirmed,
        ...(snapshot.baseAnswers ? { baseAnswers: snapshot.baseAnswers } : {}),
        onFormID: (formID) => setEditing((current) => (current && current.generation === generation ? { ...current, formID, ...binding } : current)),
        ...(unit ? { unit } : {}),
      });
    } catch (nextError) {
      // A sealed save with no answer may have stored what it sent; the next
      // save recognises those answers before sending newer ones (r3s3).
      // An earlier one it found stored becomes the baseline at once, so later
      // failures can never evict the only snapshot that matches storage, and
      // a retry of the same answers is kept once (gate stage 139, r6s2).
      if (nextError instanceof FormActionError && nextError.reason === 'closed') {
        if (editingRef.current?.generation === generation) editingRef.current = { ...editingRef.current, closed: true };
        setEditing((current) => (current && current.generation === generation ? { ...current, closed: true } : current));
        throw nextError;
      }
      const sent = nextError instanceof FormActionError ? nextError.sent : null;
      const baseline = nextError instanceof FormActionError ? nextError.baseline : null;
      if (sent || baseline) {
        setEditing((current) => {
          if (!current || current.generation !== generation) return current;
          const kept = baseline ? [] : current.unconfirmed;
          const unconfirmed = sent && !kept.some((earlier) => sameStoredAnswers(current.template, earlier, sent)) ? [...kept, sent] : kept;
          return { ...current, dataVersion: baseline ?? current.dataVersion, unconfirmed: unconfirmed.slice(-UNCONFIRMED_SAVE_LIMIT) };
        });
      }
      throw nextError;
    }
    // The saved row carries the answers just sent (the cleaned answers are
    // what the server stores), so All forms then Continue reopens them and not
    // the copy read before the save (gate stage 121 on, r4s1). A sealed
    // form reopens through the server either way.
    const savedAnswers = formIsSealed(snapshot.template.key) ? {} : cleanFormAnswers(snapshot.template, snapshot.answers);
    // Changed answers cleared the stored signature, so the cached row loses its
    // current signature too and reopens asking for a new one, even while the
    // list refresh is pending or fails (gate stage 146, r7s2).
    setForms((current) => (current ? current.map((form) => (form.id === saved.formID ? {
      ...form, answers: savedAnswers, step: snapshot.step, updatedAt: new Date().toISOString(), sealedMarker: formIsSealed(form.templateKey),
      // What this save stored is the base a reopened editor names, even
      // before the list is read again ( review G7-2).
      ...(formIsSealed(form.templateKey) ? {} : { storedAnswers: saved.answers }),
      ...(snapshot.dirty ? { signatureCurrent: false } : {}),
      ...(form.boundUnit ? {} : binding),
    } : form)) : current));
    setEditing((current) => (current && current.generation === generation ? { ...current, ...(current.boundUnit ? {} : binding), formID: saved.formID, dataVersion: saved.dataVersion, unconfirmed: [], dirty: current.answers !== snapshot.answers, ...(formIsSealed(snapshot.template.key) ? {} : { baseAnswers: saved.answers }) } : current));
    setReload((value) => value + 1);
    return saved;
  }

  async function save() {
    if (!editingRef.current || saving) return;
    setSaving(true);
    const release = kept?.hold(sessionUserID);
    setNotice(null);
    try {
      await persist();
      void haptics.success();
      setNotice({ text: t('Saved.'), error: false });
    } catch (nextError) {
      const owner = editingRef.current;
      if (owner && nextError instanceof FormActionError && nextError.reason === 'form-changed') await showStoredAfterChange(owner);
      else setNotice({ text: t(formFailureText(nextError, 'The form was not saved. Check your connection and try again.')), error: true });
    } finally {
      setSaving(false);
      release?.();
    }
  }

  // A step change saves changed answers, as the web's editor does.
  function goToStep(next: number) {
    const current = editingRef.current;
    if (!current || saving) return;
    updateEditing({ ...current, step: Math.max(0, Math.min(current.template.steps.length, next)) });
    if (current.dirty) void save();
  }

  function answer(key: string, next: FormAnswerValue) {
    setEditing((current) => current ? {
      ...current,
      answers: { ...current.answers, [key]: next },
      dirty: true,
      // The server clears the signature when the saved answers change.
      signatureCurrent: false,
      signatureStale: current.signatureStale || current.signatureCurrent,
    } : current);
  }

  // Answers stored by another device replace the editor's for review, and
  // Submit waits for a signature over them.
  // A save, signature or submission the server refused because the form
  // changed since this review: the stored form goes on screen. When it cannot
  // be read, the editor keeps its answers but its signature no longer counts,
  // so Submit stays off either way and nothing is sent again (gate stage 163
  // P2; the controller's ruling on the  device run).
  async function showStoredAfterChange(owner: FormEdit) {
    let formID = (editingRef.current?.generation === owner.generation ? editingRef.current.formID : null) ?? owner.formID;
    // A refused first save knew no form: the draft another session made is
    // the member's open form of this template, and this editor now writes it,
    // so its next save and Close are checked against it (, the website's
    // gate final on).
    if (!formID && !formIsSealed(owner.template.key)) {
      const draft = await loadMyOpenFormDraft(owner.ownerID, owner.template.key).catch(() => null); // swallow-ok: unread, the review is still asked for below
      if (draft) {
        formID = draft.id;
        const bound = draft.id;
        setEditing((current) => (current && current.generation === owner.generation && !current.formID ? { ...current, formID: bound } : current));
      }
    }
    const stored = formID ? await readStoredFormAnswers(owner.template.key, formID, owner.ownerID).catch(() => null) : null; // swallow-ok: unread, the signature is cleared and the review is still asked for below
    if (stored) {
      showChanged(owner, stored);
      return;
    }
    setEditing((current) => (current && current.generation === owner.generation ? { ...current, signatureCurrent: false, signatureStale: true } : current));
    setNotice({ text: t(FORM_FAILURE_TEXT['form-changed']), error: true });
  }

  function showChanged(owner: FormEdit, stored: OpenedForm) {
    setEditing((current) => {
      if (!current || current.generation !== owner.generation) return current;
      // The member's own answers are never lost to the refusal: an ordinary
      // form keeps them for an explicit choice ( G7-3). A sealed form
      // adopts the stored version, as before.
      const kept = !formIsSealed(current.template.key) && !sameStoredAnswers(current.template, current.answers, stored.answers)
        ? current.answers : null;
      return {
        ...current, answers: stored.answers, dataVersion: stored.dataVersion ?? current.dataVersion, dirty: false, unconfirmed: [],
        ...(stored.stored ? { baseAnswers: stored.stored } : {}),
        rejected: kept ?? current.rejected ?? null,
        signatureCurrent: false, signatureStale: true,
      };
    });
    listRead.current += 1;
    setReload((value) => value + 1);
    setNotice({ text: t('This form was changed on another device. Review the answers below, then sign again.'), error: true });
  }

  const fileTarget = (owner: FormEdit, formID: string): FormFileTarget => ({ formID, templateKey: owner.template.key, ownerID: owner.ownerID });

  // The form's attachments now, against those the member was shown. A
  // difference puts the new list on screen, clears the signature and stops
  // the step; an unfinished upload stops it too, as the server would.
  // The list is put on screen only while it is the newest read of this form:
  // a later read by the attachments section, here or on a screen mounted
  // since, keeps its newer list (ledger 223, gate stage 183 r9s1).
  async function attachmentsAsShown(owner: FormEdit, formID: string): Promise<FormFile[]> {
    const newest = startFormFileRead(fileTarget(owner, formID));
    const current = await listFormFiles(fileTarget(owner, formID));
    const shown = editingRef.current?.generation === owner.generation ? editingRef.current.files ?? [] : owner.files ?? [];
    const changed = !sameManifest(current, shown);
    setEditing((editor) => (editor && editor.generation === owner.generation && editor.formID === formID ? {
      ...editor, ...(newest() ? { files: current } : {}), ...(changed ? { signatureCurrent: false, signatureStale: editor.signatureStale || editor.signatureCurrent } : {}),
    } : editor));
    if (changed) throw new FormActionError('attachments-changed');
    if (current.some((file) => !file.confirmed)) throw new FormActionError('attachments-pending');
    return current;
  }

  // The attachments section reports every list it reads or changes. A change
  // to the confirmed files clears the signature, as the server does.
  // Only for the editor and form the list was read for (ledger 223, r10s1).
  function filesRead(generation: number, formID: string | null, files: FormFile[]) {
    setEditing((current) => {
      if (!current || current.generation !== generation || current.formID !== formID) return current;
      const changed = current.files !== null && !sameManifest(current.files, files);
      return { ...current, files, ...(changed ? { signatureCurrent: false, signatureStale: current.signatureStale || current.signatureCurrent } : {}) };
    });
  }

  async function sign(strokes: SignatureStrokes): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    const release = kept?.hold(sessionUserID);
    setNotice(null);
    try {
      const owner = editingRef.current;
      if (!owner) return false;
      const saved = await persist(true);
      const formID = saved.formID;
      const shown = await attachmentsAsShown(owner, formID);
      // Signed as reviewed: the server refuses, signing nothing, when the form
      // holds other answers or attachments by now .
      await signMyForm(owner.template.key, strokes, true, owner.ownerID, { saved, attachmentIDs: reviewedManifest(shown).map((file) => file.id) });
      // The signature covers every confirmed attachment the form holds when it
      // is stored. One added or removed on another device while it was on its
      // way is put on screen, and Submit waits for a new signature (gate
      // stage 139 on, r5s2 and r6s1). A list that cannot be read is
      // read again before Submit.
      const newestAfter = startFormFileRead(fileTarget(owner, formID));
      const after = await listFormFiles(fileTarget(owner, formID)).catch(() => null); // swallow-ok: Submit reads the attachments again and refuses on any difference
      if (after && !sameManifest(after, shown)) {
        setEditing((current) => (current && current.generation === owner.generation ? { ...current, ...(newestAfter() ? { files: after } : {}), signatureCurrent: false, signatureStale: true } : current));
        listRead.current += 1;
        setReload((value) => value + 1);
        setNotice({ text: t(FORM_FAILURE_TEXT['attachments-changed']), error: true });
        return true;
      }
      // The signature covers whatever the form held when it was stored. It is
      // read back: answers changed on another device since this review are
      // shown for review again, and Submit waits for a new signature over
      // them (gate stage 138 on, r3s2; the server fix is). A
      // read-back that fails changes nothing here; the save before Submit
      // still refuses answers changed elsewhere.
      const stored = await readStoredFormAnswers(owner.template.key, formID, owner.ownerID).catch(() => null); // swallow-ok: an unreadable form keeps the signature as saved; Submit saves against it again
      if (stored && (!sameStoredAnswers(owner.template, stored.answers, owner.answers) || (saved.dataVersion !== null && stored.dataVersion !== saved.dataVersion))) {
        showChanged(owner, stored);
        // The pad clears, so the next signature is drawn and consented to
        // for the answers now shown.
        return true;
      }
      setEditing((current) => (current && current.generation === owner.generation ? { ...current, signatureCurrent: true, signatureStale: false } : current));
      // The list reopens this form signed (gate stage 136 on, r2s2). A
      // read started before the signature is dropped, and the list is read
      // again now that the signature is stored (r3s4).
      listRead.current += 1;
      setForms((current) => (current ? current.map((form) => (form.id === formID ? { ...form, signed: true, signatureCurrent: true } : form)) : current));
      setReload((value) => value + 1);
      void haptics.success();
      setNotice({ text: t('Signature saved for this version.'), error: false });
      return true;
    } catch (nextError) {
      // The server found the form changed since this review and signed
      // nothing: the stored answers go on screen for review .
      const owner = editingRef.current;
      if (owner && nextError instanceof FormActionError && nextError.reason === 'form-changed') {
        await showStoredAfterChange(owner);
        return true;
      }
      setNotice({ text: t(formFailureText(nextError, 'Your signature was not saved. Check your connection and try again.')), error: true });
      return false;
    } finally {
      setSaving(false);
      release?.();
    }
  }

  async function submit() {
    if (saving) return;
    setSaving(true);
    setSubmitting(true);
    const release = kept?.hold(sessionUserID);
    setNotice(null);
    const owner = editingRef.current;
    const submitted = () => {
      void haptics.success();
      // Closes the editor this submission came from, here or, after Forms
      // unmounted, the one the route kept (gate stage 179, r5s2 and r6s1).
      if (owner) {
        if (editingRef.current?.generation === owner.generation) editingRef.current = null;
        setEditing((current) => (current && current.generation === owner.generation ? null : current));
      }
      setNotice({ text: t('Form submitted — in review'), error: false });
      setReload((value) => value + 1);
    };
    try {
      if (!owner) return;
      const saved = await persist(true);
      const shown = await attachmentsAsShown(owner, saved.formID);
      // Filed as reviewed: the server refuses, filing nothing, when the form
      // holds other content or attachments by now .
      await submitMyForm(owner.template.key, owner.ownerID, { saved, attachmentIDs: reviewedManifest(shown).map((file) => file.id) });
      submitted();
    } catch (nextError) {
      // The server found the form changed since this review, even if signed
      // again elsewhere, and filed nothing: the stored answers go on screen
      // for review, and Submit waits for a new signature over them. Nothing
      // is sent again (gate stage 146 on, r8s1;).
      if (owner && nextError instanceof FormActionError && nextError.reason === 'form-changed') {
        await showStoredAfterChange(owner);
        return;
      }
      // A submission whose reply was lost may have filed the form. Its own
      // form is read back, so a retry closes the editor rather than filing a
      // second copy (gate stage 138 on, r3s1).
      const formID = (editingRef.current && editingRef.current.generation === owner?.generation ? editingRef.current.formID : null) ?? owner?.formID;
      if (owner && formID && !(nextError instanceof FormActionError && nextError.reason === 'session-changed')
        && await myFormWasFiled(formID, owner.ownerID).catch(() => false)) { // swallow-ok: an unreadable status keeps the submission's own failure, shown below
        submitted();
        return;
      }
      if (nextError instanceof FormActionError && nextError.reason === 'signature-required') {
        setEditing((current) => (current ? { ...current, signatureCurrent: false } : current));
      }
      setNotice({ text: t(formFailureText(nextError, 'The form was not submitted. Check your connection and try again.')), error: true });
    } finally {
      setSaving(false);
      setSubmitting(false);
      release?.();
    }
  }

  const noticeView = notice ? (
    <View accessibilityLiveRegion="polite" accessibilityRole={notice.error ? 'alert' : 'text'}>
      <Body style={notice.error ? { color: theme.destructive } : undefined}>{notice.text}</Body>
    </View>
  ) : null;

  if (editing) {
    const total = editing.template.steps.length;
    const reviewing = editing.step >= total;
    const step = editing.template.steps[editing.step];
    const blurb = formTemplateBlurb(editing.template, runsDues, language);
    const cosigned = COSIGNED_FORM_TEMPLATE_KEYS.has(editing.template.key);
    const formCosigners = cosigned && editing.formID ? cosigning?.cosigners[editing.formID] ?? [] : [];
    const acceptedCosigners = formCosigners.filter((cosigner) => cosigner.status === 'accepted').length;
    return (
      <Screen scrollEnabled={!drawing}>
        <Button label={t('All forms')} variant="secondary" disabled={saving} onPress={() => { updateEditing(null); setNotice(null); }} />
        <Heading>{editing.template.label}</Heading>
        {blurb ? <Body muted>{blurb}</Body> : null}
        {editing.status === 'returned' && editing.reviewNote ? <Body>{t('Returned — {note}', { note: editing.reviewNote })}</Body> : null}
        {editing.rejected ? (
          <Card>
            <Body>{t('The answers you typed on this phone were not saved. The stored answers are shown below. Use your answers to replace them, or keep the stored answers.')}</Body>
            <Button label={t('Use my answers')} disabled={saving} onPress={() => {
              const mine = editing.rejected;
              setEditing((current) => (current && current.generation === editing.generation && mine ? { ...current, answers: mine, dirty: true, rejected: null, signatureCurrent: false } : current));
            }} />
            <Button label={t('Keep the stored answers')} variant="secondary" disabled={saving} onPress={() => {
              setEditing((current) => (current && current.generation === editing.generation ? { ...current, rejected: null } : current));
            }} />
          </Card>
        ) : null}
        {acceptedCosigners > 0 && !reviewing ? (
          <Body muted>{t('{n} co-signed this issue report as written. If you change any answer, their co-signatures are put on hold ("Needs re-affirm") and each co-signer is notified to review and re-affirm the new version. Reviewing without changing answers keeps every co-signature intact.', { n: acceptedCosigners })}</Body>
        ) : null}
        <Body muted>{t('Step {current} of {total}', { current: Math.min(editing.step, total) + 1, total: total + 1 })}</Body>
        {reviewing ? (
          <LiveFormFiling
            template={editing.template}
            answers={cleanFormAnswers(editing.template, editing.answers)}
            missing={missingRequiredFields(editing.template, cleanFormAnswers(editing.template, editing.answers))}
            unsaved={unsavedAnswerFields(editing.template, editing.answers)}
            attachments={{
              target: editing.formID ? fileTarget(editing, editing.formID) : null,
              files: editing.files,
              onFiles: (files) => filesRead(editing.generation, editing.formID, files),
            }}
            signatureCurrent={editing.signatureCurrent}
            signatureStale={editing.signatureStale}
            busy={saving}
            submitting={submitting}
            onSign={sign}
            onSubmit={() => { void submit(); }}
            onDrawingChange={setDrawing}
          />
        ) : null}
        {reviewing && cosigned ? (
          <LiveFormCosigners formID={editing.formID} ownerID={editing.ownerID} cosigners={formCosigners} busy={saving} onChanged={() => setReload((value) => value + 1)} />
        ) : null}
        {reviewing ? null : step ? (
          <View style={styles.field}>
            {step.title ? <Heading level={2}>{step.title}</Heading> : null}
            {editing.step === 0 ? <FormHealthNotice templateKey={editing.template.key} language={language} /> : null}
            {step.fields.map((field) => (
              <FormFieldInput key={field.key} field={field} value={editing.answers[field.key]} onChange={(next) => answer(field.key, next)} />
            ))}
          </View>
        ) : null}
        {editing.boundUnit ? null : <NativeUnitChoice workflow={unitWorkflow} disabled={saving} />}
        <View style={styles.actions}>
          {reviewing ? null : <Button label={editing.step === total - 1 ? t('Review & submit') : t('Next')} disabled={saving} onPress={() => goToStep(editing.step + 1)} />}
          {editing.step > 0 ? <Button label={t('Back')} variant="secondary" disabled={saving} onPress={() => goToStep(editing.step - 1)} /> : null}
          <Button label={saving && !submitting ? t('Saving…') : t('Save')} variant="secondary" disabled={saving} onPress={() => { void save(); }} />
        </View>
        {noticeView}
      </Screen>
    );
  }

  const openDraft = (template: FormTemplate, form: MemberForm | null, opened: OpenedForm | null = null) => {
    openRequest.current += 1;
    setNotice(null);
    editorGeneration.current = nextFormEditorGeneration(editorGeneration.current);
    updateEditing({
      ownerID: userID,
      generation: editorGeneration.current,
      template,
      formID: form?.id ?? null,
      answers: opened?.answers ?? form?.answers ?? {},
      step: Math.max(0, Math.min(template.steps.length, form?.step ?? 0)),
      dataVersion: opened?.dataVersion ?? null,
      status: form?.status ?? 'draft',
      reviewNote: form?.reviewNote ?? '',
      signatureCurrent: form?.signatureCurrent ?? false,
      signatureStale: Boolean(form?.signed && !form.signatureCurrent),
      dirty: false,
      unconfirmed: [],
      baseAnswers: opened?.stored ?? form?.storedAnswers ?? {},
      closed: false,
      ...(form?.boundUnit ? { boundUnit: form.boundUnit } : {}),
      files: null,
    });
  };

  // A sealed form's answers are opened through the sensitive-content API
  // before its editor opens; one that cannot be opened never opens.
  async function openForm(template: FormTemplate, form: MemberForm, request = ++openRequest.current) {
    if (!formIsSealed(form.templateKey)) { openDraft(template, form); return; }
    setStarting(form.templateKey);
    try {
      const opened = await openFormAnswers(form, userID);
      if (request === openRequest.current) openDraft(template, form, opened);
    } catch (nextError) {
      if (request === openRequest.current) setNotice({ text: t(formFailureText(nextError, 'The form didn’t open. Check your connection and try again.')), error: true });
    } finally {
      setStarting(null);
    }
  }

  // A new form starts from the member's open draft of that template when one
  // exists outside the recent list, because save_form_draft would otherwise
  // replace that draft's answers with this empty form's (gate stage 118 on
  //). Only a genuinely new form drops the Dues choice.
  async function startForm(template: FormTemplate) {
    if (starting) return;
    setStarting(template.key);
    setNotice(null);
    const request = ++openRequest.current;
    try {
      const draft = await loadMyOpenFormDraft(userID, template.key);
      if (request !== openRequest.current) return;
      if (draft) await openForm(templateForForm(templates ?? [], draft) ?? template, draft, request);
      else openDraft(formTemplateForNewStart(template, runsDues), null);
    } catch {
      if (request === openRequest.current) setNotice({ text: t('The form didn’t open. Check your connection and try again.'), error: true });
    } finally {
      setStarting(null);
    }
  }

  // An approved form's official filing copy goes to the device's share sheet,
  // as the website offers it (part 2 of).
  async function shareFiling(form: MemberForm) {
    if (filing) return;
    setFiling(form.id);
    setFilingStepUp(false);
    setNotice(null);
    try {
      await shareFilingCopy(form.id, userID, language === 'es' ? 'es' : 'en');
    } catch (nextError) {
      if (nextError instanceof FormFileError && nextError.reason === 'step-up') setFilingStepUp(true);
      else setNotice({ text: t('Could not prepare the filing copy. Try again.'), error: true });
    } finally {
      setFiling(null);
    }
  }

  return (
    <Screen scrollEnabled={!drawing}>
      <Heading>{t('Forms')}</Heading>
      <Body muted>{t('Start, fill in, sign and submit your forms here.')}</Body>
      {noticeView}
      {error ? (
        <Card><Body muted>{t(error)}</Body><Button label={t('Try again')} variant="secondary" onPress={() => setReload((value) => value + 1)} /></Card>
      ) : templates === null || forms === null ? (
        <StateMessage title={t('Loading forms')} body={t('Getting your forms.')} />
      ) : (
        <>
          {cosigning ? (
            <LiveCosignRequests
              requests={cosigning.requests}
              templateFor={(request) => (request.grievance ? templateForForm(templates, request.grievance) : null)}
              ownerID={userID}
              drawingChange={setDrawing}
              onChanged={() => setReload((value) => value + 1)}
            />
          ) : null}
          <Heading level={2}>{t('Your forms')}</Heading>
          {forms.length === 0 ? <StateMessage compact title={t('No forms yet')} body={t('Forms you start appear here with their status.')} /> : forms.map((form) => {
            const template = templateForForm(templates, form);
            const unfinished = form.status === 'draft' || form.status === 'returned';
            const updatedAt = deviceDateTime(form.updatedAt, locale);
            return (
              <Card key={form.id}>
                <View style={styles.row}>
                  <Heading level={3}>{labelFor(form)}</Heading>
                  <StatusChip label={nativeCatalogLabel(language, formStatusLabel(form.status))} />
                </View>
                {updatedAt ? <Body muted>{t('Updated {when}', { when: updatedAt })}</Body> : null}
                {form.status === 'returned' && form.reviewNote ? <Body>{t('Committee note: {note}', { note: form.reviewNote })}</Body> : null}
                {formIsEditable(form) && template ? (
                  <Button label={t('Continue')} accessibilityLabel={t('Continue {form}', { form: labelFor(form) })} variant="secondary" onPress={() => { void openForm(template, form); }} />
                ) : null}
                {form.status === 'approved' ? (
                  <Button
                    label={filing === form.id ? t('Preparing filing copy…') : t('Download filing copy')}
                    accessibilityLabel={t('Download the filing copy of {form}', { form: labelFor(form) })}
                    variant="secondary"
                    disabled={filing !== null}
                    onPress={() => { void shareFiling(form); }}
                  />
                ) : null}
                {unfinished ? <FormHealthNotice templateKey={form.templateKey} language={language} /> : null}
              </Card>
            );
          })}
          <Heading level={2}>{t('Start a form')}</Heading>
          <NativeUnitChoice workflow={unitWorkflow} disabled={starting !== null} />
          {unitContext && !unitChosen ? <Body muted>{t('Choose the unit for this work to see its forms.')}</Body> : startable.length === 0 ? <StateMessage compact title={t('No forms to start')} body={t('Your organization has no forms open right now.')} /> : startable.map((template) => {
            const draft = forms.find((form) => form.templateKey === template.key && formIsEditable(form));
            const blurb = formTemplateBlurb(template, runsDues, language);
            return (
              <Card key={`${template.key}-${template.version}`}>
                <Heading level={3}>{template.label}</Heading>
                {blurb ? <Body muted>{blurb}</Body> : null}
                <FormHealthNotice templateKey={template.key} language={language} />
                <Button
                  label={draft ? t('Continue your draft') : starting === template.key ? t('Opening…') : t('Start')}
                  accessibilityLabel={draft ? t('Continue your draft of {form}', { form: template.label }) : t('Start {form}', { form: template.label })}
                  disabled={starting !== null}
                  variant="secondary"
                  onPress={() => { if (draft) void openForm(templateForForm(templates, draft) ?? template, draft); else void startForm(template); }}
                />
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: minimumTouchTarget, borderRadius: radii.pill, paddingHorizontal: spacing.md, justifyContent: 'center' },
  chipText: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between' },
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  status: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  statusText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
  field: { gap: spacing.sm },
  switchLabel: { flex: 1 },
  checkRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkBox: { width: 24, height: 24, borderWidth: 2, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 15, lineHeight: 18, ...typeface.controlStrong },
  healthNotice: { borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  healthHint: { ...typeface.controlStrong },
});
