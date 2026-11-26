import { describe, expect, it } from 'vitest';
import { nextHeldScope } from './heldScreenScope';

// #9227 round 1 (r1s1): the scope a two-person screen keys its content by.
describe('nextHeldScope', () => {
  const person = 'user-1';
  const signedIn = nextHeldScope(null, false, [person, 'conversation-1'], ['org-1', 'chapter-1']);

  it('keeps the scope while a resume re-checks the same person, with the organization and campaign cleared', () => {
    expect(nextHeldScope(signedIn, true, [person, 'conversation-1'], [null, undefined])).toBe(signedIn);
  });

  it('comes back to the same scope when the resume restores the same place', () => {
    const during = nextHeldScope(signedIn, true, [person, 'conversation-1'], [null, undefined]);
    expect(nextHeldScope(during, false, [person, 'conversation-1'], ['org-1', 'chapter-1']).scope).toBe(signedIn.scope);
  });

  it('is a new scope for another person or another item, even while booting', () => {
    expect(nextHeldScope(signedIn, true, ['user-2', 'conversation-1'], [null, null]).scope).not.toBe(signedIn.scope);
    expect(nextHeldScope(signedIn, true, [person, 'conversation-2'], [null, null]).scope).not.toBe(signedIn.scope);
    expect(nextHeldScope(signedIn, true, [undefined, 'conversation-1'], [null, null]).scope).not.toBe(signedIn.scope);
  });

  it('is a new scope when the signed-in app shows another place, or none', () => {
    expect(nextHeldScope(signedIn, false, [person, 'conversation-1'], ['org-1', 'chapter-2']).scope).not.toBe(signedIn.scope);
    expect(nextHeldScope(signedIn, false, [person, 'conversation-1'], [null, null]).scope).not.toBe(signedIn.scope);
    // A resume that comes back somewhere else is a new scope too.
    const during = nextHeldScope(signedIn, true, [person, 'conversation-1'], [null, null]);
    expect(nextHeldScope(during, false, [person, 'conversation-1'], ['org-2', 'chapter-9']).scope).not.toBe(signedIn.scope);
  });
  it('adopts the first known parts without changing the key, including later renders', () => {
    const pending = nextHeldScope(null, true, [person], [[]], true);
    const known = nextHeldScope(pending, false, [person], [['admin', 'advisor']], true);
    expect(known.scope).toBe(pending.scope);
    expect(nextHeldScope(known, false, [person], [['admin', 'advisor']], true).scope).toBe(known.scope);
  });

  it('retires on confirmed role loss after adopting an initially unavailable scope', () => {
    const pending = nextHeldScope(null, true, [person], [[]], true);
    const known = nextHeldScope(pending, false, [person], [['admin', 'advisor']], true);
    expect(nextHeldScope(known, false, [person], [[]], true).scope).not.toBe(known.scope);
  });

  it('retires a provisional scope on another fixed owner, and on a later confirmed organization change', () => {
    const pending = nextHeldScope(null, true, [person], [null, []], true);
    expect(nextHeldScope(pending, true, ['other-person'], [null, []], true).scope).not.toBe(pending.scope);
    const known = nextHeldScope(pending, false, [person], ['org-a', ['admin']], true);
    expect(nextHeldScope(known, false, [person], ['org-b', ['admin']], true).scope).not.toBe(known.scope);
  });

  it('keeps first-answer rekeying for callers that do not opt in', () => {
    const pending = nextHeldScope(null, true, [person], [[]]);
    expect(nextHeldScope(pending, false, [person], [['admin']]).scope).not.toBe(pending.scope);
  });

});
