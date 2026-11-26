import { describe, expect, it } from 'vitest';

import { READ_FAILURES, failingRead } from '../../../../tests/helpers/failingRead.js';
import { READ_LOADING, READ_STATES, readResult } from './readResult';

describe('native reads keep loaded, empty and failed apart', () => {
  it('is the shared helper', async () => {
    expect(READ_LOADING.state).toBe(READ_STATES.loading);
    expect((await readResult(async () => ['row'])).state).toBe('loaded');
    expect((await readResult(async () => [])).state).toBe('empty');
    for (const kind of READ_FAILURES) {
      const result = await readResult(failingRead(kind));
      expect(result.state).toBe('failed');
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
