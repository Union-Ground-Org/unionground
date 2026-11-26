// Metro watches the shared feature tree. This seam imports no web JSX, DOM,
// storage, or network client: both native platforms use the web's exact math.
import { rankConnections as sharedRank, collectPublishedProfiles as sharedCollect, normalizePublishedProfile } from '../../../../src/features/connectionSuggestions/engine.js';
import { DEFAULT_CONNECTION_SETTINGS, CONNECTION_ISSUE_TOPICS, CONNECTION_SECTORS, organizationConnectionWeights as sharedOrganizationWeights } from '../../../../src/features/connectionSuggestions/contract.js';
import { connectionCopy } from '../../../../src/lib/i18n/connectionSuggestions.js';

export { CONNECTION_WEIGHT_KEYS, CONNECTION_SIGNAL_KINDS, CONNECTION_ISSUE_TOPICS, CONNECTION_SECTORS } from '../../../../src/features/connectionSuggestions/contract.js';
export { proposeConnectionIssueTags, aggregateConfirmedConnectionSignals } from '../../../../src/features/connectionSuggestions/signals.js';
export { connectionDateMs } from '../../../../src/features/connectionSuggestions/time.js';
export { createConnectionPreview } from '../../../../src/features/connectionSuggestions/preview.js';
export { matchingProfile } from '../../../../src/features/connectionSuggestions/adapter.js';
export { isConnectionHandshakeReceipt, connectionHandshakeOutcome } from '../../../../src/features/connectionSuggestions/contract.js';

export type ConnectionWeight = 'location' | 'sector' | 'issues' | 'expertise' | 'local' | 'union';
export type ConnectionWeights = Record<ConnectionWeight, number>;
export type ConnectionSettings = {
  weights: ConnectionWeights;
  locationScale: 'metro' | 'state' | 'country';
  reach: 'anywhere' | 'same-country' | 'same-state';
  diversity: number;
  freshnessDays: number | null;
};
export type ConnectionProfile = {
  id: string; kind: 'chapter' | 'local'; displayName: string; discoverable: boolean;
  location: { country: string | null; state: string | null; metro: string | null };
  sectorKeys: string[]; issuePriorities: Array<{ key: string; strength: number }>;
  assistanceNeeds: Array<{ key: string; strength: number }>; expertiseOffered: string[];
  localKey: string | null; unionFamilyKey: string | null; publishedAt: string | null; profileRevision: number | null;
  handshake?: { eligible: boolean; partnerOrgId: string | null };
  identityProvenance?: { localKey: 'declared' | 'verified' | null; unionFamilyKey: 'declared' | 'verified' | null };
};
export type ConnectionMatch = ConnectionProfile & {
  score: number; coverage: number; diversityPenalty: number; missingDimensions: ConnectionWeight[];
  contributions: Array<{ dimension: ConnectionWeight; weight: number; similarity: number | null; contribution: number; available: boolean }>;
};
export type ConnectionRanking = {
  state: string; reason: string | null; results: ConnectionMatch[];
  scannedCount: number; eligibleCount: number; disabledDimensions: ConnectionWeight[];
};
export type ConnectionDraft = {
  kind: 'chapter' | 'local'; location: { country: string; state: string; metro: string };
  sectorKeys: string[]; expertiseOffered: string[]; declaredIssueKeys: string[];
  shareAnalyzedIssues: boolean; declaredLocalKey: string | null; declaredUnionFamilyKey: string | null;
};
export type ConnectionActor = {
  userId: string | null; organizationId: string | null; chapterId: string | null;
  selectedHat: string; organizationRoles: readonly string[]; chapterRoles: readonly string[];
  membershipStatus: string; mfaSatisfied: boolean;
};
export type ConnectionWorkspace = {
  organizationId: string; chapterId: string | null; chapterName: string;
  profile: ConnectionProfile | null; draft: ConnectionDraft | null; canPublish: boolean;
  canRequestHandshake: boolean;
  hiddenChapterIds: string[];
  analysis: { nextPeriodKey: string | null; nextPeriodFrozen: boolean; latest: { topics: Array<{ key: string }> } | null };
};
export type ConnectionData = { workspace: ConnectionWorkspace; profiles: ConnectionProfile[] };
export type ConnectionSourceKind = 'grievance' | 'survey' | 'feedback';
type ConnectionAbortSignal = { readonly aborted: boolean; throwIfAborted: () => void };

// React Native's installed abort-controller polyfill has `aborted`, but no
// browser throwIfAborted method. Adapt without mutating the global/polyfill.
export function connectionAbortSignal(signal: Pick<AbortSignal, 'aborted'>): ConnectionAbortSignal {
  return {
    get aborted() { return signal.aborted; },
    throwIfAborted() { if (signal.aborted) throw Object.assign(new Error('Connection read aborted'), { name: 'AbortError' }); },
  };
}

// JavaScript's empty-array defaults infer never[] under the native strict TS
// project. These boundary signatures describe the shared runtime contract.
export const collectPublishedProfiles = sharedCollect as (
  fetchPage: (request: { afterId: string | null; snapshotToken: string | null; limit: number; signal?: ConnectionAbortSignal }) => Promise<Record<string, unknown>>,
  options: { signal?: ConnectionAbortSignal; pageSize?: number },
) => Promise<{ profiles: ConnectionProfile[]; snapshotToken: string; complete: true }>;
// The imported JS entry point accepts an options object; the native wrapper
// below supplies its fully typed profile/settings arguments.
const rankShared = sharedRank as (input: object) => ConnectionRanking;

export const CONNECTION_PRESETS: Readonly<Record<string, ConnectionWeights>> = {
  balanced: { location: 20, sector: 20, issues: 25, expertise: 20, local: 10, union: 5 },
  nearby: { location: 50, sector: 15, issues: 15, expertise: 10, local: 5, union: 5 },
  problems: { location: 5, sector: 15, issues: 55, expertise: 20, local: 0, union: 5 },
  mentors: { location: 10, sector: 15, issues: 20, expertise: 50, local: 0, union: 5 },
};

// Inventory B13: the organization's default matching weights from the
// member-safe switches map, or null to keep the balanced preset.
export const organizationConnectionWeights = sharedOrganizationWeights as (configuration: unknown) => ConnectionWeights | null;

export function initialConnectionSettings(): ConnectionSettings {
  return { ...DEFAULT_CONNECTION_SETTINGS, weights: { ...CONNECTION_PRESETS.balanced! } } as ConnectionSettings;
}

export function connectionScopeKey(actor: ConnectionActor, mode: string): string {
  return JSON.stringify([mode, actor.userId, actor.organizationId, actor.chapterId, actor.selectedHat,
    [...actor.organizationRoles].sort(), [...actor.chapterRoles].sort(), actor.membershipStatus, actor.mfaSatisfied]);
}

export function canReadConnections(actor: ConnectionActor): boolean {
  return Boolean(actor.userId && actor.organizationId && actor.membershipStatus === 'active' && actor.mfaSatisfied
    && ['steward', 'coordinator', 'advisor', 'admin', 'vp'].includes(actor.selectedHat)
    && [...actor.organizationRoles, ...actor.chapterRoles].includes(actor.selectedHat));
}

export function normalizeConnectionProfile(value: unknown): ConnectionProfile | null {
  return normalizePublishedProfile(value) as ConnectionProfile | null;
}

export function rankNativeConnections(data: ConnectionData, settings: ConnectionSettings, now: number, limit = 12): ConnectionRanking | null {
  if (!data.workspace.profile) return null;
  return rankShared({ source: data.workspace.profile, candidates: data.profiles, settings,
    blockedIds: data.workspace.hiddenChapterIds, now, limit });
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const keys = (value: unknown, allowed: readonly string[]): string[] => [...new Set((Array.isArray(value) ? value : []).filter((key): key is string => typeof key === 'string' && allowed.includes(key)))];

// Only explicit declared priorities enter the editor; analyzed priorities must
// never silently become declarations when someone republishes a profile.
export function connectionDraft(value: unknown): ConnectionDraft {
  const input = object(value);
  const place = object(input.location);
  return {
    kind: input.kind === 'local' ? 'local' : 'chapter',
    location: { country: str(place.country).trim().toUpperCase(), state: str(place.state).trim().toUpperCase(), metro: str(place.metro) },
    sectorKeys: keys(input.sectorKeys, CONNECTION_SECTORS).slice(0, 5),
    expertiseOffered: keys(input.expertiseOffered, CONNECTION_ISSUE_TOPICS),
    declaredIssueKeys: keys(input.declaredIssueKeys, CONNECTION_ISSUE_TOPICS),
    shareAnalyzedIssues: input.shareAnalyzedIssues === true,
    declaredLocalKey: str(input.declaredLocalKey) || null,
    declaredUnionFamilyKey: str(input.declaredUnionFamilyKey) || null,
  };
}

export function validConnectionDraft(value: ConnectionDraft): boolean {
  return /^[A-Z]{2}$/.test(value.location.country)
    && (!value.location.state || /^[A-Z]{2,3}$/.test(value.location.state))
    && (!value.location.metro || (/^[A-Z]{2,3}$/.test(value.location.state) && value.location.metro.trim().length >= 2 && value.location.metro.length <= 80))
    && value.sectorKeys.length <= 5;
}

export function validConnectionSourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export function adjustConnectionDial(value: number, direction: 'increment' | 'decrement', step = 1): number {
  return Math.max(0, Math.min(100, value + (direction === 'increment' ? step : -step)));
}

const nativeCopy = {
  en: { connectionsTab: 'Connections', increase: 'Increase', decrease: 'Decrease', checked: 'Selected', notChecked: 'Not selected',
    requestHandshake: 'Request agreement', handshakeTitle: 'Agreement title', handshakePurpose: 'Purpose',
    handshakeBoundary: 'Data boundary', docs_only: 'Published documents only', no_member_data: 'No worker data', aggregate_only: 'Privacy-safe totals only',
    handshakeConsent: 'Both campaigns must approve before a partnership activates. No worker records are shared.',
    handshakeSend: 'Send two-sided request', handshakeError: 'The request was not confirmed. Check the partner and your current authorization, then retry.',
    handshakeSent: 'Agreement requested. Follow its signatures and status in Campaign agreements.',
    handshakeDeclined: 'Your earlier agreement request was declined. Review it in Campaign agreements.',
    handshakeClosed: 'Your earlier agreement request was closed. Review it in Campaign agreements.',
    handshakePreview: 'Preview request only. No organization is contacted.', handshakePreviewSent: 'Preview request prepared. No organization was contacted.',
    openHandshakes: 'Open campaign agreements', browseConnections: 'Find sister campaigns', closeConnections: 'Back to campaign agreements',
    handshakeUnavailable: 'This campaign has no verified sister-campaign destination yet.',
    refreshAfterWriteError: 'The change was saved, but suggestions could not be refreshed. Try again.',
    showMore: 'Show more connections',
    staffRole: 'Staff role', steward: 'Committee', coordinator: 'Campaign lead', advisor: 'Advisor', admin: 'Administrator', vp: 'Campaign chair',
    localAnalysis: 'Text stays in this app view and is cleared after saving or leaving the app. The local English keyword helper proposes tags; review context and negation before confirming. You can select tags manually in any language.',
    tuneOpen: 'Adjust suggestions', hide: 'Hide campaign', hidden: 'Campaign hidden.', hideError: 'The campaign could not be hidden.',
    unhide: 'Show hidden campaigns again', unhidden: 'Hidden campaigns restored.', unhideError: 'Some campaigns could not be restored. Try again.',
    collapse: 'Collapse', expand: 'Expand',
    previewReadOnly: 'Fictional preview', reviewSourceInvalid: 'Paste the record’s full ID: 36 characters, from the record’s page.',
    reviewConsentRequired: 'Tick the confirmation above to save the review.', proposeNeedsText: 'Paste or type the text to analyze first.',
    tuningHelp: 'Swipe up or down to change by one. The buttons change by five.', },
  es: { connectionsTab: 'Conexiones', increase: 'Aumentar', decrease: 'Reducir', checked: 'Seleccionado', notChecked: 'Sin seleccionar',
    requestHandshake: 'Solicitar acuerdo', handshakeTitle: 'Título del acuerdo', handshakePurpose: 'Propósito',
    handshakeBoundary: 'Límite de datos', docs_only: 'Solo documentos publicados', no_member_data: 'Sin datos de trabajadores', aggregate_only: 'Solo totales que protegen la privacidad',
    handshakeConsent: 'Ambas campañas deben aprobar antes de activar la alianza. No se comparten registros de trabajadores.',
    handshakeSend: 'Enviar solicitud bilateral', handshakeError: 'No se confirmó la solicitud. Verifica la campaña hermana y tu autorización actual e inténtalo de nuevo.',
    handshakeSent: 'Acuerdo solicitado. Consulta las firmas y el estado en Acuerdos entre campañas.',
    handshakeDeclined: 'Tu solicitud anterior de acuerdo fue rechazada. Revísala en Acuerdos entre campañas.',
    handshakeClosed: 'Tu solicitud anterior de acuerdo fue cerrada. Revísala en Acuerdos entre campañas.',
    handshakePreview: 'Solicitud de demostración. No se contacta a ninguna organización.', handshakePreviewSent: 'Solicitud de demostración preparada. No se contactó a ninguna organización.',
    openHandshakes: 'Abrir acuerdos entre campañas', browseConnections: 'Buscar campañas hermanas', closeConnections: 'Volver a los acuerdos entre campañas',
    handshakeUnavailable: 'Esta campaña aún no tiene un destino de campaña hermana verificado.',
    refreshAfterWriteError: 'El cambio se guardó, pero no se pudieron actualizar las sugerencias. Reintenta.',
    showMore: 'Mostrar más conexiones',
    staffRole: 'Rol de personal', steward: 'Comité', coordinator: 'Líder de campaña', advisor: 'Asesor', admin: 'Administrador', vp: 'Presidencia de campaña',
    localAnalysis: 'El texto permanece en esta vista de la aplicación y se borra al guardar o salir. El asistente local reconoce palabras en inglés; revisa el contexto y las negaciones. Puedes seleccionar etiquetas manualmente en cualquier idioma.',
    tuneOpen: 'Ajustar sugerencias', hide: 'Ocultar campaña', hidden: 'Campaña ocultada.', hideError: 'No se pudo ocultar la campaña.',
    unhide: 'Mostrar campañas ocultas', unhidden: 'Campañas restauradas.', unhideError: 'No se pudieron restaurar todos. Reintenta.',
    collapse: 'Contraer', expand: 'Expandir',
    previewReadOnly: 'Vista ficticia', reviewSourceInvalid: 'Pega el ID completo del registro: 36 caracteres, de la página del registro.',
    reviewConsentRequired: 'Marca la confirmación de arriba para guardar la revisión.', proposeNeedsText: 'Primero pega o escribe el texto que se analizará.',
    tuningHelp: 'Desliza arriba o abajo para cambiar de uno en uno. Los botones cambian de cinco en cinco.', },
};
export function nativeConnectionCopy(language: 'en' | 'es'): (key: string) => string {
  const copy = nativeCopy[language] as Record<string, string>;
  const shared = connectionCopy(language);
  return (key) => copy[key] || shared(key);
}
