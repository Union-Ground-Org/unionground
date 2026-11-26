import { useApp } from '../state/AppProvider';
import { captureSessionWriter } from '../services/supabase';
// Native surfaces for the chapter channel controls
// (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001): per-channel notification
// level, mute and keyword alerts; highlighted post bodies; the mention picker;
// and the staff pin toggle. Each control renders only when the organization
// switch is on, carries a role, a label and a handler, and is disabled while
// its write is in flight. Saved state is shown only after the server answers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import { Body, Button, Notice, SearchField } from './ui';
import { channelControlsApi, type MentionCandidate } from '../data/channelControls';
import {
  CHANNEL_MUTE_DURATIONS,
  CHANNEL_NOTIFICATION_LEVELS,
  channelSettingFor,
  isChannelControlDisabled,
  isKeywordLimitError,
  isMuteActive,
  keywordListProblem,
  muteUntilFor,
  normalizeKeywords,
  segmentChannelText,
  type ChannelControls,
  type ChannelNotificationLevel,
  type ChannelSetting,
} from '../lib/channelControlsShared';
import { useTheme } from '../theme/ThemeProvider';
import { nativeUiText, type NativeUiKey, type NativeUiText } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { readResumeDraft, resumeDraftIsCurrent, resumeDraftReadsConfirmed, retireResumeDraft, settleResumeDraft, useResumeDraft, useResumeDraftKey, writeResumeDraft, type ResumeDraftKey } from '../lib/resumeDraftHolder';
import { radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
import { useRequestGeneration } from '../lib/useRequestGeneration';
// English text, which is also each phrase's catalogue key (see useNativeUi).
const LEVEL_COPY: Record<ChannelNotificationLevel, { label: NativeUiKey; detail: NativeUiKey }> = {
  all: { label: 'Every post', detail: 'Each new post in this channel notifies you.' },
  mentions: { label: 'Mentions only', detail: 'Only posts that mention you, @here while you are online, or your keywords.' },
  none: { label: 'Nothing', detail: 'This channel never notifies you. You can still read it here.' },
};

const MUTE_COPY: Partial<Record<string, NativeUiKey>> = {
  '1h': '1 hour', '8h': '8 hours', '24h': '24 hours', '7d': '1 week', forever: 'Until I unmute',
};

export const CHANNEL_BOUNDARIES_COPY = 'These settings apply only to this channel. Direct messages, task conversations, announcements and urgent notices are never muted by them. Quiet hours and your notification topics still apply.';

// #9426 round 1 (r1s1/r2s1): only a dispatched save whose answer was lost
// may have been saved. The session writer refuses before dispatch with
// details 'writer_session_changed'; an answered Postgrest rejection carries
// its SQLSTATE/PostREST code (22023 keyword-limit included) or a 4xx HTTP
// status, while a lost answer arrives with neither. A 5xx gateway answer
// can arrive after the function committed, so it stays unknown.
function channelSaveOutcomeUnknown(error: unknown): boolean {
  const fields = error && typeof error === 'object' ? error as { code?: unknown; details?: unknown; status?: unknown } : null;
  if (!fields) return true;
  if (fields.details === 'writer_session_changed') return false;
  if (isKeywordLimitError(error) || isChannelControlDisabled(error)) return false;
  if (typeof fields.code === 'string' && fields.code !== '') return false;
  if (typeof fields.status === 'number' && fields.status >= 400 && fields.status < 500) return false;
  return true;
}

function failureCopy(error: unknown, t: NativeUiText): string {
  if (isChannelControlDisabled(error)) return t('Your organization has turned this off.');
  if (isKeywordLimitError(error)) return t("You have reached your organization's keyword limit. Remove one first.");
  return t('That change was not saved. Try again.');
}

export function channelHasAnyControl(controls: ChannelControls): boolean {
  const s = controls.switches;
  return controls.available && (s.notificationLevels || s.channelMute || s.keywordAlerts);
}

function muteLabel(setting: ChannelSetting, t: NativeUiText, locale: string): string {
  if (!setting.mutedUntil) return t('Muted until you unmute it');
  const until = new Date(setting.mutedUntil);
  return t('Muted until {time}', { time: until.toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
}

type ChannelSettingsProps = {
  spaceID: string;
  controls: ChannelControls;
  onSaved: (spaceID: string, setting: Required<ChannelSetting>) => void;
  /** The route supplies its item identity and fresh channel/control verdict. */
  resumeItemID?: string;
  freshAccess?: boolean;
};

export function ChannelSettingsPanel(props: ChannelSettingsProps) {
  const app = useApp();
  const key = useResumeDraftKey(app, 'channelSettings', props.resumeItemID ?? props.spaceID);
  const sendKey = useResumeDraftKey(app, 'channelSettingSend', props.resumeItemID ?? props.spaceID);
  const holding = props.resumeItemID !== undefined;
  const fresh = app.mode === 'authenticated' && resumeDraftReadsConfirmed(app) && props.freshAccess !== false;
  useEffect(() => {
    if (!holding || !fresh) return;
    const held = readResumeDraft(key);
    if (!props.controls.available || (!props.controls.switches.keywordAlerts && held?.value.keyword)) {
      retireResumeDraft(key); retireResumeDraft(sendKey);
    }
  }, [fresh, holding, key, sendKey, props.controls.available, props.controls.switches.keywordAlerts]);
  if (holding && (!fresh || !props.controls.available)) return null;
  return <ScopedChannelSettingsPanel key={key?.id ?? `${app.session?.user.id}:${props.spaceID}`} {...props}
    resumeKey={holding ? key : null} sendKey={holding ? sendKey : null} />;
}

function ScopedChannelSettingsPanel({ spaceID, controls, onSaved, resumeKey, sendKey }: ChannelSettingsProps & {
  resumeKey: ResumeDraftKey<'channelSettings'> | null;
  sendKey: ResumeDraftKey<'channelSettingSend'> | null;
}) {
  const theme = useTheme();
  const { language, locale } = useNativeUi();
  const t = useMemo(() => nativeUiText(language), [language]);
  const { session } = useApp();
  const writer = useMemo(() => captureSessionWriter(session), [session]);
  const setting = channelSettingFor(controls, spaceID);
  const switches = controls.switches;
  const [localBusy, setBusy] = useState(false);
  const retained = useResumeDraft(resumeKey, true);
  const sending = useResumeDraft(sendKey, true);
  const busy = localBusy || sending?.pending === true;
  const [notice, setNotice] = useState<{ failed: boolean; text: string } | null>(null);
  const [localDuration, setLocalDuration] = useState('8h');
  const [localKeywordDraft, setLocalKeywordDraft] = useState('');
  const duration = resumeKey ? retained?.value.duration ?? '8h' : localDuration;
  const keywordDraft = resumeKey ? retained?.value.keyword ?? '' : localKeywordDraft;
  function setKeywordDraft(keyword: string) {
    // New words replace the draft and its lost-attempt mark with them.
    if (resumeKey) writeResumeDraft(resumeKey, { keyword, duration });
    else setLocalKeywordDraft(keyword);
  }
  function setDuration(next: string) {
    if (resumeKey) writeResumeDraft(resumeKey, { keyword: keywordDraft, duration: next, ...(retained?.value.attempted ? { attempted: true } : {}) });
    else setLocalDuration(next);
  }
  const elsewhere = Math.max(0, controls.keywordCount - setting.keywords.length);
  const saves = useRequestGeneration(JSON.stringify([session?.user.id, spaceID]));
  useEffect(() => { setBusy(false); setNotice(null); setLocalKeywordDraft(''); }, [saves]);
  useEffect(() => {
    if (!sending || sending.pending) return;
    if (sending.value.failed) {
      setNotice({ failed: true, text: t('That change was not saved. Try again.') });
      // Ledger 680: consuming the failed companion must not lose the fact
      // that this keyword was dispatched; stamp it on the keyword draft so
      // the own-text panel keeps its uncertainty line after this unmounts.
      if (sending.value.keywordOperation && sending.value.outcomeUnknown && resumeKey) {
        const draft = readResumeDraft(resumeKey);
        if (draft && resumeDraftIsCurrent(draft, true) && draft.value.keyword) {
          writeResumeDraft(resumeKey, { ...draft.value, attempted: true });
        }
      }
      retireResumeDraft(sendKey);
      return;
    }
    const saved = sending.value.saved;
    if (!saved) return;
    const ticket = saves.capture();
    void writer.isCurrent().then((current) => {
      if (!current || !ticket.isCurrent() || !resumeDraftIsCurrent(sending, true)) return;
      onSaved(spaceID, saved); setNotice({ failed: false, text: t('Saved.') });
      retireResumeDraft(sendKey);
    });
  }, [sending, saves, writer, onSaved, spaceID, sendKey, resumeKey, t]);

  async function save(work: () => Promise<Required<ChannelSetting>>, keyword = false): Promise<boolean> {
    if (busy) return false;
    // Ledger 679: the companion carries which operation it is, so the
    // own-text panel never treats a mute or level receipt as a keyword one.
    const pending = sendKey ? writeResumeDraft(sendKey, { failed: false, saved: null, keywordOperation: keyword }, true) : null;
    if (sendKey && !pending) return false;
    const owner = readResumeDraft(resumeKey);
    setBusy(true);
    setNotice(null);
    const ticket = saves.capture();
    try {
      const saved = await work();
      if (pending) {
        if (!resumeDraftIsCurrent(pending)) return false;
        if (keyword && owner) settleResumeDraft(owner, { ...owner.value, keyword: '', attempted: false });
        settleResumeDraft(pending, { failed: false, saved, keywordOperation: keyword });
        // The currently verified owner consumes the acknowledgement, even
        // when the submitting component disappeared during foreground boot.
        return false;
      }
      const current = await writer.isCurrent();
      if (!ticket.isCurrent() || !current) return false;
      onSaved(spaceID, saved);
      setNotice({ failed: false, text: t('Saved.') });
      return true;
    } catch (error) {
      if (pending) {
        if (isAuthoritativeReadRefusal(error) || isChannelControlDisabled(error)) {
          if (settleResumeDraft(pending, null)) retireResumeDraft(resumeKey);
        } else settleResumeDraft(pending, { failed: true, saved: null, keywordOperation: keyword, outcomeUnknown: channelSaveOutcomeUnknown(error) });
      }
      const proof = await writer.check();
      if (ticket.isCurrent() && proof !== 'changed') setNotice({ failed: true, text: failureCopy(error, t) });
      return false;
    } finally {
      if (ticket.isCurrent()) setBusy(false);
    }
  }

  async function addKeyword() {
    const ticket = saves.capture();
    const next = normalizeKeywords([...setting.keywords, keywordDraft]);
    const problem = keywordListProblem(next, { elsewhere, limit: controls.keywordLimit });
    if (problem) {
      setNotice({ failed: true, text: t(problem === 'length' ? 'A keyword is 2 to 48 characters.' : problem === 'per-channel' ? 'A channel can watch at most 20 keywords.' : "You have reached your organization's keyword limit. Remove one first.") });
      return;
    }
    if (await save(() => channelControlsApi.setKeywords(writer, spaceID, next), true) && ticket.isCurrent()) setKeywordDraft('');
  }

  const muteActive = isMuteActive(setting);
  return (
    <View style={[styles.panel, { borderColor: theme.border, backgroundColor: theme.card }]}>
      {switches.notificationLevels ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.foreground }]}>{t('Notify me about')}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('Notify me about')} style={styles.options}>
            {CHANNEL_NOTIFICATION_LEVELS.map((level) => (
              <Button
                key={level}
                label={t(LEVEL_COPY[level].label)}
                variant="secondary"
                selected={setting.level === level}
                disabled={busy}
                onPress={() => { if (setting.level !== level) void save(() => channelControlsApi.setLevel(writer, spaceID, level)); }}
              />
            ))}
          </View>
          <Body muted>{t(LEVEL_COPY[setting.level].detail)}</Body>
        </View>
      ) : null}
      {switches.channelMute ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.foreground }]}>{t('Mute')}</Text>
          {muteActive ? (
            <>
              <Body>{muteLabel(setting, t, locale)}</Body>
              <Button label={t('Unmute')} variant="secondary" disabled={busy} onPress={() => { void save(() => channelControlsApi.setMute(writer, spaceID, false, null)); }} />
            </>
          ) : (
            <>
              <View accessibilityRole="radiogroup" accessibilityLabel={t('Mute for')} style={styles.options}>
                {CHANNEL_MUTE_DURATIONS.map((choice) => (
                  <Button key={choice.id} label={(() => { const words = MUTE_COPY[choice.id]; return words ? t(words) : choice.id; })()} variant="secondary" selected={duration === choice.id} disabled={busy} onPress={() => setDuration(choice.id)} />
                ))}
              </View>
              <Button label={t('Mute channel')} disabled={busy} onPress={() => { void save(() => channelControlsApi.setMute(writer, spaceID, true, muteUntilFor(duration))); }} />
            </>
          )}
          <Body muted>{t('While muted, nothing from this channel notifies you, mentions included. Mentions still appear in Your mentions.')}</Body>
        </View>
      ) : null}
      {switches.keywordAlerts ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.foreground }]}>{t('Keyword alerts')}</Text>
          <Body muted>{t('Posts here that contain a keyword are highlighted and notify you. You are using {used} of {limit} keywords across all channels.', { used: controls.keywordCount, limit: controls.keywordLimit })}</Body>
          {setting.keywords.map((keyword) => (
            <View key={keyword} style={styles.keywordRow}>
              <Text style={[styles.keyword, { color: theme.foreground }]}>{keyword}</Text>
              <Button label={t('Remove keyword {keyword}', { keyword })} variant="secondary" disabled={busy}
                onPress={() => { void save(() => channelControlsApi.setKeywords(writer, spaceID, setting.keywords.filter((item) => item !== keyword))); }} />
            </View>
          ))}
          <TextInput
            accessibilityLabel={t('New keyword')}
            value={keywordDraft}
            onChangeText={setKeywordDraft}
            maxLength={48}
            editable={!busy}
            placeholder={t('New keyword')}
            placeholderTextColor={theme.quietForeground}
            keyboardAppearance={theme.appearance}
            style={[styles.input, { color: theme.foreground, borderColor: theme.border }]}
            onSubmitEditing={() => { void addKeyword(); }}
          />
          <Button label={t('Add keyword')} variant="secondary" disabled={busy || !keywordDraft.trim()} onPress={() => { void addKeyword(); }} />
        </View>
      ) : null}
      <Body muted>{t(CHANNEL_BOUNDARIES_COPY)}</Body>
      {notice ? (notice.failed ? <Notice>{notice.text}</Notice> : <Text accessibilityLiveRegion="polite" style={[styles.saved, { color: theme.mutedForeground }]}>{notice.text}</Text>) : null}
    </View>
  );
}

// One line of a post body, which the channel sizes its body's target from.
export const CHANNEL_BODY_LINE_HEIGHT = 21;

// A post body with keyword and @here highlights. One <Text>, so VoiceOver and
// TalkBack read the body once, in order; the highlight is visual emphasis.
export function ChannelHighlightedBody({ body, keywords, here }: { body: string; keywords: readonly string[]; here: boolean }) {
  const theme = useTheme();
  const segments = segmentChannelText(body, { keywords, here });
  return (
    <Text style={[styles.body, { color: theme.foreground }]}>
      {segments.map((segment, index) => segment.highlight
        ? <Text key={index} style={[styles.highlight, { backgroundColor: theme.accent, color: theme.accentForeground }]}>{segment.text}</Text>
        : segment.text)}
    </Text>
  );
}

export function MentionPickerPanel({ spaceID, disabled, open, onClose, onPick }: {
  spaceID: string;
  disabled: boolean;
  open: boolean;
  onClose: () => void;
  onPick: (person: MentionCandidate) => void;
}) {
  const { t } = useNativeUi();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MentionCandidate[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const run = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const current = ++run.current;
    setState('loading');
    const timer = setTimeout(() => {
      channelControlsApi.mentionCandidates(spaceID, query.trim()).then((found) => {
        if (current !== run.current) return;
        setRows(found);
        setState('ready');
      }).catch(() => {
        if (current !== run.current) return;
        setRows([]);
        setState('error');
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query, spaceID]);
  if (!open) return null;
  return (
    <View style={styles.section} onAccessibilityEscape={onClose}>
      <SearchField value={query} onChangeText={setQuery} placeholder={t('Find a person to mention')} accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Find a person to mention')} />
      {rows.map((person) => (
        <Button key={person.id} label={`${t('Mention {name}', { name: person.name })}${rows.some((other) => other.id !== person.id && other.name === person.name) ? ` (${person.id})` : ''}`} variant="secondary" disabled={disabled} onPress={() => { onPick(person); onClose(); setQuery(''); }} />
      ))}
      {state === 'ready' && rows.length === 0 ? <Body muted>{t('No one in this channel matches.')}</Body> : null}
      {state === 'error' ? <Notice>{t('People could not be loaded. Try again.')}</Notice> : null}
      <Button label={t('Close mention search')} variant="secondary" onPress={() => { onClose(); setQuery(''); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, padding: spacing.md, gap: spacing.md },
  section: { gap: spacing.sm },
  heading: { fontSize: 15, lineHeight: 20, ...typeface.heading },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  keywordRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  keyword: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong, flexShrink: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, paddingHorizontal: spacing.sm, minHeight: 44, fontSize: 15 },
  saved: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: CHANNEL_BODY_LINE_HEIGHT },
  highlight: { ...typeface.controlStrong },
});
