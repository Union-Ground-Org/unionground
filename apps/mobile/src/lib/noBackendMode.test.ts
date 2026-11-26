import { describe, expect, it } from 'vitest';

import { noBackendMode } from './noBackendMode';

describe('noBackendMode', () => {
  it('retains only an explicitly entered PREVIEW session while backend bootstrap settles', () => {
    expect(noBackendMode('preview')).toBe('preview');
  });

  it.each(['booting', 'signedOut', 'mfaRequired', 'authenticated'])('resolves %s to signed out', (mode) => {
    expect(noBackendMode(mode)).toBe('signedOut');
  });
});
