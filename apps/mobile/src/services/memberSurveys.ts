import { businessRpc } from './businessWriters';
import type { MobileSessionWriter } from './supabase';
// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
//: the native survey surface reads and answers the
// web-authored organization_surveys through the RPCs the web member surface
// uses (get_member_engagement_snapshot, save_/submit_organization_survey_
// session). The legacy member_surveys pulse reader and its
// submit_survey_response writer are retired from the native app.
import { getSupabaseClient } from './supabase';
import {
  classifyQuarterlyGate,
  normalizeMemberSurveySnapshot,
  normalizeQuarterlyGate,
  type MemberSurveySnapshot,
  type QuarterlyGate,
  type SurveyAnswers,
} from '../lib/memberSurveysShared';

export const MEMBER_SURVEY_RPC_NAMES = Object.freeze({
  snapshot: 'get_member_engagement_snapshot',
  save: 'save_organization_survey_session',
  submit: 'submit_organization_survey_session',
  quarterlyGate: 'get_quarterly_survey_gate',
});

async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

export async function loadMobileMemberSurveys(): Promise<MemberSurveySnapshot> {
  return normalizeMemberSurveySnapshot(await rpc(MEMBER_SURVEY_RPC_NAMES.snapshot));
}

// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001: the same server gate the
// web reads (organization switch, admin exemption, fail-open rules).
export async function loadMobileQuarterlySurveyGate(): Promise<QuarterlyGate> {
  return normalizeQuarterlyGate(await rpc(MEMBER_SURVEY_RPC_NAMES.quarterlyGate));
}

// REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002: the hard gate
// reads the raw answer so an empty or malformed one is a failed check.
export async function loadMobileQuarterlySurveyGateStatus(): Promise<ReturnType<typeof classifyQuarterlyGate>> {
  return classifyQuarterlyGate(await rpc(MEMBER_SURVEY_RPC_NAMES.quarterlyGate));
}

export async function saveMobileSurveySession(writer: MobileSessionWriter, surveyID: string, answers: SurveyAnswers): Promise<void> {
  await businessRpc(writer, MEMBER_SURVEY_RPC_NAMES.save, { p_survey_id: surveyID, p_answers: answers });
}

export async function submitMobileSurveySession(writer: MobileSessionWriter, surveyID: string, answers: SurveyAnswers): Promise<void> {
  await businessRpc(writer, MEMBER_SURVEY_RPC_NAMES.submit, { p_survey_id: surveyID, p_answers: answers });
}
