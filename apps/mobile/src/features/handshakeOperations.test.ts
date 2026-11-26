import { describe, expect, it } from 'vitest';

import { createEffectLedger, deliverTwice, retryAfterLostResponse, type EffectLedger } from '../../../../tests/helpers/operationReplay.js';
import { createHandshakeOperations, type HandshakeWrites } from './handshakeOperations';

// request_chapter_handshake, the three transitions and the document share all
// look up their event by key, so the ledger stands in for the database.
function writes(ledger: EffectLedger): HandshakeWrites {
  return {
    async request(fields) { await ledger.perform(fields.idempotencyKey, ['request', fields.partnerOrgID, fields.title]); },
    async respond(id, decision, key) { await ledger.perform(key, [decision, id]); },
    async countersign(id, key) { await ledger.perform(key, ['countersign', id]); },
    async close(id, key) { await ledger.perform(key, ['close', id]); },
    async shareDocument(id, documentID, key) { await ledger.perform(key, ['share', id, documentID]); },
  };
}

function uuids() {
  let next = 0;
  return () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++next).padStart(12, '0')}`;
}

const fields = { partnerOrgID: 'org-cedar', title: 'Shared training', purpose: 'Joint committee member training', dataScope: 'docs_only' as const };

describe('native handshake writes keep their operation key across retries', () => {
  it('files one handshake request when the first response is lost', async () => {
    const ledger = createEffectLedger();
    const handshakes = createHandshakeOperations(writes(ledger), uuids());
    await retryAfterLostResponse(ledger, () => handshakes.request(fields));
    expect(ledger.effects).toHaveLength(1);
  });

  it('records one transition and one share for double taps', async () => {
    const ledger = createEffectLedger();
    const handshakes = createHandshakeOperations(writes(ledger), uuids());
    for (const action of ['accept', 'decline', 'countersign', 'close'] as const) {
      await deliverTwice(() => handshakes.transition('handshake-1', action));
    }
    await deliverTwice(() => handshakes.shareDocument('handshake-1', 'document-1'));
    expect(ledger.effects.map(({ payload }) => (payload as string[])[0])).toEqual(['accept', 'decline', 'countersign', 'close', 'share']);
  });

  it('files a new request once a kept key is ten minutes old', async () => {
    let clock = 0;
    const ledger = createEffectLedger();
    const handshakes = createHandshakeOperations(writes(ledger), uuids(), { now: () => clock });
    ledger.loseNextResponses(1);
    await expect(handshakes.request(fields)).rejects.toThrow();
    clock = 9 * 60_000;
    ledger.loseNextResponses(1);
    await expect(handshakes.request(fields)).rejects.toThrow();
    clock = 10 * 60_000;
    await handshakes.request(fields);
    expect(ledger.keys[1]).toBe(ledger.keys[0]);
    expect(ledger.keys[2]).not.toBe(ledger.keys[0]);
    expect(ledger.effects).toHaveLength(2);
  });

  it('starts a new request after an answer or when the request changes', async () => {
    const ledger = createEffectLedger();
    const handshakes = createHandshakeOperations(writes(ledger), uuids());
    ledger.loseNextResponses(1);
    await expect(handshakes.request(fields)).rejects.toThrow();
    await handshakes.request({ ...fields, title: ' Shared training ' });
    await handshakes.request({ ...fields, purpose: 'Another purpose' });
    await handshakes.request(fields);
    expect(ledger.effects).toHaveLength(3);
    expect(ledger.keys[1]).toBe(ledger.keys[0]);
  });
});
