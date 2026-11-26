import type { MobileSessionWriter } from './supabase';
// BUG-UG-NATIVE-IOS-APPOINTMENTS-NO-HOURS-OR-BOOKING-20261117 (#9082):
// the phone writes booking hours and books time through the same RPCs the
// website calls (src/lib/memberApi.js setAppointmentWindows,
// setAppointmentSchedule, getBookableStewards, getAppointmentSlots and
// bookAppointment). Role, chapter, MFA and slot rules stay in those RPCs.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppointmentDuration, AppointmentSlot, AppointmentType, AppointmentWindow } from '../lib/appointmentBooking';
import { getSupabaseClient } from './supabase';

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  return client;
}

type RpcFailure = { code?: string; message?: string } | null;

/** Only the weekday and the two minutes go to the server, as the website sends them. */
export async function saveMobileAppointmentWindows(writer: MobileSessionWriter, windows: readonly AppointmentWindow[]): Promise<void> {
  const { error } = await (await writer.client()).rpc('set_appointment_windows', {
    p_windows: windows.map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute })),
  });
  if (error) throw error;
}

/** Changes only whether members can book; every other schedule field is sent as null, which the RPC keeps. */
export async function saveMobileAppointmentAccepting(writer: MobileSessionWriter, accepting: boolean): Promise<void> {
  const { error } = await (await writer.client()).rpc('set_appointment_schedule', {
    p_timezone: null,
    p_min_notice_minutes: null,
    p_buffer_before_minutes: null,
    p_buffer_after_minutes: null,
    p_max_per_day: null,
    p_accepting: accepting,
  });
  if (error) throw error;
}

export type MobileBookableSteward = { id: string; name: string };

export async function loadMobileBookableStewards(): Promise<MobileBookableSteward[]> {
  const { data, error } = await requireClient().rpc('get_bookable_stewards');
  if (error) throw error;
  return (Array.isArray(data) ? data as Record<string, unknown>[] : [])
    .filter((row) => typeof row.id === 'string' && row.id)
    .map((row) => ({ id: String(row.id), name: typeof row.name === 'string' && row.name.trim() ? row.name : 'Campaign committee member' }));
}

export async function loadMobileAppointmentSlots(input: {
  type: AppointmentType;
  duration: AppointmentDuration;
  from: string;
  to: string;
  stewardId: string | null;
}): Promise<AppointmentSlot[]> {
  const { data, error } = await requireClient().rpc('get_appointment_slots', {
    p_type: input.type,
    p_duration: input.duration,
    p_from: input.from,
    p_to: input.to,
    p_steward: input.stewardId,
  });
  if (error) throw error;
  const slots = (data as { slots?: unknown } | null)?.slots;
  return (Array.isArray(slots) ? slots as Record<string, unknown>[] : [])
    .filter((slot) => typeof slot.startsAt === 'string')
    .map((slot) => ({ startsAt: String(slot.startsAt), stewardCount: Number(slot.stewardCount ?? 1) }));
}

export async function bookMobileAppointment(writer: MobileSessionWriter, input: {
  type: AppointmentType;
  duration: AppointmentDuration;
  startsAt: string;
  place: string;
  stewardId: string | null;
}): Promise<void> {
  const { error } = await (await writer.client()).rpc('book_appointment', {
    p_type: input.type,
    p_duration: input.duration,
    p_starts_at: input.startsAt,
    p_place: input.place.trim(),
    p_steward: input.stewardId,
    p_reason: 'general',
  });
  if (error) throw error;
}

/** 42501 is the RPCs' "not allowed for this account" refusal. */
export function isPermissionRefusal(error: unknown): boolean {
  return (error as RpcFailure)?.code === '42501';
}
