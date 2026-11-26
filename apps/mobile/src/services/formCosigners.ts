// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): alliance grievance co-signers on the phone, through the website's
// own calls (src/lib/memberApi.js inviteCosigner, respondToCosign,
// withdrawCosign, cosignInvitePreview, and its member_form_cosigners read).
// Every write is a security-definer RPC; invite_cosigner answers the same way
// whether or not the email belongs to a member. Before accepting, an invitee
// sees only the preview's one-line summary and the filer's name; accepting
// opens the full grievance, declining and withdrawing close it again.
import { signatureIsSendable, type SignatureStrokes } from '../lib/signatureStrokes';
import { FormActionError, pinMemberSession, type FormAnswers } from './memberForms';
import { createCapturedSessionRpcClient } from './supabase';

type Row = Record<string, unknown>;

export type CosignerStatus = 'invited' | 'accepted' | 'declined' | 'reaffirm_needed' | 'withdrawn';
// A co-signer on one of the member's own forms, as the filer sees it.
export type FormCosigner = { id: string; email: string; status: CosignerStatus; invitedAt: string };
// An invitation to the member to co-sign someone else's grievance.
export type CosignRequest = {
  formID: string;
  status: 'invited' | 'reaffirm_needed' | 'accepted';
  summary: string;
  filerName: string;
  // The version of the grievance this preview was taken from (#8730, the
  // website's #8703). Opaque; never shown. An accept sends it back so the
  // co-signature covers only what the preview showed. Null when the server
  // issued none (before 20261113122700).
  reviewDigest: string | null;
  // The preview did not load, or its reply was not one the server sends
  // (gate stage 185 on #8738, r1s1): the request is shown with a retry and is
  // never answered, so no accept can go without the digest a preview issued.
  previewUnavailable: boolean;
  // The full grievance, readable only once the member has accepted.
  // status: the grievance's own status. Once it is approved the server takes
  // no withdrawal (withdraw_cosign), so none is offered (gate stage 169, r3s1).
  grievance: { templateKey: string; templateVersion: number; answers: FormAnswers; status: string } | null;
};
export type Cosigning = { cosigners: Record<string, FormCosigner[]>; requests: CosignRequest[] };

// The digest cosign_invite_preview issues: 64 lowercase hex characters.
const REVIEW_DIGEST = /^[0-9a-f]{64}$/;

const STATUSES: ReadonlySet<string> = new Set(['invited', 'accepted', 'declined', 'reaffirm_needed', 'withdrawn']);
const OPEN_REQUEST_STATUSES: ReadonlySet<string> = new Set(['invited', 'reaffirm_needed', 'accepted']);
// The website's own check before invite_cosigner (FormsView COSIGN_EMAIL_RE,
// forms.cosign.invalidEmail): the trimmed, lower-cased address it sends.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalCosignerEmail(email: string): string | null {
  const normal = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(normal) && normal.length <= 320 ? normal : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function answersFrom(value: unknown): FormAnswers {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
  const answers: FormAnswers = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'string' || typeof item === 'boolean') answers[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) answers[key] = String(item);
    else if (Array.isArray(item)) answers[key] = item.filter((entry): entry is string => typeof entry === 'string');
  }
  return answers;
}

// The member's co-signing: the co-signers on their own forms (ownFormIDs) and
// their open invitations. Rows the member's RLS returns for both are split as
// the website splits them.
export async function loadCosigning(ownerID: string, ownFormIDs: ReadonlySet<string>): Promise<Cosigning> {
  const { session, fence } = await pinMemberSession(ownerID);
  const rpcClient = createCapturedSessionRpcClient(session.session);
  const rows: { data: unknown; error: unknown } = await rpcClient.from('member_form_cosigners')
    .select('id,form_id,invited_email,cosigner_user_id,status,invited_at').order('invited_at', { ascending: false }).limit(200);
  await fence();
  if (rows.error || !Array.isArray(rows.data)) throw new FormActionError('unavailable');
  const email = text(session.session.user.email).toLowerCase();
  const cosigners: Record<string, FormCosigner[]> = {};
  const invites: Row[] = [];
  for (const row of rows.data as Row[]) {
    const formID = text(row.form_id);
    const status = text(row.status);
    if (!formID || !STATUSES.has(status)) continue;
    if (ownFormIDs.has(formID)) {
      (cosigners[formID] ??= []).push({ id: text(row.id), email: text(row.invited_email), status: status as CosignerStatus, invitedAt: text(row.invited_at) });
    } else if ((row.cosigner_user_id === ownerID || (email && text(row.invited_email).toLowerCase() === email)) && OPEN_REQUEST_STATUSES.has(status)) {
      invites.push(row);
    }
  }
  const previews = await Promise.all(invites.map((row) => rpcClient.rpc('cosign_invite_preview', { p_form_id: text(row.form_id) })));
  await fence();
  const acceptedIDs = invites.filter((row) => row.status === 'accepted').map((row) => text(row.form_id));
  const grievances = new Map<string, Row>();
  if (acceptedIDs.length) {
    // An accepted co-signer's own RLS reads that grievance, and only it.
    const read: { data: unknown; error: unknown } = await rpcClient.from('member_forms')
      .select('id,template_key,template_version,answers,status').in('id', acceptedIDs).limit(acceptedIDs.length);
    await fence();
    if (!read.error && Array.isArray(read.data)) for (const row of read.data as Row[]) grievances.set(text(row.id), row);
  }
  const requests = invites.map((row, index): CosignRequest => {
    // Only a preview the server answered counts. A failed read (a timeout,
    // a 503) or a reply of another shape is unavailable, never a request with
    // no digest: the no-digest accept is only for a preview that loaded and
    // issued none, from a server before 20261113122700.
    const preview: { data?: unknown; error?: unknown } | undefined = previews[index];
    const loaded = preview && !preview.error && preview.data && typeof preview.data === 'object' && !Array.isArray(preview.data) ? preview.data as Row : null;
    const digest = loaded?.reviewDigest;
    const digestShown = digest === undefined || digest === null || (typeof digest === 'string' && REVIEW_DIGEST.test(digest));
    const shown = loaded && digestShown ? loaded : null;
    const grievance = grievances.get(text(row.form_id));
    return {
      formID: text(row.form_id),
      status: row.status as CosignRequest['status'],
      summary: text(shown?.summary),
      filerName: text(shown?.filerName),
      reviewDigest: shown && typeof digest === 'string' ? digest : null,
      previewUnavailable: shown === null,
      grievance: grievance ? {
        templateKey: text(grievance.template_key),
        templateVersion: typeof grievance.template_version === 'number' ? grievance.template_version : 1,
        status: text(grievance.status),
        answers: answersFrom(grievance.answers),
      } : null,
    };
  });
  return { cosigners, requests };
}

// A definite answer from the server, worded for the member, as opposed to a
// request that never got an answer (gate stage 169: a refusal is never shown
// as a connection problem). The reasons follow the server's own refusals in
// invite_cosigner, respond_to_cosign and withdraw_cosign
// (20260812222529_form_filing_concurrency.sql).
export class CosignRefusal extends Error {
  readonly reason: 'self' | 'answered' | 'limit' | 'not-eligible' | 'not-open' | 'not-withdrawable' | 'refused';
  constructor(reason: CosignRefusal['reason']) {
    super(reason);
    this.reason = reason;
  }
}

const REFUSALS: [RegExp, CosignRefusal['reason']][] = [
  [/cannot invite yourself/, 'self'],
  [/answered already/, 'answered'],
  [/co-signer limit/, 'limit'],
  [/not eligible for co-signers/, 'not-eligible'],
  [/no pending co-sign invitation/, 'not-open'],
  [/no withdrawable co-signature/, 'not-withdrawable'],
];

// respond_to_cosign refused an accept because the filer changed the grievance
// after the preview the co-signer was shown (PT409, details
// cosign_changed_since_preview). Nothing was stored, and the same accept is
// never sent again: the co-signer reads the current preview first.
export class CosignChangedSincePreview extends Error {
  constructor() {
    super('cosign-changed-since-preview');
    this.name = 'CosignChangedSincePreview';
  }
}

async function write(ownerID: string, name: string, args: Row): Promise<void> {
  const { session, fence } = await pinMemberSession(ownerID);
  const result: { error: unknown } = await createCapturedSessionRpcClient(session.session).rpc(name, args);
  await fence();
  if (!result.error) return;
  const error = result.error && typeof result.error === 'object' ? result.error as Row : {};
  // PostgREST answers a raised exception with its SQLSTATE; a request that
  // never reached the database carries none.
  if (error.code === 'PT409' && text(error.details).trim() === 'cosign_changed_since_preview') throw new CosignChangedSincePreview();
  if (error.code === '22023') {
    const message = text(error.message);
    throw new CosignRefusal(REFUSALS.find(([pattern]) => pattern.test(message))?.[1] ?? 'refused');
  }
  throw new FormActionError('failed');
}

// The reply is the same whether or not the email is a member's.
export async function inviteCosigner(formID: string, email: string, ownerID: string): Promise<void> {
  const normal = normalCosignerEmail(email);
  if (!normal) throw new FormActionError('failed');
  await write(ownerID, 'invite_cosigner', { p_form_id: formID, p_email: normal });
}

// Accepting needs the member's own drawn signature and consent; declining
// sends neither. An accept names the preview it was shown (reviewDigest,
// #8730): the server compares it under the form lock. A digest exists only
// when the server's own preview issued one, so the server compares it: an
// issued digest is always sent and never dropped on a retry, since a
// PGRST202 then means a stale schema cache, not a missing function (gate
// stage 173 on #8729). With no digest issued the accept goes as before.
// Arguments are named: positionally the fifth is p_typed_name.
export async function respondToCosign(formID: string, accept: boolean, strokes: SignatureStrokes | null, ownerID: string, reviewDigest: string | null = null): Promise<void> {
  if (accept && (!strokes || !signatureIsSendable(strokes))) throw new FormActionError('signature-required');
  await write(ownerID, 'respond_to_cosign', {
    p_form_id: formID,
    p_accept: accept,
    p_strokes: accept ? strokes : null,
    p_consent: accept,
    ...(accept && reviewDigest ? { p_expected_digest: reviewDigest } : {}),
  });
}

export async function withdrawCosign(formID: string, ownerID: string): Promise<void> {
  await write(ownerID, 'withdraw_cosign', { p_form_id: formID });
}
