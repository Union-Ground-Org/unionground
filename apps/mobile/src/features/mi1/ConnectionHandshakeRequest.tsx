import { useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { AppState, Modal } from 'react-native';
import { Body, Button, Heading, Screen, StatusPill } from '../../components/ui';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import type { ConnectionMatch } from '../../lib/connectionSuggestionsShared';
import { ConnectionChoices, ConnectionField, type ConnectionTranslator } from './ConnectionControls';

export type ConnectionHandshakeDraft = { title: string; purpose: string; dataScope: 'docs_only' | 'no_member_data' | 'aggregate_only'; idempotencyKey: string };
export type ConnectionHandshakeSubmission = { target: ConnectionMatch; fields: ConnectionHandshakeDraft; noticeKey: 'handshakeSent' | 'handshakeDeclined' | 'handshakeClosed' | 'handshakePreviewSent' };

// One explicit submit joins a published suggestion to the existing two-sided
// lifecycle. Ranking, opening this sheet and selecting a scope send nothing.
export function ConnectionHandshakeRequest({ target, preview, onSubmit, onClose, tr }: {
  target: ConnectionMatch; preview: boolean; onSubmit: (fields: ConnectionHandshakeDraft) => Promise<void>; onClose: () => void; tr: ConnectionTranslator;
}) {
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [dataScope, setDataScope] = useState<ConnectionHandshakeDraft['dataScope']>('no_member_data');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const running = useRef(false);
  const active = useRef(true);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const announce = useAccessibilityAnnouncementQueue(`connection-handshake:${target.id}`);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // Keep the operation and its retry key alive until the reply settles.
      // Session/actor changes still unmount the owning connection session.
      if (state !== 'active' && !running.current) { setTitle(''); setPurpose(''); setError(false); onClose(); }
    });
    return () => subscription.remove();
  }, [onClose]);
  const submit = async () => {
    if (running.current || !active.current || !title.trim() || !purpose.trim()) return;
    // A lost reply can retry the same request, while editing any field starts
    // a new idempotent operation instead of reusing a key for different bytes.
    const payload = JSON.stringify([target.id, title.trim(), purpose.trim(), dataScope]);
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: Crypto.randomUUID() };
    running.current = true; setBusy(true); setError(false);
    try {
      await onSubmit({ title: title.trim(), purpose: purpose.trim(), dataScope, idempotencyKey: attempt.current.key });
      if (active.current) onClose();
    } catch {
      if (active.current) { setError(true); announce(tr('handshakeError')); }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  return <Modal visible presentationStyle="pageSheet" onRequestClose={() => { if (!running.current) onClose(); }}>
    <Screen>
      <Heading>{tr('requestHandshake')}</Heading>
      <Heading level={2}>{target.displayName}</Heading>
      <Body>{tr('handshakeConsent')}</Body>
      {preview && <StatusPill label={tr('handshakePreview')} />}
      <ConnectionField label={tr('handshakeTitle')} value={title} onChange={setTitle} maxLength={160} disabled={busy} />
      <ConnectionField label={tr('handshakePurpose')} value={purpose} onChange={setPurpose} maxLength={4000} multiline disabled={busy} />
      <ConnectionChoices label={tr('handshakeBoundary')} value={dataScope} disabled={busy}
        options={['no_member_data', 'docs_only', 'aggregate_only'].map((key) => ({ key, label: tr(key) }))}
        onChange={(value) => { if (value === 'docs_only' || value === 'no_member_data' || value === 'aggregate_only') setDataScope(value); }} />
      {error && <Body accessibilityRole="alert">{tr('handshakeError')}</Body>}
      <Button label={tr('handshakeSend')} busy={busy} disabled={busy || !title.trim() || !purpose.trim()} onPress={() => { void submit(); }} />
      <Button label={tr('close')} variant="secondary" disabled={busy} onPress={onClose} />
    </Screen>
  </Modal>;
}
