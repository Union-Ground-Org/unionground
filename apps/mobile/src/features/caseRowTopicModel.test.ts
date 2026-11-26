import { describe, expect, it, vi } from 'vitest';

import { caseTopicNote, SAVE_FAILURE_MESSAGES, saveThenReload } from './caseRowTopicModel';

// #7059 gate r2s1/r4s1 and r4g1: the case-topic cards' save path and notes.
describe('case-topic switch save then reload', () => {
  const confirmed = { value: true, note: 'note' };

  it('shows the server answer after a save and its re-read both succeed', async () => {
    const save = vi.fn(async () => undefined);
    const reload = vi.fn(async () => ({ value: true, note: 'fresh' }));
    await expect(saveThenReload(save, reload, confirmed)).resolves.toEqual({ failure: null, setting: { value: true, note: 'fresh' } });
    expect(save).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reports a refused save as a save failure, keeps the card as it was and does not re-read', async () => {
    const reload = vi.fn(async () => confirmed);
    await expect(saveThenReload(async () => { throw new Error('refused'); }, reload, confirmed)).resolves.toEqual({ failure: 'save' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports a failed re-read after a confirmed save as a reload failure and shows the saved value', async () => {
    await expect(saveThenReload(async () => undefined, async () => { throw new Error('offline'); }, confirmed)).resolves.toEqual({ failure: 'reload', setting: confirmed });
  });

  it('says a different thing for each failure', () => {
    expect(SAVE_FAILURE_MESSAGES.save).toBe('The setting could not be saved. Your saved choice has not changed.');
    expect(SAVE_FAILURE_MESSAGES.reload).toContain('Your choice was saved');
    expect(SAVE_FAILURE_MESSAGES.reload).not.toContain('has not changed');
  });
});

describe('committee member case-topic note', () => {
  it('keeps the neutrality sentence beside the chapter-on note', () => {
    expect(caseTopicNote(true)).toBe('Your campaign shows issue topics in lists. Restricted and private-identity issues stay neutral.');
    expect(caseTopicNote(false)).toBe('Only your own lists change. Other people see what the campaign setting allows. Restricted and private-identity issues stay neutral.');
  });
});
