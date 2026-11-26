import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Heading } from '../../components/ui';
import { CONNECTION_ISSUE_TOPICS, CONNECTION_SECTORS, connectionDraft, validConnectionDraft,
  type ConnectionDraft, type ConnectionWorkspace } from '../../lib/connectionSuggestionsShared';
import { ConnectionChoices, ConnectionField, ConnectionToggle, connectionStyles, type ConnectionTranslator } from './ConnectionControls';

export function ConnectionProfileEditor({ workspace, busy, onPublish, onWithdraw, tr }: {
  workspace: ConnectionWorkspace; busy: boolean; onPublish: (draft: ConnectionDraft) => void; onWithdraw: () => void; tr: ConnectionTranslator;
}) {
  const [draft, setDraft] = useState(() => connectionDraft(workspace.draft));
  const [consent, setConsent] = useState(false);
  const change = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setDraft((prior) => ({ ...prior, [key]: value })); setConsent(false);
  };
  const toggle = (field: 'sectorKeys' | 'declaredIssueKeys' | 'expertiseOffered', key: string, selected: boolean) => {
    change(field, selected ? [...draft[field], key] : draft[field].filter((item) => item !== key));
  };
  return <View style={connectionStyles.section}>
    <Heading level={3}>{tr('profile')}</Heading><Body>{tr('publicNotice')}</Body>
    <ConnectionChoices label={tr('unitKind')} value={draft.kind} disabled={busy}
      options={[{ key: 'chapter', label: tr('chapter') }, { key: 'local', label: tr('localUnit') }]}
      onChange={(kind) => change('kind', kind === 'local' ? 'local' : 'chapter')} />
    {(['country', 'state', 'metro'] as const).map((key) => <ConnectionField key={key} label={tr(`${key}Label`)} value={draft.location[key]}
      disabled={busy} maxLength={key === 'metro' ? 80 : 8} hint={tr('locationFormat')} autoCapitalize={key === 'metro' ? 'sentences' : 'characters'}
      onChange={(value) => change('location', { ...draft.location, [key]: key === 'metro' ? value : value.trim().toUpperCase() })} />)}
    <Body muted>{tr('locationFormat')}</Body>
    {([
      ['sectorKeys', 'sectorsLabel', CONNECTION_SECTORS],
      ['declaredIssueKeys', 'prioritiesLabel', CONNECTION_ISSUE_TOPICS],
      ['expertiseOffered', 'expertiseLabel', CONNECTION_ISSUE_TOPICS],
    ] as const).map(([field, title, values]) => <View key={field} style={connectionStyles.group}>
      <Heading level={3}>{tr(title)}</Heading>
      {field === 'sectorKeys' && <Body muted>{tr('sectorLimit')}</Body>}
      {field === 'declaredIssueKeys' && <Body muted>{tr('declared')}</Body>}
      {values.map((key) => <ConnectionToggle key={key} label={tr(key)} checked={draft[field].includes(key)}
        disabled={busy || (field === 'sectorKeys' && draft.sectorKeys.length >= 5 && !draft.sectorKeys.includes(key))}
        onChange={(selected) => toggle(field, key, selected)} />)}
    </View>)}
    <ConnectionToggle label={tr('shareAnalyzed')} checked={draft.shareAnalyzedIssues} disabled={busy} onChange={(value) => change('shareAnalyzedIssues', value)} />
    <ConnectionToggle label={tr('consent')} checked={consent} disabled={busy} onChange={setConsent} />
    <Button label={tr('save')} busy={busy} disabled={!consent || !validConnectionDraft(draft)}
      onPress={() => { if (consent && !busy && validConnectionDraft(draft)) onPublish(draft); }} />
    {workspace.profile && <Button label={tr('withdraw')} variant="secondary" disabled={busy} onPress={onWithdraw} />}
  </View>;
}
