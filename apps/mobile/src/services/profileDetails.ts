import type { MobileSessionWriter } from './supabase';
import { getSupabaseClient } from './supabase';

// BUG-UG-NATIVE-IOS-ACCOUNT-HAS-NO-PHONE-NUMBER-FIELD-20261117 (#9084):
// the member's own profile details, read and saved through the same two
// self-scoped RPCs the website's Settings uses (src/lib/memberApi.js,
// getMyProfileDetails and setMyProfileDetails). Neither RPC takes a user id.
// The save replaces the whole row, so a phone change sends every other field
// back exactly as it was read; the workplace option lists are never sent.
export const PROFILE_DETAIL_VISIBILITIES = ['only_me', 'admins'] as const;
export type ProfileDetailVisibility = (typeof PROFILE_DETAIL_VISIBILITIES)[number];

// The phone rule the save is checked against. The server enforces it
// (set_my_profile_details: 7 to 40 characters of digits, spaces and + ( ) . -
// after trimming, else 'invalid phone number'); these copies only let the
// Account card say it before a save (#9467 M2-5), and
// ProfilePhoneCard.test.tsx fails if they ever differ from the migration.
export const PROFILE_PHONE_MIN_LENGTH = 7;
export const PROFILE_PHONE_MAX_LENGTH = 40;

export type MyProfileDetails = {
  pronouns: string | null;
  jobTitle: string | null;
  worksite: string | null;
  shift?: string | null;
  classification?: string | null;
  phone: string | null;
  detailsVisibility: ProfileDetailVisibility;
  phoneVisibility: ProfileDetailVisibility;
};

export class ProfileDetailsError extends Error {
  constructor(readonly reason: 'phone' | 'failed') {
    super(reason === 'phone' ? 'invalid phone number' : 'Profile details were not saved.');
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function visibility(value: unknown): ProfileDetailVisibility {
  return PROFILE_DETAIL_VISIBILITIES.includes(value as ProfileDetailVisibility) ? value as ProfileDetailVisibility : 'only_me';
}

export function profileDetailsFromRow(row: unknown): MyProfileDetails {
  const source = row && typeof row === 'object' ? row as Record<string, unknown> : {};
  return {
    pronouns: text(source.pronouns),
    jobTitle: text(source.jobTitle),
    worksite: text(source.worksite),
    ...(Object.hasOwn(source, 'shift') || Object.hasOwn(source, 'classification')
      ? { shift: text(source.shift), classification: text(source.classification) }
      : {}),
    phone: text(source.phone),
    detailsVisibility: visibility(source.detailsVisibility),
    phoneVisibility: visibility(source.phoneVisibility),
  };
}

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new ProfileDetailsError('failed');
  return supabase;
}

export async function loadMyProfileDetails(): Promise<MyProfileDetails> {
  const { data, error }: RpcAnswer = await client().rpc('get_my_profile_details');
  if (error || !data || typeof data !== 'object') throw new ProfileDetailsError('failed');
  return profileDetailsFromRow(data);
}

/** Saves a new phone number and its visibility, keeping every other detail as read. */
export async function saveMyProfilePhone(writer: MobileSessionWriter, current: MyProfileDetails, phone: string, phoneVisibility: ProfileDetailVisibility): Promise<MyProfileDetails> {
  const next: MyProfileDetails = { ...current, phone: text(phone), phoneVisibility: visibility(phoneVisibility) };
  const supabase = (await writer.client());
  const { data, error }: RpcAnswer = Object.hasOwn(next, 'shift') || Object.hasOwn(next, 'classification')
    ? await supabase.rpc('set_my_profile_details_v2', {
      p_details: {
        pronouns: next.pronouns,
        jobTitle: next.jobTitle,
        worksite: next.worksite,
        shift: next.shift ?? null,
        classification: next.classification ?? null,
        phone: next.phone,
        detailsVisibility: next.detailsVisibility,
        phoneVisibility: next.phoneVisibility,
      },
    })
    : await supabase.rpc('set_my_profile_details', {
      p_pronouns: next.pronouns,
      p_job_title: next.jobTitle,
      p_worksite: next.worksite,
      p_phone: next.phone,
      p_details_visibility: next.detailsVisibility,
      p_phone_visibility: next.phoneVisibility,
    });
  if (error) {
    // Only the server's phone-format refusal is about the phone, as on the website.
    const badPhone = error.code === '22023' && /invalid phone number/.test(error.message ?? '');
    throw new ProfileDetailsError(badPhone ? 'phone' : 'failed');
  }
  if (!data || typeof data !== 'object') throw new ProfileDetailsError('failed');
  return profileDetailsFromRow(data);
}
