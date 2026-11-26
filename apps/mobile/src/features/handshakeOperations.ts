import { createOperationKeys, operationIntent, withOperationKey, type OperationKeyOptions } from '../lib/operationKey';
import type { MobileHandshake } from '../services/supabase';

export type HandshakeTransition = 'accept' | 'decline' | 'countersign' | 'close';
export type HandshakeRequestFields = {
  partnerOrgID: string; title: string; purpose: string; dataScope: MobileHandshake['dataScope'];
};
export type HandshakeWrites = {
  request(fields: HandshakeRequestFields & { idempotencyKey: string }): Promise<void>;
  respond(handshakeID: string, decision: 'accept' | 'decline', idempotencyKey: string): Promise<void>;
  countersign(handshakeID: string, idempotencyKey: string): Promise<void>;
  close(handshakeID: string, idempotencyKey: string): Promise<void>;
  shareDocument(handshakeID: string, documentID: string, idempotencyKey: string): Promise<void>;
};

// The handshake functions deduplicate by key. A tap after an error retries the
// same request, transition or share with the key of its first try, so a lost
// response cannot file a second request or a second shared-document event
// (SYS-UG-SHARED-RETRY-IDEMPOTENCY-GUARD-20261113). A kept key lasts
// ten minutes, so a later identical request is a new one (review of #8648).
export function createHandshakeOperations(writes: HandshakeWrites, randomUUID: () => string, options: OperationKeyOptions = {}) {
  const keys = createOperationKeys(randomUUID, options);
  return {
    request(fields: HandshakeRequestFields): Promise<void> {
      const intent = operationIntent('request_chapter_handshake', {
        partnerOrgID: fields.partnerOrgID, title: fields.title.trim(), purpose: fields.purpose.trim(), dataScope: fields.dataScope,
      });
      return withOperationKey(keys, intent, (idempotencyKey) => writes.request({ ...fields, idempotencyKey }));
    },
    transition(handshakeID: string, action: HandshakeTransition): Promise<void> {
      return withOperationKey(keys, operationIntent('transition_chapter_handshake', { handshakeID, action }), (key) => {
        if (action === 'accept' || action === 'decline') return writes.respond(handshakeID, action, key);
        if (action === 'countersign') return writes.countersign(handshakeID, key);
        return writes.close(handshakeID, key);
      });
    },
    shareDocument(handshakeID: string, documentID: string): Promise<void> {
      return withOperationKey(keys, operationIntent('share_chapter_handshake_document', { handshakeID, documentID }),
        (key) => writes.shareDocument(handshakeID, documentID, key));
    },
  };
}
