import { useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '../components/Text';

import { Body, Button, Card, StateMessage } from '../components/ui';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { isAuthoritativeReadRefusal, isReadRefusal } from '../lib/readRefusal';
import { readResumeDraft, resumeDraftIsCurrent, resumeDraftReadsConfirmed, useResumeDraftKey, retireResumeDraft, retireNoticeResumeDrafts, settleResumeDraft, useResumeDraft, writeResumeDraft } from '../lib/resumeDraftHolder';
import type { NoticeResumeDraft, ResumeDraftEntry } from '../lib/resumeDraftHolder';
import { useApp } from '../state/AppProvider';
import { beginNoticeSend, forgetNoticeSend, noticeSendIsCurrent, updateNoticeSend, useNoticeSendRetirement, usePendingNoticeSend, type NoticeAttempt } from './noticePendingSend';
import { haptics } from '../services/haptics';
import { loadStewardNoticeAudiences, newNoticeOperationKey, sendChapterBroadcast, type NoticeAudience, type NoticeLocale } from '../services/stewardDeskSections';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { LIVE_STAFF_ROLE_LABELS } from '../lib/hatFunctions';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

export type NoticeScope = { key: string; chapterID: string; role: string | null };

// The notice composer, moved out of the Steward desk's Broadcasts section so
// the Chapter notices screen (#9099, part 2 of 4) sends the same way: the
// audiences the worn role is granted (src/lib/noticeAudience.js, shared with
// the website), a title, a message and the notice's language (#9117),
// published through publish_member_broadcast or publish_chapter_office_notice.
// `onSent` lets the screen reload its list of sent notices (also the
// "Check the notices you sent" choice, which keeps the draft).
//
// A send whose answer never arrived may still have been published, and no
// notice in the sent list counts as proof (R-9219 R1: the same text sent to
// another unit, or sent earlier, would clear an unsent draft). The draft is
// then kept, locked and marked unconfirmed, with three choices: check the
// notices you sent, send again, or cancel. It is cleared only by a send that
// succeeds or by Cancel. Each draft carries one operation key from its first
// try (#9220), so "Send again" is the same operation: once the publishers
// take keys (20261119180000), the server answers it with the notice the lost
// try published instead of posting a second one.

// The send failures the service names, shown in the member's language
// (ledger 207); any other failure reads as not sent.
const BROADCAST_FAILURES: readonly NativeUiKey[] = [
  'Your notice audience is unavailable. Reload audiences before sending.',
  'A broadcast needs a title and a message.',
  'The broadcast was not sent. Try again.',
];
function broadcastFailure(error: unknown): NativeUiKey {
  if (error instanceof Error && 'code' in error && error.code === 'notice_audience_unavailable') {
    return 'Your notice audience is unavailable. Reload audiences before sending.';
  }
  const message = error instanceof Error ? error.message : '';
  return BROADCAST_FAILURES.find((key) => key === message) ?? 'The broadcast was not sent. Try again.';
}

/** A refusal proves only THIS try did not publish, never an earlier unknown try. */
function sendWasUncertain(error: unknown): boolean {
  if (isReadRefusal(error)) return false;
  if (!(error instanceof Error)) return true;
  if ('code' in error && error.code === 'notice_audience_unavailable') return false;
  if (error.message === 'A broadcast needs a title and a message.') return false;
  return !('serverAnswered' in error && error.serverAnswered === true);
}

// What an unconfirmed draft says. A keyed try (#9220) cannot post twice: the
// server answers Send again with the notice the lost try published. Only a try
// that went without the key, while the database had no keyed publisher yet,
// may still post twice, so only that one says so, and a draft that had such a
// try keeps saying so until it is sent or cancelled: a later keyed try cannot
// take back the copy the unkeyed one may have posted (ledger 553, final stage
// 375 of #9225).
const UNCONFIRMED: NativeUiKey = 'We could not confirm this notice was sent. Check the notices you sent first. Sending it again will not post it twice.';
const UNCONFIRMED_MAY_REPEAT: NativeUiKey = 'We could not confirm this notice was sent. Check the notices you sent first: sending it again may post it twice.';
function unconfirmedLine(error: unknown, earlier?: NativeUiKey): NativeUiKey {
  if (earlier === UNCONFIRMED_MAY_REPEAT) return UNCONFIRMED_MAY_REPEAT;
  return error instanceof Error && 'withoutKey' in error && error.withoutKey === true ? UNCONFIRMED_MAY_REPEAT : UNCONFIRMED;
}

// Each language is named in itself, as on the website's notice desk.
const NOTICE_LANGUAGES: readonly (readonly [NoticeLocale, string])[] = [['en', 'English'], ['es', 'Español']];

type PendingSend = NoticeAttempt;
const NOTICE_SENT_STALE: NativeUiKey = 'Notice sent. Refresh to see it in the list.';

type ComposerProps = { scope: NoticeScope; onSent: () => void; resumeItemID?: string };
export function NoticeComposer(props: ComposerProps) {
  const { session } = useApp();
  const retirement = useNoticeSendRetirement(session?.user.id ? `${session.user.id}|${props.scope.chapterID}` : '');
  return <NoticeComposerSession key={`${session?.user.id ?? ''}|${retirement}|${props.scope.key}|${props.resumeItemID ?? 'steward-broadcasts'}`} {...props} />;
}

function NoticeComposerSession({ scope, onSent, resumeItemID = 'steward-broadcasts' }: ComposerProps) {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { t, language, catalogLabel } = useNativeUi();
  const app = useApp();
  const userID = app.session?.user.id ?? '';
  // Unsent drafts follow the full resume scope. Attempted sends instead keep
  // their identity for the same person/chapter even through a hat change.
  const sendOwner = userID ? `${userID}|${scope.chapterID}` : '';
  const heldSend = usePendingNoticeSend(sendOwner);
  const scopeConfirmed = resumeDraftReadsConfirmed(app) && !app.refreshing;
  const resumeKey = useResumeDraftKey(app, 'notice', resumeItemID);
  const owner = resumeKey?.id ?? scope.key;
  const localOwner = useRef(owner);
  const sameOwner = localOwner.current === owner;
  const [discarding, setDiscarding] = useBusinessState(false);
  const [showHeldBody, setShowHeldBody] = useBusinessState(false);
  const [alreadyPosted, setAlreadyPosted] = useBusinessState(false);
  const [localTitle, setTitle] = useBusinessState('');
  const [localBody, setBody] = useBusinessState('');
  // The notice's language starts at the account's language, as on the
  // website's notice desk, and is stored with the notice (#9117).
  const [localLocale, setNoticeLocale] = useBusinessState<NoticeLocale>(language);
  const [localError, setActionError] = useBusinessState<NativeUiKey | null>(null);
  const [checkError, setCheckError] = useBusinessState<NativeUiKey | null>(null);
  // The send that may have been published; while set, the draft is locked.
  const [localPending, setPending] = useBusinessState<PendingSend | null>(null);
  // A second Send before React commits busy is refused here.
  const sending = useRef(false);
  const [audienceReload, setAudienceReload] = useBusinessState(0);
  const [audienceState, setAudienceState] = useBusinessState<{ status: 'loading' | 'ready' | 'failed'; options: NoticeAudience[] }>({ status: 'loading', options: [] });
  const [localAudienceValue, setAudienceValue] = useBusinessState('');
  const [audienceOwner, setAudienceOwner] = useBusinessState<string | null>(null);
  const audienceGeneration = useRef(0);
  const audienceStatus = scopeConfirmed && audienceOwner === owner ? audienceState.status : 'loading';
  const audienceOptions = scopeConfirmed && audienceOwner === owner ? audienceState.options : [];
  const defaultAudience = audienceOwner === owner ? audienceState.options[0]?.value ?? '' : '';
  const freshAudience = audienceStatus === 'ready';
  const stored = useResumeDraft(resumeKey, true);
  const written = useRef<ResumeDraftEntry<'notice'> | null>(null);
  const saved = freshAudience ? stored : null;
  const retained = saved && audienceOptions.some((option) => option.value === saved.value.audienceValue) ? saved : null;
  // Fresh reads reveal this login's own held work. The current audience
  // projection controls resend versus the other-hat card, never lifetime.
  const changedOrganization = scopeConfirmed && Boolean(heldSend?.organizationID && app.organizationID && heldSend.organizationID !== app.organizationID);
  const visibleSend = freshAudience && !changedOrganization && heldSend && audienceOptions.some(option => option.value === heldSend.audience.value) ? heldSend : null;
  const title = visibleSend?.title ?? retained?.value.title ?? (scopeConfirmed && sameOwner ? localTitle : '');
  const body = visibleSend?.body ?? retained?.value.body ?? (scopeConfirmed && sameOwner ? localBody : '');
  const noticeLocale = visibleSend?.locale ?? retained?.value.locale ?? (scopeConfirmed && sameOwner ? localLocale : language);
  const pending = visibleSend?.attempt ?? retained?.value.attempt ?? (scopeConfirmed && sameOwner ? localPending : null);
  const actionError = visibleSend?.error ?? retained?.value.warning ?? (scopeConfirmed && sameOwner ? localError : null);
  // Busy is the held send's ticket alone (gate r1s1/r2s1 of #9361): no local
  // copy can outlive a request that answered while this composer was concealed
  // or its audience generation moved, so Discard is disabled only while a
  // request is in flight. Every send claims the holder before it starts.
  const busy = heldSend ? heldSend.busy : retained?.pending === true;
  const audienceValue = heldSend?.audience.value ?? retained?.value.audienceValue ?? (scopeConfirmed && sameOwner ? localAudienceValue : '');
  const latestWork = useRef<NoticeResumeDraft>({ title, body, locale: noticeLocale, audienceValue, attempt: pending, warning: actionError });
  latestWork.current = { title, body, locale: noticeLocale, audienceValue, attempt: pending, warning: actionError };
  const locked = (!changedOrganization && heldSend !== null) || pending !== null;
  // New text can still be typed while the initial audience loads, as on
  // Main. A remounted owner cannot overwrite a held draft before its read.
  const frozen = !scopeConfirmed || busy || locked || (!freshAudience && stored !== null && (!sameOwner || stored !== written.current));
  useEffect(() => {
    localOwner.current = owner;
    written.current = null;
    sending.current = false;
    setTitle(''); setBody(''); setActionError(null); setPending(null);
  }, [scope.key, owner]);
  useEffect(() => {
    if (scopeConfirmed) return;
    // The holder owns the concealed work. A local copy must not reappear if
    // a refusal retires that entry while this normal Main tree stays mounted.
    written.current = null;
    setTitle(''); setBody(''); setPending(null); setActionError(null);
    setNoticeLocale(language); setAudienceValue(defaultAudience);
  }, [scopeConfirmed, language, defaultAudience]);
  useEffect(() => { setNoticeLocale(language); }, [scope.key, language]);
  useEffect(() => {
    if (!scopeConfirmed) return;
    const generation = ++audienceGeneration.current;
    setAudienceOwner(null);
    setActionError(null); setAudienceValue('');
    setAudienceState({ status: 'loading', options: [] });
    void loadStewardNoticeAudiences(scope.chapterID, scope.role).then((options) => {
      if (audienceGeneration.current !== generation) return;
      let entry = readResumeDraft(resumeKey);
      const firstAudience = options[0];
      if (entry && !entry.value.audienceValue && !entry.pending && firstAudience) {
        const previous = entry;
        entry = writeResumeDraft(resumeKey, { ...entry.value, audienceValue: firstAudience.value });
        if (written.current === previous) written.current = entry;
      }
      if (entry && !options.some((option) => option.value === entry.value.audienceValue)) {
        retireResumeDraft(resumeKey); setTitle(''); setBody(''); setPending(null);
        sending.current = false;
      }
      setAudienceState({ status: 'ready', options });
      setAudienceOwner(owner);
      setAudienceValue(options[0]?.value ?? '');
    }).catch((error: unknown) => {
      if (audienceGeneration.current !== generation) return;
      if (isAuthoritativeReadRefusal(error) || (error instanceof Error && 'accessMissing' in error && error.accessMissing === true)) {
        retireResumeDraft(resumeKey); setTitle(''); setBody(''); setPending(null);
        sending.current = false;
      }
      setAudienceState({ status: 'failed', options: [] });
      setAudienceOwner(owner);
    });
    return () => { audienceGeneration.current += 1; };
  }, [scope.key, scope.chapterID, scope.role, audienceReload, resumeKey, owner, sendOwner, scopeConfirmed]);
  const audience = audienceOptions.find((option) => option.value === audienceValue);
  const audienceLabel = (option: NoticeAudience) => option.kind === 'chapter' ? t('My campaign') : option.kind === 'organization' ? t('My organization')
    : option.kind === 'unit' ? t('Unit: {name}', { name: option.name }) : t('Committee: {name}', { name: option.name });

  function change(patch: Partial<NoticeResumeDraft>) {
    if (frozen) return;
    setAlreadyPosted(false);
    // Several input/autofill events can arrive in one React batch. Each patch
    // builds on the last event, including before React commits the new fields.
    const next: NoticeResumeDraft = { ...latestWork.current, attempt: null, warning: null, ...patch };
    latestWork.current = next;
    setActionError(null);
    setTitle(next.title); setBody(next.body); setNoticeLocale(next.locale); setAudienceValue(next.audienceValue);
    if (next.title || next.body) written.current = writeResumeDraft(resumeKey, next);
    else { retireResumeDraft(resumeKey); written.current = null; }
  }

  function dismissFailure() {
    setActionError(null);
    const current = readResumeDraft(resumeKey);
    if (current && !current.pending && current.value.attempt === null) {
      written.current = writeResumeDraft(resumeKey, { ...current.value, warning: null });
    }
  }

  const sent = useCallback(() => {
    void haptics.success();
    onSent();
  }, [onSent]);

  useEffect(() => {
    if (!heldSend) { setPending(null); return; }
    if (!scopeConfirmed || !freshAudience || changedOrganization) return;
    if (heldSend.confirmed) {
      // Acknowledgement is retained across remounts, but shared reads and
      // consuming its exact retry identity require available account proof.
      if (heldSend.attempt?.warning === NOTICE_SENT_STALE) return;
      retireNoticeResumeDrafts(userID, scope.chapterID);
      setAlreadyPosted(heldSend.alreadyPosted);
      const consumed = forgetNoticeSend(sendOwner, heldSend.ticket);
      // Clear every observer's local fields, but notify only the ticket's
      // consuming instance. The async publisher already settled its resume ticket.
      setTitle(''); setBody(''); setNoticeLocale(language); setPending(null); setActionError(null);
      if (consumed) sent();
      return;
    }
    if (!visibleSend) return;
    setTitle(visibleSend.title); setBody(visibleSend.body); setNoticeLocale(visibleSend.locale);
    setAudienceValue(visibleSend.audience.value); setPending(visibleSend.attempt); setActionError(visibleSend.error);
    if (!visibleSend.busy && visibleSend.attempt === null) forgetNoticeSend(sendOwner, visibleSend.ticket);
  }, [heldSend, visibleSend, sendOwner, scopeConfirmed, freshAudience, changedOrganization, language, sent, userID, scope.chapterID]);

  async function checkSent() {
    const generation = audienceGeneration.current;
    const proof = await checkBusinessContinuation(writer, () => audienceGeneration.current === generation
      && (!heldSend || noticeSendIsCurrent(heldSend)));
    if (proof === 'changed') return;
    if (proof === 'unavailable') { setCheckError('The notices could not be checked. Try again when your connection is available.'); return; }
    setCheckError(null);
    if (heldSend?.confirmed && heldSend.attempt?.warning === NOTICE_SENT_STALE) {
      retireNoticeResumeDrafts(userID, scope.chapterID);
      if (!forgetNoticeSend(sendOwner, heldSend.ticket)) return;
      setTitle(''); setBody(''); setPending(null); setActionError(null);
    }
    onSent();
  }

  function cancel() {
    if (busy) return;
    setCheckError(null);
    if (heldSend && !forgetNoticeSend(sendOwner, heldSend.ticket, true)) return;
    audienceGeneration.current += 1;
    retireNoticeResumeDrafts(userID, scope.chapterID);
    retireResumeDraft(resumeKey);
    written.current = null;
    setTitle(''); setBody(''); setNoticeLocale(language); setPending(null); setActionError(null);
  }

  async function send() {
    if (heldSend?.confirmed || pending?.warning === NOTICE_SENT_STALE) return;
    setCheckError(null);
    if (!scopeConfirmed || sending.current || busy || !audience || !freshAudience) return;
    const generation = audienceGeneration.current;
    // Retry belongs to the first login too; a newly captured guard must never
    // authorize a previous login's operation. Capture before the UUID await.
    const login = heldSend?.login ?? { userID, isCurrent: app.captureAccountSessionGuard(userID || null) };
    const stillOwner = login.isCurrent;
    let attempt: PendingSend | null = pending;
    const work: NoticeResumeDraft = { title, body, locale: noticeLocale, audienceValue, attempt: pending, warning: null };
    const sendLifetime = beginNoticeSend(sendOwner, { title, body, locale: noticeLocale, postingRole: heldSend?.postingRole ?? scope.role, organizationID: app.organizationID }, audience, attempt, login);
    if (!sendLifetime) return;
    // Whether an EARLIER dispatched try left an unknown outcome, and whether
    // this try reached the publisher: possession of a key proves neither.
    const earlierUnknown = sendLifetime.outcomeUnknown;
    let dispatched = false;
    const ticket = writeResumeDraft(resumeKey, work, true);
    if (!heldSend && resumeKey && !ticket) { forgetNoticeSend(sendOwner, sendLifetime.ticket); return; }
    sending.current = true;
    setActionError(null);
    try {
      attempt ??= { title, body, locale: noticeLocale, operationKey: await newNoticeOperationKey() };
      if (!stillOwner() || (!heldSend && ticket && !resumeDraftIsCurrent(ticket, true))) {
        const warning: NativeUiKey = 'The broadcast was not sent. Try again.';
        if (ticket && stillOwner()) settleResumeDraft(ticket, { ...work, attempt, warning });
        updateNoticeSend(sendLifetime, { attempt, busy: false, error: warning });
        return;
      }
      if (!noticeSendIsCurrent(sendLifetime)) return;
      dispatched = true;
      updateNoticeSend(sendLifetime, { attempt, outcomeUnknown: true });
      const outcome = await sendChapterBroadcast(writer, attempt.title, attempt.body, sendLifetime.audience, attempt.locale, attempt.operationKey);
      if (!noticeSendIsCurrent(sendLifetime)) return;
      // Both holders settle before any stale-screen return. A retired resume
      // scope must not throw away an attempted send's acknowledgement or key.
      const acceptedAttempt = { ...attempt, warning: NOTICE_SENT_STALE };
      await settleBusinessWrite(writer, {
        current: () => noticeSendIsCurrent(sendLifetime),
        accepted: (proof) => {
          if (ticket) settleResumeDraft(ticket, proof === 'current' ? null : { ...work, attempt: acceptedAttempt, warning: NOTICE_SENT_STALE });
          updateNoticeSend(sendLifetime, { confirmed: true, alreadyPosted: outcome === 'already-posted', busy: true,
            attempt: proof === 'current' ? attempt : acceptedAttempt, error: proof === 'current' ? null : NOTICE_SENT_STALE });
        },
        stale: () => undefined,
      });
    } catch (nextError) {
      // A refusal proves only that THIS try did not publish. A never-dispatched
      // key whose first real try is refused stays known not sent (r1s2/r2s2).
      // Ledger 714: the writer's own refusal before sending, never a copied marker.
      const sessionRefused = nextError instanceof WriterSessionChanged && businessRpcProvenance(nextError) === null;
      const thisTryUnknown = dispatched && !sessionRefused && sendWasUncertain(nextError);
      const uncertain = attempt !== null && (earlierUnknown || thisTryUnknown);
      const warning = uncertain ? unconfirmedLine(nextError, attempt?.warning) : broadcastFailure(nextError);
      const failed: NoticeResumeDraft = { ...work, attempt: uncertain ? { ...attempt!, warning } : null, warning };
      if (ticket && stillOwner()) settleResumeDraft(ticket, failed);
      if (!uncertain) forgetNoticeSend(sendOwner, sendLifetime.ticket);
      else updateNoticeSend(sendLifetime, { attempt: failed.attempt, outcomeUnknown: true, error: warning, busy: false, retryError: earlierUnknown && !thisTryUnknown ? broadcastFailure(nextError) : null });
      if (!stillOwner()) return;
      if (audienceGeneration.current !== generation) return;
      setActionError(warning);
      if (!uncertain) setPending(null);
      if (!uncertain && nextError instanceof Error && 'code' in nextError && nextError.code === 'notice_audience_unavailable') setAudienceState({ status: 'ready', options: [] });
    } finally {
      updateNoticeSend(sendLifetime, { busy: false });
      sending.current = false;
    }
  }

  const role = heldSend?.postingRole;
  const postingHat = role === 'admin' || role === 'vp' || role === 'steward'
    ? catalogLabel(LIVE_STAFF_ROLE_LABELS[role]) : t('Your previous role');
  const heldAudience = heldSend ? audienceLabel(heldSend.audience) : '';
  // A retired resume ticket can prevent dispatch during the key await. Its
  // retained key is safe to retry, but no earlier publish needs confirmation:
  // the held send's own fact decides, never its error text (r1s2/r2s2).
  const neverSent = heldSend !== null && !heldSend.busy && !heldSend.outcomeUnknown;
  const heldSummary = heldSend?.confirmed ? t(NOTICE_SENT_STALE) : neverSent ? t('The broadcast was not sent. Try again.')
    : t('We could not confirm this notice was sent. You sent it as {hat} to {audience}. Check the notices you sent first.', { hat: postingHat, audience: heldAudience });
  const discardConfirmation = discarding ? <Card>
    <Body>{t('Discard this notice? If it was already posted, it stays posted.')}</Body>
    <Button label={t('Keep notice')} variant="secondary" onPress={() => setDiscarding(false)} />
    <Button label={t('Discard notice')} disabled={busy} onPress={cancel} />
  </Card> : null;
  if (heldSend && (!scopeConfirmed || !freshAudience || changedOrganization)) return <>
    <StateMessage title={t('Checking your notice audience…')} body={audienceState.status === 'failed' ? t('Your notice audience could not be checked.') : t('Getting the audiences this role can reach.')} />
    {scopeConfirmed ? <Button label={t('Reload audiences')} onPress={() => setAudienceReload(value => value + 1)} /> : null}
    <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => setDiscarding(true)} />
    {discardConfirmation}
  </>;
  if (heldSend && !visibleSend) return <Card>
    {!heldSend.confirmed ? <Body>{neverSent ? t('The broadcast was not sent. Try again.') : t('Unconfirmed notice')}</Body> : null}
    <Body>{heldSend.title}</Body>
    <Body>{heldSummary}</Body>
    {showHeldBody ? <Body>{heldSend.body}</Body> : null}
    <Button label={showHeldBody ? t('Hide notice message') : t('Show notice message')} variant="secondary" onPress={() => setShowHeldBody(value => !value)} />
    {(role === 'admin' || role === 'vp' || role === 'steward') && app.staffRoleChoices?.includes(role)
      ? <Button label={t('Switch to {hat}', { hat: postingHat })} onPress={() => app.chooseStaffRole(role)} />
      : <Body>{t("You can't send to {audience} with your current roles. Ask your campaign lead if this is wrong.", { audience: heldAudience })}</Body>}
    <Button label={t('Check the notices you sent')} variant="secondary" onPress={() => { void checkSent(); }} />
    {checkError ? <Body accessibilityRole="alert">{t(checkError)}</Body> : null}
    <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => setDiscarding(true)} />
    {discardConfirmation}
  </Card>;
  return (
    <>
      {alreadyPosted ? <Body>{t('This notice was already posted.')}</Body> : null}
      <Body muted>{t('Send a notice to your granted audience. Workers there see it in Announcements.')}</Body>
      {audienceStatus === 'loading' ? <StateMessage title={t('Checking notice audience')} body={t('Getting the audiences this role can reach.')} /> : null}
      {audienceStatus === 'failed' ? <Body muted>{t('Your notice audience could not be checked.')}</Body> : null}
      {audienceStatus === 'ready' && audienceOptions.length === 0 ? <Body muted>{t('No notice audience is available for this role. Ask your campaign lead to check your unit assignment.')}</Body> : null}
      {audienceOptions.length === 1 && audience ? <Body>{audienceLabel(audience)}</Body> : null}
      {audienceOptions.length > 1 ? <View style={styles.actions} accessibilityRole="radiogroup">{audienceOptions.map((option) => (
        <Button key={option.value} label={audienceLabel(option)} selected={option.value === audienceValue} variant={option.value === audienceValue ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ audienceValue: option.value })} />
      ))}</View> : null}
      {audienceStatus !== 'loading' && audienceOptions.length === 0 ? <Button label={t('Reload audiences')} variant="secondary" disabled={busy} onPress={() => setAudienceReload((value) => value + 1)} /> : null}
      <Body>{t('Title')}</Body>
      <TextInput
        accessibilityLabel={t('Broadcast title')}
        value={title}
        onChangeText={(value) => change({ title: value })}
        placeholder={t('Title')}
        placeholderTextColor={theme.quietForeground}
        keyboardAppearance={theme.appearance}
        maxLength={160}
        editable={!frozen}
        style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
      />
      <Body>{t('Message')}</Body>
      <TextInput
        accessibilityLabel={t('Broadcast message')}
        value={body}
        onChangeText={(value) => change({ body: value })}
        placeholder={t('Message')}
        placeholderTextColor={theme.quietForeground}
        keyboardAppearance={theme.appearance}
        multiline
        maxLength={4000}
        editable={!frozen}
        style={[styles.input, styles.message, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
      />
      <Body>{t('Notice language')}</Body>
      <View style={styles.actions} accessibilityRole="radiogroup" accessibilityLabel={t('Notice language')}>
        {NOTICE_LANGUAGES.map(([value, label]) => (
          <Button key={value} label={label} selected={noticeLocale === value} variant={noticeLocale === value ? 'primary' : 'secondary'} disabled={frozen} onPress={() => change({ locale: value })} />
        ))}
      </View>
      {locked ? <>
        {heldSend ? <Body>{busy ? t('Sending…') : heldSummary}</Body> : null}
        {heldSend?.retryError ? <Body accessibilityRole="alert">{t('Not sent now: {reason}', { reason: t(heldSend.retryError) })}</Body> : null}
        {!busy && !heldSend?.confirmed ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t(actionError ?? pending?.warning ?? UNCONFIRMED)}</Body> : null}
        {scopeConfirmed && sameOwner && checkError ? <Body accessibilityRole="alert">{t(checkError)}</Body> : null}
        <View style={styles.actions}>
          <Button label={t('Check the notices you sent')} variant="secondary" onPress={() => { void checkSent(); }} />
          {!heldSend?.confirmed ? <Button label={t('Send again')} busy={busy} disabled={!scopeConfirmed || busy || audienceState.status !== 'ready' || !audience} onPress={() => { void send(); }} /> : null}
          {!heldSend?.confirmed ? <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => setDiscarding(true)} /> : null}
        </View>
        {discardConfirmation}
      </> : <>
        <Button label={audience?.kind === 'unit' ? t('Send unit notice') : audience?.kind === 'committee' ? t('Send committee notice') : t('Send notice')} busy={busy} disabled={!scopeConfirmed || busy || audienceState.status !== 'ready' || !audience || title.trim() === '' || body.trim() === ''}
          disabledReason={scopeConfirmed && audienceState.status === 'ready' && audience ? t('A broadcast needs a title and a message.') : undefined} onPress={() => { void send(); }} />
        {actionError ? <Failure message={t(actionError)} onRetry={dismissFailure} /> : null}
      </>}
    </>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  return (
    <Card>
      <Body style={{ color: theme.destructive }}>{message}</Body>
      <Button label={t('Try again')} variant="secondary" onPress={onRetry} />
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  message: { minHeight: 120, textAlignVertical: 'top' },
});
