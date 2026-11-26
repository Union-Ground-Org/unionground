import { describe, expect, it } from 'vitest';

import { createNativeAuthGate } from './nativeAuthGate';

const firstID = '11111111-1111-4111-8111-111111111111';
const secondID = '22222222-2222-4222-8222-222222222222';
function session(id = firstID, user = 'qa', rotation = 0) {
  return { user: { id: user }, access_token: `h.${Buffer.from(JSON.stringify({ session_id: id, rotation })).toString('base64url')}.s` };
}

describe('native prompt ownership', () => {
  it('cancels an unreturned prompt and preserves the original session after a cancelled link write', () => {
    const gate = createNativeAuthGate();
    const original = session();
    const operation = gate.begin(original);
    operation.stage(session(firstID, 'qa', 1));
    gate.cancel();
    expect(operation.signal.aborted).toBe(true);
    expect(gate.canWrite(JSON.stringify(original))).toBe(false);
    operation.finish();
    expect(gate.canWrite(JSON.stringify(original))).toBe(true);
    expect(gate.observe(original)).toBe(true);
  });
  it('allows same-session refresh while provider UI backgrounds the app', () => {
    const gate = createNativeAuthGate();
    const operation = gate.begin(session());
    expect(gate.observe(session(firstID, 'qa', 1))).toBe(true);
    expect(operation.current()).toBe(true);
    operation.finish();
  });

  it('does not let a late provider session survive sign-out or take over another account', () => {
    const gate = createNativeAuthGate();
    const operation = gate.begin(session());
    gate.observe(null);
    expect(() => operation.stage(session())).toThrow();
    operation.finish();
    const next = gate.begin(null);
    gate.observe(session(secondID, 'someone-else'));
    expect(() => next.stage(session())).toThrow();
    next.finish();
  });

  it('guards storage and auth meetings when cancellation races with setSession', () => {
    const gate = createNativeAuthGate();
    const operation = gate.begin(null);
    const candidate = session();
    operation.stage(candidate);
    expect(gate.isStaged(candidate)).toBe(true);
    expect(gate.observe(candidate)).toBe(true);
    expect(gate.canWrite(JSON.stringify(candidate))).toBe(true);
    gate.cancel();
    expect(gate.canWrite(JSON.stringify(candidate))).toBe(false);
    expect(gate.observe(candidate)).toBe(false);
    operation.finish();
    expect(gate.observe(candidate)).toBe(false);
    expect(gate.canWrite(JSON.stringify(session(firstID, 'qa', 1)))).toBe(false);
    expect(gate.observe(session(secondID))).toBe(true);
  });

  it('rejects cross-account linking and overlapping requests', () => {
    const gate = createNativeAuthGate();
    const operation = gate.begin(session());
    expect(() => gate.begin(null)).toThrow();
    expect(() => operation.stage(session(secondID, 'someone-else'))).toThrow();
    operation.finish();
    expect(gate.isBusy()).toBe(false);
  });

  it('releases a successful session to normal auth lifecycle after adoption', () => {
    const gate = createNativeAuthGate();
    const operation = gate.begin(null);
    operation.stage(session());
    operation.finish();
    expect(gate.isStaged(session())).toBe(false);
    expect(gate.canWrite(JSON.stringify(session()))).toBe(true);
    expect(gate.observe(session())).toBe(true);
  });
});
