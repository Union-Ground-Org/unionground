// Typed seam over the pay-only MI1 engine. Native screens never import the
// web JSX desk or any other MI1 domain.

import { statusStateForLabel, type StatusState } from '../theme/statusRamp';
import { nativeUiText, type NativeUiText } from './nativeUiCopy';

export {
  PAY_PERSISTENCE_CONTRACT,
  PAY_VIEW_STATES,
  authorizePay,
  calculatePay,
  createMemoryPayCatalog,
  createPayRpcAdapter,
  createPayTools,
  presentCalculation,
  presentCatalog,
  presentLoading,
  presentRetry,
} from '../../../../src/features/pay/index.js';

export const PAY_NATIVE_PERSISTENCE = Object.freeze({
  payCatalog: true,
  requiresSecureSession: true,
});

export type NativeOrganizationActor = {
  userId: string | null;
  organizationId: string | null;
  chapterId: string | null;
  roles: string[];
  selectedHat: string | null;
  membershipStatus: 'active' | 'revoked';
  organizationStatus: 'active' | 'suspended' | 'archived';
  mfaSatisfied: boolean;
  authenticated: boolean;
};

export function nativeOrganizationId(value: string | null = null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function buildNativePayActor(input: {
  userId?: string | null;
  organizationId?: string | null;
  chapterId?: string | null;
  roles?: readonly string[];
  selectedHat?: string | null;
  authenticated?: boolean;
  mfaSatisfied?: boolean;
} = {}): NativeOrganizationActor {
  return {
    userId: input.userId ?? null,
    organizationId: nativeOrganizationId(input.organizationId ?? null),
    chapterId: input.chapterId ?? null,
    roles: [...(input.roles ?? [])],
    selectedHat: input.selectedHat ?? null,
    membershipStatus: 'active',
    organizationStatus: 'active',
    mfaSatisfied: Boolean(input.mfaSatisfied),
    authenticated: Boolean(input.authenticated),
  };
}

export function toPayActor(actor: NativeOrganizationActor) {
  return {
    userId: actor.userId,
    selectedOrganizationId: actor.organizationId,
    roles: actor.roles,
    membershipStatus: actor.membershipStatus,
    mfaSatisfied: actor.mfaSatisfied,
  };
}

// The ramp state each pay machine state wears on its status pill.
//
// `StatusPill` derives the dot hue from its label when no `state` is passed,
// and the ramp's word lists are the *record* vocabulary ("resolved", "overdue",
// "queued"). No pay state appears in them, so every pay pill fell through to
// the 'active' default: a validation failure, a wrong-organization read and a
// finished estimate all carried the same aubergine dot, and "Retry" — the one
// pill that asks the member to do something — looked exactly like the ones that
// do not. The mapping is an explicit table rather than more word-list guesswork
// because this vocabulary is closed: `PAY_VIEW_STATES`, plus the catalog card's
// 'ready' and the publish form's 'error'.
const PAY_STATUS_PILL_STATES: Readonly<Record<string, StatusState | undefined>> = Object.freeze({
  // In flight is literally what the ramp calls active/in-progress.
  loading: 'active',
  // Settled and asking for nothing: the catalog is loaded, or the estimate came
  // back. Muted ink leaves the figures below it as the loudest thing in the card.
  ready: 'done',
  success: 'done',
  // Nothing published for this organization yet — unstarted, not failed.
  empty: 'queued',
  // Everything a member has to act on: fix the fields, switch organization,
  // re-authorize, or tap "Try again".
  validation: 'attention',
  unauthorized: 'attention',
  wrong_organization: 'attention',
  retry: 'attention',
  error: 'attention',
});

/**
 * The status-ramp state for a pay presentation's machine state. Presentations
 * cross an untyped boundary from the shared engine, so anything outside the
 * closed vocabulary keeps the label rule the pill already applied.
 */
export function payStatusPillState(state: string): StatusState {
  return PAY_STATUS_PILL_STATES[state.trim().toLowerCase()] ?? statusStateForLabel(state);
}

// The same closed vocabulary, as member copy. The pill only raises the first
// character, so a raw key reached the member as "Wrong_organization" or
// "Validation". Anything outside the table is shown as words.
const PAY_STATUS_PILL_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({
  loading: 'Loading',
  ready: 'Ready',
  success: 'Done',
  empty: 'Nothing published',
  validation: 'Check entries',
  unauthorized: 'Not permitted',
  wrong_organization: 'Wrong organization',
  retry: 'Catalog unavailable',
  error: 'Not completed',
});

/** Member copy for a pay presentation's machine state. */
export function payStatusPillLabel(state: string): string {
  const known = PAY_STATUS_PILL_LABELS[state.trim().toLowerCase()];
  if (known) return known;
  const words = state.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Updated';
}

/**
 * The member's language for the spoken outcome (#9502): the screen passes its
 * useNativeUi() copy. The engine's messages are app-owned English sentences,
 * so they are looked up in the same catalogue as the screen; one it lacks is
 * spoken as written.
 */
export type PayAnnouncementCopy = { t: NativeUiText; catalogLabel: (label: string) => string };
const ENGLISH_PAY_COPY: PayAnnouncementCopy = { t: nativeUiText('en'), catalogLabel: (label) => label };

export function describePayCalculationForAccessibility(presentation: any, copy: PayAnnouncementCopy = ENGLISH_PAY_COPY): string {
  if (presentation?.state === 'success') {
    return copy.t('Pay estimate. Gross owed {gross}. Wage underpayment {underpayment}. Back pay {backPay}.', { gross: presentation.grossOwed, underpayment: presentation.underpayment, backPay: presentation.backPay });
  }
  return presentation?.message ? copy.catalogLabel(presentation.message) : copy.t('Pay estimate updated.');
}

export function describePayComparisonForAccessibility(presentation: any, copy: PayAnnouncementCopy = ENGLISH_PAY_COPY): string {
  if (presentation?.state === 'success') {
    return copy.t('Pay-scale comparison. Hourly difference {hourly}. Annual difference {annual}. Per-paycheck difference {perCheck}.', { hourly: presentation.hourlyDelta, annual: presentation.annualDelta, perCheck: presentation.perCheckDelta });
  }
  return presentation?.message ? copy.catalogLabel(presentation.message) : copy.t('Pay-scale comparison updated.');
}
