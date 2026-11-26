import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ getSupabaseClient: () => null }));

import { meetingRefusal } from './chapterMeetings';

// #9099 part 1: create_member_event_model raises 42501 for two different
// reasons, and the phone names each one.
describe('meeting refusals', () => {
  it('tells a role refusal from a missing campaign', () => {
    expect(meetingRefusal({ code: '42501', message: 'staff role required' })).toBe('role');
    expect(meetingRefusal({ code: '42501', message: 'staff campaign required' })).toBe('chapter');
    expect(meetingRefusal({ code: '22023', message: 'invalid summary' })).toBeNull();
    expect(meetingRefusal(new Error('network'))).toBeNull();
    expect(meetingRefusal(null)).toBeNull();
  });
});
