// Typed seam over the CR-018 Q&A engine. Native screens never import the
// web JSX desks or invent an organization.

export { qaCountKey, qaFailureText, qaText, qaStatusLabel } from '../../../../src/features/qa/copy.js';
export { qaLengthHint, qaLengthMet } from '../../../../src/features/qa/lengthRule.js';
export {
  canAcceptQaAnswer,
  canAskQaQuestion,
  canOfficialReplyOnQa,
  canSeeOfficerQaQueue,
  requireActiveQaMember,
} from '../../../../src/features/qa/authorization.js';
export { createQaRpcAdapter, isMissingQaRpcError } from '../../../../src/features/qa/adapter.js';
export {
  QA_MAX_BODY_LENGTH,
  QA_MAX_SEARCH_LENGTH,
  QA_MAX_TITLE_LENGTH,
  QA_MIN_BODY_LENGTH,
  QA_MIN_TITLE_LENGTH,
  QA_RPC,
  QA_SORTS,
} from '../../../../src/features/qa/contract.js';

export const MI1_QA_NATIVE_PERSISTENCE = Object.freeze({
  qaRpc: true,
});

export type NativeQaActor = {
  userId: string | null;
  organizationId: string | null;
  chapterId: string | null;
  roles: string[];
  organizationRoles: string[];
  chapterRoles: string[];
  selectedHat: string | null;
  membershipStatus: 'active' | 'revoked';
  organizationStatus: 'active' | 'suspended' | 'archived';
  mfaSatisfied: boolean;
  authenticated: boolean;
};

export function nativeOrganizationId(value?: string | null): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function buildNativeQaActor(input: {
  userId?: string | null;
  organizationId?: string | null;
  chapterId?: string | null;
  roles?: readonly string[];
  organizationRoles?: readonly string[];
  chapterRoles?: readonly string[];
  selectedHat?: string | null;
  authenticated?: boolean;
  mfaSatisfied?: boolean;
} = {}): NativeQaActor {
  return {
    userId: input.userId ?? null,
    organizationId: nativeOrganizationId(input.organizationId),
    chapterId: input.chapterId ?? null,
    roles: [...(input.roles ?? [])],
    organizationRoles: [...(input.organizationRoles ?? [])],
    chapterRoles: [...(input.chapterRoles ?? [])],
    selectedHat: input.selectedHat ?? null,
    membershipStatus: 'active',
    organizationStatus: 'active',
    mfaSatisfied: Boolean(input.mfaSatisfied),
    authenticated: Boolean(input.authenticated),
  };
}

export function toQaActor(actor: NativeQaActor) {
  return {
    userId: actor.userId,
    organizationId: actor.organizationId,
    chapterId: actor.chapterId,
    organizationRoles: actor.organizationRoles,
    chapterRoles: actor.chapterRoles,
    membershipStatus: actor.membershipStatus,
    organizationStatus: actor.organizationStatus,
    mfaSatisfied: actor.mfaSatisfied,
  };
}

export type MemberQaPreviewCopy = {
  title: string;
  body: string;
};

export function memberQaPreviewState(language: 'en' | 'es'): MemberQaPreviewCopy {
  return language === 'es'
    ? {
      title: 'Vista previa de preguntas',
      body: 'Esta vista previa no carga preguntas guardadas.',
    }
    : {
      title: 'Questions preview',
      body: 'This preview does not load saved questions.',
    };
}
