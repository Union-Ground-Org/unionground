import { getSupabaseClient as businessTestClient } from './supabase';
import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCaseRowTopic, loadChapterCaseRowTopic, parseCaseRowTopic, parseChapterCaseRowTopic, saveCaseRowTopic, saveChapterCaseRowTopic } from './caseRowTopic';

// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043).
const backend = vi.hoisted(() => ({ configured: true, rpc: vi.fn() }));
vi.mock('./supabase', () => ({ getSupabaseClient: () => backend.configured ? backend : null }));

describe('case-row topic switches', () => {
  beforeEach(() => { backend.configured = true; backend.rpc.mockReset(); });

  it('reads and saves the campaign switch through its leadership RPCs', async () => {
    backend.rpc.mockResolvedValueOnce({ data: { chapterId: 'ch', enabled: true, canChange: true }, error: null });
    expect(await loadChapterCaseRowTopic('ch')).toEqual({ enabled: true, canChange: true });
    expect(backend.rpc).toHaveBeenLastCalledWith('get_chapter_case_row_topic', { p_chapter: 'ch' });
    backend.rpc.mockResolvedValueOnce({ data: { updated: true }, error: null });
    await saveChapterCaseRowTopic(businessWriter, 'ch', false);
    expect(backend.rpc).toHaveBeenLastCalledWith('set_chapter_case_row_topic', { p_chapter: 'ch', p_enabled: false });
  });

  it('reads and saves the committee member switch for one issue', async () => {
    backend.rpc.mockResolvedValueOnce({ data: { shown: false, chapterShown: true, canChange: true }, error: null });
    expect(await loadCaseRowTopic('c1')).toEqual({ shown: false, chapterShown: true, canChange: true });
    expect(backend.rpc).toHaveBeenLastCalledWith('get_case_row_topic', { p_case: 'c1' });
    backend.rpc.mockResolvedValueOnce({ data: { updated: true }, error: null });
    await saveCaseRowTopic(businessWriter, 'c1', true);
    expect(backend.rpc).toHaveBeenLastCalledWith('set_case_row_topic', { p_case: 'c1', p_shown: true });
  });

  it('refuses unverified answers, server refusals and a missing backend', async () => {
    expect(() => parseChapterCaseRowTopic({ canChange: true })).toThrow('could not be verified');
    expect(() => parseCaseRowTopic(null)).toThrow('could not be verified');
    expect(parseCaseRowTopic({ shown: true })).toEqual({ shown: true, chapterShown: false, canChange: false });
    backend.rpc.mockResolvedValue({ data: null, error: new Error('refused') });
    await expect(loadChapterCaseRowTopic('ch')).rejects.toThrow('refused');
    await expect(saveChapterCaseRowTopic(businessWriter, 'ch', true)).rejects.toThrow('refused');
    await expect(loadCaseRowTopic('c1')).rejects.toThrow('refused');
    await expect(saveCaseRowTopic(businessWriter, 'c1', true)).rejects.toThrow('refused');
    backend.configured = false;
    await expect(loadCaseRowTopic('c1')).rejects.toThrow('not configured');
  });
});
