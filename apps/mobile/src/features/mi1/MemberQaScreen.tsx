import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';

import { StatusPill } from '../../components/StatusPill';
import { ContextualPulseCard, useNativeContextualPulse } from '../ContextualPulseCard';
import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../../components/ui';
import {
  canAcceptQaAnswer,
  canOfficialReplyOnQa,
  canSeeOfficerQaQueue,
  createQaRpcAdapter,
  QA_MAX_BODY_LENGTH,
  QA_MAX_SEARCH_LENGTH,
  QA_MAX_TITLE_LENGTH,
  QA_MIN_BODY_LENGTH,
  QA_MIN_TITLE_LENGTH,
  qaCountKey,
  qaFailureText,
  qaLengthHint,
  qaLengthMet,
  qaStatusLabel,
  qaText,
  requireActiveQaMember,
  toQaActor,
  memberQaPreviewState,
  type NativeQaActor,
} from '../../lib/mi1QaShared';
import { haptics } from '../../services/haptics';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import { getSupabaseClient } from '../../services/supabase';
import { bindBusinessApi } from '../../services/businessWriters';
import { useBusinessRequests, useBusinessWriter, useBusinessState, useBusinessSubjectState, useBusinessRequestOwner } from '../../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../../lib/businessWriteContinuation';
import { useTheme } from '../../theme/ThemeProvider';
import { mi1Styles as styles } from './mi1Styles';
import { nativeUiText } from '../../lib/nativeUiCopy';

type QaReply = {
  id: string;
  kind: 'official' | 'follow_up';
  body: string;
  accepted: boolean;
  upvoteCount: number;
  votedByMe: boolean;
  authorDisplayName: string;
};

type QaQuestion = {
  id: string;
  organizationId: string;
  chapterId: string;
  title: string;
  body: string;
  status: 'open' | 'replied' | 'accepted';
  authoredByMe?: boolean;
  acceptedReplyId: string | null;
  upvoteCount: number;
  votedByMe: boolean;
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
  officialReplyCount: number;
  replies: QaReply[];
};

function rowsFrom(value: unknown): QaQuestion[] {
  return Array.isArray(value) ? value as QaQuestion[] : [];
}

type QaQueuePage = {
  questions: QaQuestion[];
  nextAfterCreatedAt: string | null;
  nextAfterId: string | null;
};

function queuePageFrom(value: unknown): QaQueuePage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { questions: [], nextAfterCreatedAt: null, nextAfterId: null };
  }
  const page = value as Record<string, unknown>;
  return {
    questions: rowsFrom(page.questions),
    nextAfterCreatedAt: typeof page.nextAfterCreatedAt === 'string' ? page.nextAfterCreatedAt : null,
    nextAfterId: typeof page.nextAfterId === 'string' ? page.nextAfterId : null,
  };
}

// #9460: say once, politely, when a typed field reaches its minimum; never per keystroke.
function useLengthMetAnnouncement(hint: string, value: string, message: string, announce: (message: string) => () => void) {
  const met = hint === '' && value.trim() !== '';
  const previous = useRef(met);
  useEffect(() => {
    const was = previous.current;
    previous.current = met;
    return met && !was ? announce(message) : undefined;
  }, [met, message, announce]);
}

export function MemberQaScreen({ actor, language = 'en', live = false }: { actor: NativeQaActor; language?: 'en' | 'es'; live?: boolean }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const confirmedOwner = useBusinessRequestOwner();
  const theme = useTheme();
  const qaActor = useMemo(() => toQaActor(actor), [actor]);
  const membership = requireActiveQaMember(qaActor);
  const officer = canSeeOfficerQaQueue(qaActor);
  const client = live ? getSupabaseClient() : null;
  const qa = useMemo(() => client ? bindBusinessApi(client, writer, createQaRpcAdapter, ['list_member_qa_questions', 'get_member_qa_question', 'search_member_qa_questions', 'list_member_qa_officer_queue']) : createQaRpcAdapter(null), [client, writer]);
  const [questions, setQuestions] = useBusinessDraftState<QaQuestion[]>([], confirmedOwner.workspace);
  const [acceptedWrite, setAcceptedWrite] = useBusinessSubjectState<{ value: unknown; operation: string | null } | null>(confirmedOwner.workspace, null);
  const [queue, setQueue] = useBusinessDraftState<QaQuestion[]>([], confirmedOwner.workspace);
  const [queueCursor, setQueueCursor] = useBusinessDraftState<{ afterCreatedAt: string; afterId: string } | null>(null, confirmedOwner.workspace);
  // #9941 (carved from #9465): the officer queue read failed, so its empty
  // sentence would be false; the card says the questions could not be loaded.
  const [queueFailed, setQueueFailed] = useBusinessDraftState(false, confirmedOwner.workspace);
  // The member list may have loaded; only the waiting questions failed.
  const queueUnavailable: string = nativeUiText(language)('The waiting questions could not be loaded.');
  const queueRetry: string = qaText(language, 'retry');
  const [selected, setSelected] = useBusinessDraftState<QaQuestion | null>(null, confirmedOwner.workspace);
  // REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001: a question's detail
  // is a quick-check reading screen (live sessions only).
  const pulse = useNativeContextualPulse('qa.detail', live && Boolean(selected?.id), selected?.id ?? '');
  const [title, setTitle] = useBusinessDraftState('', confirmedOwner.workspace);
  const [body, setBody] = useBusinessDraftState('', confirmedOwner.workspace);
  const [reply, setReply] = useBusinessDraftState('', confirmedOwner.workspace);
  // #9460: what each field still needs, under it and as its spoken hint.
  const titleHint = qaLengthHint(language, title, QA_MIN_TITLE_LENGTH);
  const bodyHint = qaLengthHint(language, body, QA_MIN_BODY_LENGTH);
  const replyHint = qaLengthHint(language, reply, QA_MIN_BODY_LENGTH);
  const [query, setQuery] = useBusinessDraftState('', confirmedOwner.workspace);
  const [loading, setLoading] = useBusinessDraftState(false, confirmedOwner.workspace);
  const [busy, setBusy] = useBusinessState(false);
  const [control] = useBusinessState(() => ({ current: false }));
  const [error, setError] = useBusinessDraftState<string | null>(null, confirmedOwner.workspace);
  const [notice, setNotice] = useBusinessDraftState<string | null>(null, confirmedOwner.workspace);
  const [noticeVersion, setNoticeVersion] = useBusinessDraftState(0, confirmedOwner.workspace);
  const [errorVersion, setErrorVersion] = useBusinessDraftState(0, confirmedOwner.workspace);
  const queueAnnouncement = useAccessibilityAnnouncementQueue(
    `member-qa:${actor.userId ?? ''}:${actor.organizationId ?? ''}:${actor.chapterId ?? ''}:${actor.selectedHat ?? ''}:${actor.mfaSatisfied}:${language}`,
  );
  const latestRead = useRef({ query, questionId: selected?.id ?? null });
  useLayoutEffect(() => { latestRead.current = { query, questionId: selected?.id ?? null }; }, [query, selected?.id]);
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [idempotencyKeys] = useBusinessState(() => ({ current: new Map<string, string>() }));

  function idempotencyKey(operation: string) {
    const key = `${actor.userId ?? ''}|${confirmedOwner.workspace ?? ''}|${operation}`;
    const retained = idempotencyKeys.current.get(key);
    if (retained) return retained;
    const created = Crypto.randomUUID();
    idempotencyKeys.current.set(key, created);
    return created;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequest.current += 1;
    };
  }, []);

  useLengthMetAnnouncement(titleHint, title, qaLengthMet(language), queueAnnouncement);
  useLengthMetAnnouncement(bodyHint, body, qaLengthMet(language), queueAnnouncement);
  useLengthMetAnnouncement(replyHint, reply, qaLengthMet(language), queueAnnouncement);

  useEffect(() => {
    if (notice) return queueAnnouncement(notice);
    return undefined;
  }, [notice, noticeVersion, queueAnnouncement]);

  // Failures are spoken with the same sentence the Notice renders. Every
  // failure bumps errorVersion, so a repeated identical failure is spoken
  // again instead of being skipped as an unchanged value.
  useEffect(() => {
    if (error) return queueAnnouncement(error);
    return undefined;
  }, [error, errorVersion, queueAnnouncement]);

  useEffect(() => {
    setReply('');
  }, [selected?.id, setReply]);

  const readCurrent = useCallback(async (current: () => boolean) => {
    const proof = await checkBusinessContinuation(writer, current);
    if (proof === 'unavailable' && current()) {
      setError(language === 'es' ? 'No se pudieron actualizar las preguntas. Inténtelo de nuevo.' : 'Questions could not be refreshed. Try again.');
      setErrorVersion((value) => value + 1);
    }
    return proof === 'current';
  }, [writer, language, setError, setErrorVersion]);

  const load = useCallback(async (nextQuery = '', questionId: string | null = null, preserveNotice = false) => {
    if (!live || !membership.ok || !client) return false;
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const request = ++loadRequest.current;
    const current = () => mounted.current && ticket.isCurrent() && request === loadRequest.current;
    if (!(await readCurrent(current)) || !current()) { if (current()) setLoading(false); return false; }
    if (!preserveNotice) setNotice(null);
    setLoading(true);
    setError(null);
    const [listResult, queueResult] = await Promise.all([
      qa.list({ query: nextQuery, status: 'all', sort: 'newest' }),
      officer ? qa.officerQueue() : Promise.resolve({ ok: true, value: [] }),
    ]);
    if (!current()) return false;
    if (!(await readCurrent(current)) || !current()) { if (current()) setLoading(false); return false; }
    if (!listResult.ok) {
      setQuestions([]);
      setQueue([]);
      setError(qaFailureText(language, listResult));
      setErrorVersion((value) => value + 1);
      setLoading(false);
      return false;
    }
    setQuestions(rowsFrom('value' in listResult ? listResult.value : []));
    setQueueFailed(!queueResult.ok);
    if (queueResult.ok) {
      const page = queuePageFrom('value' in queueResult ? queueResult.value : null);
      setQueue(page.questions);
      setQueueCursor(page.nextAfterCreatedAt && page.nextAfterId
        ? { afterCreatedAt: page.nextAfterCreatedAt, afterId: page.nextAfterId }
        : null);
    }
    if (questionId) {
      const detail = await qa.get(questionId);
      if (!current()) return false;
      if (!(await readCurrent(current)) || !current()) { if (current()) setLoading(false); return false; }
      if (detail.ok && 'value' in detail) setSelected(detail.value as QaQuestion);
      else {
        setSelected(null);
        setError(qaFailureText(language, detail));
        setErrorVersion((value) => value + 1);
        setLoading(false);
        return false;
      }
    }
    setLoading(false);
    return true;
  }, [client, language, live, membership.ok, officer, qa, setNotice, setLoading, setError, setQuestions, setQueue, setQueueFailed, setErrorVersion, setQueueCursor, setSelected, readCurrent, requests]);

  async function refreshAccepted() {
    if (control.current) return;
    control.current = true;
    try {
    if (await load(query, selected?.id ?? null, Boolean(acceptedWrite))) {
      if (acceptedWrite) {
        const operation = acceptedWrite.operation;
        if (operation) idempotencyKeys.current.delete(`${actor.userId ?? ''}|${confirmedOwner.workspace ?? ''}|${operation}`);
        if (operation === 'ask') { setTitle(''); setBody(''); }
        else if (operation?.startsWith('official-reply:') || operation?.startsWith('follow-up:')) setReply('');
        setAcceptedWrite(null);
      }
    }
    } finally { control.current = false; }
  }

  useEffect(() => {
    setQuestions([]);
    setQueue([]);
    setQueueCursor(null);
    setSelected(null);
    void load();
  }, [actor.chapterId, actor.organizationId, load, setQuestions, setQueue, setQueueCursor, setSelected]);

  async function loadMoreQueue() {
    if (control.current) return;
    control.current = true;
    try {
    if (!queueCursor || busy) return;
    const request = loadRequest.current;
    const ticket = requests.capture();
    const current = () => mounted.current && ticket.isCurrent() && request === loadRequest.current;
    if (!(await readCurrent(current)) || !current()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await qa.officerQueue(queueCursor);
      if (!current() || !(await readCurrent(current)) || !current()) return;
      if (!result.ok) {
        setError(qaFailureText(language, result));
        setErrorVersion((value) => value + 1);
        return;
      }
      const page = queuePageFrom('value' in result ? result.value : null);
      setQueue((current) => {
        const byId = new Map(current.map((question) => [question.id, question]));
        page.questions.forEach((question) => byId.set(question.id, question));
        return [...byId.values()]
          .filter((question) => question.status === 'open')
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
            || right.id.localeCompare(left.id));
      });
      setQueueCursor(page.nextAfterCreatedAt && page.nextAfterId
        ? { afterCreatedAt: page.nextAfterCreatedAt, afterId: page.nextAfterId }
        : null);
    } finally {
      if (mounted.current) setBusy(false);
    }

    } finally { control.current = false; setBusy(false); }
  }

  async function mutate(action: () => Promise<{ ok: boolean; value?: unknown; message?: string }>, success: string, operation: string | null = null) {
    const current = requests.capture().isCurrent;
    if (busy || acceptedWrite || control.current) return false;
    control.current = true;
    setBusy(true);
    setError(null);
    try {
      let result: Awaited<ReturnType<typeof action>>;
      try { result = await action(); }
      catch {
        if (current()) {
          setNotice(null); setError(qaText(language, 'writeUnconfirmed')); setErrorVersion((value) => value + 1);
        }
        return false;
      }
      if (!result.ok) {
        setNotice(null);
        setError(qaFailureText(language, result, null, 'writeUnconfirmed'));
        setErrorVersion((value) => value + 1);

        if (await writer.isCurrent() && current()) await haptics.warning();
        return false;
      }
      setAcceptedWrite({ value: result.value, operation }); setNotice(success); setNoticeVersion((value) => value + 1);
      if (operation === 'ask') { setTitle(''); setBody(''); }
      else if (operation?.includes('reply:') || operation?.startsWith('follow-up:')) setReply('');
      const proof = await settleBusinessWrite(writer, {
        current, accepted: () => {},
        stale: () => setNotice(language === 'es' ? 'El cambio se guardó. Vuelva a abrir esta pantalla para verlo.' : BUSINESS_SAVED_STALE),
        refresh: () => load(latestRead.current.query, latestRead.current.questionId ?? ((result.value as QaQuestion | undefined)?.id ?? null), true),
      });
      if (!current()) return proof;

      if (proof === 'current') { setAcceptedWrite(null); if (await checkBusinessContinuation(writer, current) === 'current') await haptics.success(); }
      return current() ? proof : 'changed';
    } finally { control.current = false; setBusy(false); }
  }

  async function postQuestion() {
    const current = requests.capture().isCurrent;
    const operation = 'ask';
    const posted = await mutate(
      () => qa.ask({ title, body, idempotencyKey: idempotencyKey(operation) }),
      qaText(language, 'posted'),
      operation,
    );
    if (posted === 'current' && current()) {
      idempotencyKeys.current.delete(`${actor.userId ?? ''}|${confirmedOwner.workspace ?? ''}|${operation}`);
      setTitle('');
      setBody('');
    }
  }

  async function postReply() {
    const current = requests.capture().isCurrent;
    if (!selected) return;
    const officialReply = canOfficialReplyOnQa(qaActor, selected);
    const operation = `${officialReply ? 'official-reply' : 'follow-up'}:${selected.id}`;
    const posted = await mutate(
      () => officialReply
        ? qa.officialReply({ questionId: selected.id, body: reply, idempotencyKey: idempotencyKey(operation) })
        : qa.followUp({ questionId: selected.id, body: reply, idempotencyKey: idempotencyKey(operation) }),
      qaText(language, 'replyPosted'),
      operation,
    );
    if (posted === 'current' && current()) {
      idempotencyKeys.current.delete(`${actor.userId ?? ''}|${confirmedOwner.workspace ?? ''}|${operation}`);
      setReply('');
    }
  }

  if (!live) {
    const preview = memberQaPreviewState(language);
    return (
      <Screen>
        <Heading>{qaText(language, 'title')}</Heading>
        <StateMessage title={preview.title} body={preview.body} />
      </Screen>
    );
  }

  if (!membership.ok) {
    return (
      <Screen>
        <Heading>{qaText(language, 'title')}</Heading>
        <StateMessage title={qaText(language, 'forbidden')} body={'message' in membership ? membership.message : qaText(language, 'unavailable')} />
      </Screen>
    );
  }

  if (!client) {
    return (
      <Screen>
        <Heading>{qaText(language, 'title')}</Heading>
        <StateMessage title={qaText(language, 'unavailable')} body="Questions are not available right now." />
      </Screen>
    );
  }

  if (selected) {
    const officialReply = canOfficialReplyOnQa(qaActor, selected);
    return (
      <Screen refreshing={loading} onRefresh={() => { void refreshAccepted(); }} onScrollProgress={pulse.onScrollProgress}>
        <Button label={qaText(language, 'back')} variant="secondary" onPress={() => { setNotice(null); setSelected(null); }} />
        <ContextualPulseCard pulse={pulse} />
        <Heading>{selected.title}</Heading>
        <Body muted>{selected.authorDisplayName}</Body>
        <StatusPill label={qaStatusLabel(language, selected.status)} />
        <Body>{selected.body}</Body>
        <View style={styles.wrap}>
          <Button
            label={`${selected.votedByMe ? qaText(language, 'upvoted') : qaText(language, 'upvote')} · ${selected.upvoteCount}`}
            variant="secondary"
            busy={busy}
            onPress={() => { void mutate(() => qa.toggleVote({ targetKind: 'question', targetId: selected.id, voted: !selected.votedByMe }), qaText(language, 'upvote')); }}
          />
        </View>
        {selected.replies.map((item) => (
          <Card key={item.id}>
            <View style={styles.row}>
              <Heading level={3}>{item.kind === 'official' ? qaText(language, 'official') : qaText(language, 'followUp')}</Heading>
              {item.accepted ? <StatusPill label={qaText(language, 'accepted')} /> : null}
            </View>
            <Body>{item.body}</Body>
            <Body muted>{item.authorDisplayName}</Body>
            <View style={styles.wrap}>
              <Button
                label={`${item.votedByMe ? qaText(language, 'upvoted') : qaText(language, 'upvote')} · ${item.upvoteCount}`}
                variant="secondary"
                busy={busy}
                onPress={() => { void mutate(() => qa.toggleVote({ targetKind: 'reply', targetId: item.id, voted: !item.votedByMe }), qaText(language, 'upvote')); }}
              />
              {item.kind === 'official' && canAcceptQaAnswer(qaActor, selected) ? (
                <Button
                  label={item.accepted ? qaText(language, 'unaccept') : qaText(language, 'accept')}
                  busy={busy}
                  onPress={() => { void mutate(() => qa.accept({ questionId: selected.id, replyId: item.id, accepted: !item.accepted, expectedUpdatedAt: selected.updatedAt }), item.accepted ? qaText(language, 'unaccept') : qaText(language, 'accepted')); }}
                />
              ) : null}
            </View>
          </Card>
        ))}
        {officialReply || selected.authoredByMe ? <Card>
          <Heading level={3}>{officialReply ? qaText(language, 'replyOfficial') : qaText(language, 'replyFollowUp')}</Heading>
          {!officialReply ? <Body muted>{qaText(language, 'memberCannotOfficial')}</Body> : null}
          <TextInput
            accessibilityLabel={officialReply ? qaText(language, 'replyOfficial') : qaText(language, 'replyFollowUp')}
            multiline
            maxLength={QA_MAX_BODY_LENGTH}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={reply}
            editable={!acceptedWrite}
            onChangeText={setReply}
            accessibilityHint={replyHint || undefined}
            placeholder={officialReply ? qaText(language, 'replyPlaceholder') : qaText(language, 'followUpPlaceholder')}
            placeholderTextColor={theme.quietForeground}
            style={[styles.input, styles.multiline, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          {replyHint ? <Body muted>{replyHint}</Body> : null}
          <Button label={qaText(language, 'sendReply')} busy={busy} disabled={Boolean(acceptedWrite) || Boolean(replyHint)} onPress={() => { void postReply(); }} />
        </Card> : null}
        {notice ? <View key={noticeVersion} accessibilityLiveRegion="polite"><Body style={{ color: theme.primary }}>{notice}</Body></View> : null}
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
    );
  }

  return (
    <Screen refreshing={loading} onRefresh={() => { void refreshAccepted(); }}>
      <Heading>{qaText(language, 'title')}</Heading>
      <Body muted>{qaText(language, 'sub')}</Body>
      <TextInput
        accessibilityLabel={qaText(language, 'searchLabel')}
        keyboardAppearance={theme.appearance}
        maxLength={QA_MAX_SEARCH_LENGTH}
        returnKeyType="search"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => { void load(query, null); }}
        placeholder={qaText(language, 'searchPlaceholder')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Button label={qaText(language, 'searchLabel')} variant="secondary" busy={loading} onPress={() => { void load(query, null); }} />
      {error ? <Notice>{error}</Notice> : null}
      {notice ? (
        <Pressable key={noticeVersion} style={styles.noticeAction} accessibilityLiveRegion="polite" accessibilityRole="button" accessibilityLabel={`${notice}. Dismiss`} onPress={() => setNotice(null)}>
          <Body style={{ color: theme.primary }}>{notice}</Body>
        </Pressable>
      ) : null}
      {officer ? (
        <Card>
          <Heading level={2}>{qaText(language, 'queueTitle')}</Heading>
          <Body muted>{qaText(language, 'queueSub')}</Body>
          {queueFailed && !error && !loading ? <><Body>{queueUnavailable}</Body><Button label={queueRetry} variant="secondary" busy={busy || loading} onPress={() => { if (!loading) void load(query); }} /></> : null}
          {queue.length === 0 ? !error && !queueFailed ? <Body muted>{qaText(language, 'queueEmpty')}</Body> : null : queue.map((item) => (
            <Button key={item.id} label={item.title} variant="secondary" onPress={() => { setSelected(item); void load(query, item.id); }} />
          ))}
          {queueCursor ? <Button label={qaText(language, 'queueMore')} variant="secondary" busy={busy} onPress={() => { void loadMoreQueue(); }} /> : null}
        </Card>
      ) : null}
      <Card>
        <Heading level={2}>{qaText(language, 'askTitle')}</Heading>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{qaText(language, 'titleLabel')}</Text>
        <TextInput
          accessibilityLabel={qaText(language, 'titleLabel')}
          keyboardAppearance={theme.appearance}
          maxLength={QA_MAX_TITLE_LENGTH}
          value={title}
          editable={!acceptedWrite}
          onChangeText={setTitle}
          accessibilityHint={titleHint || undefined}
          placeholder={qaText(language, 'titlePlaceholder')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {titleHint ? <Body muted>{titleHint}</Body> : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{qaText(language, 'bodyLabel')}</Text>
        <TextInput
          accessibilityLabel={qaText(language, 'bodyLabel')}
          keyboardAppearance={theme.appearance}
          multiline
          maxLength={QA_MAX_BODY_LENGTH}
          value={body}
          editable={!acceptedWrite}
          onChangeText={setBody}
          accessibilityHint={bodyHint || undefined}
          placeholder={qaText(language, 'bodyPlaceholder')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, styles.multiline, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {bodyHint ? <Body muted>{bodyHint}</Body> : null}
        <Button label={qaText(language, 'post')} busy={busy} disabled={Boolean(acceptedWrite) || Boolean(titleHint || bodyHint)} onPress={() => { void postQuestion(); }} />
      </Card>
      {questions.length === 0 && !loading && !error ? (
        <StateMessage title={qaText(language, 'empty')} body={qaText(language, 'sub')} />
      ) : questions.map((item) => (
        <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => { setSelected(item); void load(query, item.id); }}>
          <Card>
            <View style={styles.row}>
              <Heading level={3}>{item.title}</Heading>
              <StatusPill label={qaStatusLabel(language, item.status)} />
            </View>
            <Body>{item.body}</Body>
            <Body muted>{`${qaText(language, qaCountKey('votes', item.upvoteCount), { count: item.upvoteCount })} · ${qaText(language, qaCountKey('replies', item.replyCount), { count: item.replyCount })}`}</Body>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
