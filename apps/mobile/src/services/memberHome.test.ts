import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ create: vi.fn(), upsert: vi.fn(), from: vi.fn(), client: null as unknown }));
vi.mock('./supabase', () => ({
  createCapturedSessionRpcClient: backend.create,
  getSupabaseClient: () => backend.client,
}));

import { HOME_TAKEOVER_RPC } from '../lib/memberHomeShared';
import { loadMemberHomeTakeover, markMemberBroadcastRead } from './memberHome';

function session(token: string): Session {
  return {
    access_token: token,
    refresh_token: `redacted-refresh-${token}`,
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: 'user-a', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-28T12:00:00.000Z' },
  };
}

beforeEach(() => {
  backend.create.mockReset();
  backend.upsert.mockReset();
  backend.from.mockReset();
  backend.from.mockImplementation(() => ({ upsert: backend.upsert }));
  backend.client = { from: backend.from };
});

describe('REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001 native takeover', () => {
  it('reads the takeover on a client captured to the current session', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        enabled: true,
        message: { id: 'm1', conversationId: 'c1', senderName: 'Dana', body: 'Call me today.', createdAt: '2026-09-30T12:00:00Z' },
        broadcast: { id: 'b1', title: 'Vote opens', body: 'Friday', sender: 'Office', publishedAt: '2026-09-29T12:00:00Z', audience: 'chapter' },
      },
      error: null,
    }));
    backend.create.mockReturnValue({ rpc });
    const result = await loadMemberHomeTakeover(session('token-a'));
    expect(backend.create).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-a' }));
    expect(rpc).toHaveBeenCalledWith(HOME_TAKEOVER_RPC);
    expect(result.message).toMatchObject({ id: 'm1', conversationId: 'c1', senderName: 'Dana' });
    expect(result.broadcast).toMatchObject({ id: 'b1', audience: 'chapter' });
  });

  it('renders nothing when the organization switch is off on the server', async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: false, message: null, broadcast: null }, error: null }));
    const result = await loadMemberHomeTakeover(session('t'), { rpc });
    expect(result).toEqual({ enabled: false, message: null, broadcast: null });
  });

  it('fails closed on a refused read', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'membership required' } }));
    await expect(loadMemberHomeTakeover(session('t'), { rpc })).rejects.toThrow('The Home updates could not be loaded.');
  });

  it('marks a broadcast read with the caller-owned idempotent receipt upsert', async () => {
    backend.upsert.mockResolvedValue({ error: null });
    await markMemberBroadcastRead('user-a', 'broadcast-1');
    expect(backend.from).toHaveBeenCalledWith('member_broadcast_receipts');
    expect(backend.upsert).toHaveBeenCalledWith(
      { user_id: 'user-a', broadcast_id: 'broadcast-1' },
      { onConflict: 'broadcast_id,user_id', ignoreDuplicates: true },
    );
  });

  it('surfaces a refused receipt write', async () => {
    backend.upsert.mockResolvedValue({ error: new Error('denied') });
    await expect(markMemberBroadcastRead('user-a', 'b')).rejects.toThrow('denied');
  });

  it('puts the takeover first on live Home with labelled, wired controls', () => {
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const live = home.slice(home.indexOf('function AuthenticatedHome'));
    expect(live).toContain('<HomeTakeoverCards enabled={!sessionRestricted} render={({ message, broadcast, broadcastID, isBroadcastDismissed }) => {');
    const memberUpdates = live.indexOf('{!deskRole ? <HomeTakeoverUpdates message={message} broadcast={broadcast} /> : null}');
    expect(memberUpdates).toBeGreaterThan(0);
    expect(memberUpdates).toBeLessThan(live.indexOf('styles.metrics'));
    const cards = readFileSync(join(__dirname, '../features/home/HomeTakeoverCards.tsx'), 'utf8');
    for (const label of ['Open conversation', 'Mark read']) expect(cards).toContain(`label="${label}"`);
    expect(cards).toContain("router.push(`/conversation/${message.conversationId}`)");
    expect(cards).toContain('markConversationRead(captureSessionWriter(session), userID, message.conversationId)');
    expect(cards).toContain('markMemberBroadcastRead(userID, broadcast.id)');
  });
});
