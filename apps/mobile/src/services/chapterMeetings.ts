import type { MobileSessionWriter } from './supabase';
// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 1 of 4): the phone creates a chapter meeting through the RPC the
// website's event form calls. Role and chapter checks stay in the RPC
// (private.member_can_manage_events, private.current_member_chapter).
import type { CreateMeetingArgs } from '../lib/chapterMeeting';


export async function createMobileChapterMeeting(writer: MobileSessionWriter, args: CreateMeetingArgs): Promise<void> {
  const { error, status } = await (await writer.client()).rpc('create_member_event_model', args);
  if (error) throw Object.assign(error, { status });
}

/**
 * The RPC answers 42501 for two reasons: 'staff role required' (the role may
 * not manage events) and 'staff chapter required' (the account has no
 * chapter). Anything else is not a refusal the officer can act on.
 */
/** The RPC's 'event id already exists' refusal (22023), for a reused creation id. */
export function meetingAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message: unknown = Reflect.get(error, 'message');
  return Reflect.get(error, 'code') === '22023' && typeof message === 'string' && message.includes('meeting id already exists');
}

export function meetingRefusal(error: unknown): 'role' | 'chapter' | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = Reflect.get(error, 'code');
  const message: unknown = Reflect.get(error, 'message');
  if (code !== '42501') return null;
  if (typeof message === 'string' && message.includes('staff campaign required')) return 'chapter';
  return 'role';
}
