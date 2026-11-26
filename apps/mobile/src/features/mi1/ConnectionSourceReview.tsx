import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Body, Button, Heading } from '../../components/ui';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import { CONNECTION_ISSUE_TOPICS, CONNECTION_SIGNAL_KINDS, proposeConnectionIssueTags, validConnectionSourceId,
  type ConnectionSourceKind, type ConnectionWorkspace } from '../../lib/connectionSuggestionsShared';
import { ConnectionChoices, ConnectionField, ConnectionToggle, connectionStyles, type ConnectionTranslator } from './ConnectionControls';

export type ConfirmedConnectionReview = { sourceKind: ConnectionSourceKind; sourceId: string; topicKeys: string[] };

export function ConnectionSourceReview({ workspace, busy, onReview, onFreeze, tr }: {
  workspace: ConnectionWorkspace; busy: boolean;
  onReview: (review: ConfirmedConnectionReview, cleared: () => void) => void;
  onFreeze: () => void; tr: ConnectionTranslator;
}) {
  const [kind, setKind] = useState<ConnectionSourceKind>('grievance');
  const [sourceId, setSourceId] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [freezeConsent, setFreezeConsent] = useState(false);
  const announce = useAccessibilityAnnouncementQueue(`connection-source-review:${workspace.chapterId ?? ''}`);
  const reset = () => { setSourceText(''); setTopics([]); setConfirmed(false); };
  // Source text is short-lived native memory only. Clear it when backgrounded,
  // as well as on source changes, successful review, collapse, and scope changes.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { setSourceText(''); setTopics([]); setConfirmed(false); setFreezeConsent(false); }
    });
    return () => subscription.remove();
  }, []);
  return <View style={connectionStyles.section}>
    <Body>{tr('reviewIntro')}</Body>
    <ConnectionChoices label={tr('sourceKind')} value={kind} disabled={busy}
      options={CONNECTION_SIGNAL_KINDS.map((key) => ({ key, label: tr(key) }))}
      onChange={(key) => { setKind(key as ConnectionSourceKind); setSourceId(''); reset(); }} />
    <ConnectionField label={tr('sourceId')} value={sourceId} maxLength={36} disabled={busy}
      onChange={(value) => { setSourceId(value); reset(); }} />
    <ConnectionField label={tr('sourceText')} value={sourceText} maxLength={10000} multiline disabled={busy}
      onChange={(value) => { setSourceText(value); setTopics([]); setConfirmed(false); }} />
    <Body muted>{tr('localAnalysis')}</Body>
    <Button label={tr('propose')} variant="secondary" disabled={busy || !sourceText.trim()} disabledReason={busy ? undefined : tr('proposeNeedsText')}
      onPress={() => { setTopics(proposeConnectionIssueTags({ sourceKind: kind, text: sourceText }).proposals.map((item: { key: string }) => item.key)); setConfirmed(false); announce(tr('proposalsReady')); }} />
    <Heading level={3}>{tr('reviewedTopics')}</Heading>
    {CONNECTION_ISSUE_TOPICS.map((key) => <ConnectionToggle key={key} label={tr(key)} checked={topics.includes(key)} disabled={busy}
      onChange={(selected) => { setTopics(selected ? [...topics, key] : topics.filter((item) => item !== key)); setConfirmed(false); }} />)}
    <ConnectionToggle label={tr('reviewConsent')} checked={confirmed} disabled={busy} onChange={setConfirmed} />
    <Button label={tr('saveReview')} busy={busy} disabled={!confirmed || !validConnectionSourceId(sourceId)}
      disabledReason={tr(validConnectionSourceId(sourceId) ? 'reviewConsentRequired' : 'reviewSourceInvalid')}
      onPress={() => { if (!busy && confirmed && validConnectionSourceId(sourceId)) {
        // Do not spread form state: the request contains only these three fields.
        onReview({ sourceKind: kind, sourceId: sourceId.trim(), topicKeys: [...topics] }, () => { reset(); setSourceId(''); });
      } }} />
    <Heading level={3}>{`${tr('quarterTitle')}${workspace.analysis.nextPeriodKey ? ` · ${workspace.analysis.nextPeriodKey}` : ''}`}</Heading>
    <Body>{tr('quarterHelp')}</Body>
    {workspace.analysis.latest && <Body>{`${tr('latestThemes')}: ${workspace.analysis.latest.topics.length ? workspace.analysis.latest.topics.map((topic) => tr(topic.key)).join(', ') : tr('suppressedThemes')}`}</Body>}
    {workspace.analysis.nextPeriodFrozen ? <Body>{tr('alreadyFrozen')}</Body> : <>
      <ConnectionToggle label={tr('freezeConsent')} checked={freezeConsent} disabled={busy} onChange={setFreezeConsent} />
      <Button label={tr('freeze')} variant="secondary" busy={busy} disabled={!freezeConsent}
        onPress={() => { if (freezeConsent && !busy) { setFreezeConsent(false); onFreeze(); } }} />
    </>}
  </View>;
}
