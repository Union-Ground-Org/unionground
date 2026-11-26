import type { ChapterVerificationFailure } from '../services/chapterVerification';
import type { MobileChapterRole, MobileConnectionOutcome } from './chapterAdministration';

type MembershipCopy = {
  title: string;
  subtitle: string;
  loadingTitle: string;
  loadingBody: string;
  scopeError: string;
  retryScope: string;
  deniedTitle: string;
  deniedBody: string;
  previewBody: string;
  searchLabel: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  searchError: string;
  searchTooShort: string;
  staleDirectory: string;
  refreshFailed: string;
  refresh: string;
  resultsFor(query: string): string;
  membersTruncated: string;
  loadMore: string;
  loadingMore: string;
  directoryLimit: string;
  chapterScopeBoundary: string;
  memberLabel: string;
  membersEmpty: string;
  chapterLabel: string;
  chaptersEmpty: string;
  memberContext(chapter: string, roles: string): string;
  noHomeChapter: string;
  noRoles: string;
  grantMembership: string;
  revokeMembership: string;
  confirmRevokeTitle(name: string): string;
  confirmRevokeBody: string;
  confirmRevoke: string;
  cancel: string;
  working: string;
  membershipGranted(name: string): string;
  membershipRevoked(name: string): string;
  membershipError: string;
  membershipUnconfirmed(name: string): string;
  roleLabel: string;
  unitLabel: string;
  unitHelp: string;
  unitsLoading: string;
  unitsUnavailable: string;
  noUnits: string;
  reloadUnits: string;
  legacyCoverage: string;
  roleBoundary: string;
  roleNames: Record<MobileChapterRole, string>;
  unscopedVpLabel: string;
  grantRole: string;
  revokeRole: string;
  roleGranted(name: string): string;
  roleRevoked(name: string): string;
  roleError: string;
  roleUnconfirmed(name: string): string;
  // Audit MOB-ADMIN-08: a role change states its scope and effect, then confirms.
  confirmRoleTitle(name: string, role: string, granting: boolean): string;
  confirmRoleBody(role: string, granting: boolean): string;
};

type VerificationCopy = {
  connectionTitle: string;
  connectionBody: string;
  noteLabel: string;
  notePlaceholder: string;
  mark: Record<MobileConnectionOutcome, string>;
  verifying: string;
  connectionVerified: string;
  failure: Record<ChapterVerificationFailure, string>;
};

export const chapterMembershipCopy: Record<'en' | 'es', MembershipCopy> = {
  en: {
    title: 'Campaign memberships',
    subtitle: 'Hold one person in more than one campaign. Every change here is one audited action against the campaign you name.',
    loadingTitle: 'Checking your administrator scope',
    loadingBody: 'Reading the campaigns you are authorized to administer before showing any control.',
    scopeError: 'Your administrator scope could not be confirmed through this campaign.',
    retryScope: 'Try again',
    deniedTitle: 'Campaign memberships opens under Admin',
    deniedBody: 'Membership changes belong to a campaign administrator in their own campaign, or to an organization administrator anywhere in the organization.',
    previewBody: 'Campaign memberships open on an authorized session. This version doesn\'t include a worker directory.',
    searchLabel: 'Find a worker by name',
    searchPlaceholder: 'Worker name',
    search: 'Search workers',
    searching: 'Searching…',
    searchError: 'The worker directory could not be searched through your current authorization.',
    searchTooShort: 'Type at least two characters, or search with an empty field for the first page.',
    staleDirectory: 'The change was recorded, but this list could not be re-read. Search again to see the current memberships.',
    refreshFailed: 'This list could not be re-read. Search again to see the current memberships before acting.',
    refresh: 'Refresh',
    resultsFor: (query) => (query ? `Results for “${query}”. Press Search to look up the name you are typing.` : 'Results for the first page. Press Search to look up the name you are typing.'),
    membersTruncated: 'More workers match than this page holds. Load the next page, or type more of the name.',
    loadMore: 'Load more workers',
    loadingMore: 'Loading more…',
    directoryLimit: 'That is as far as this list goes in one search. Type more of the name to reach the person you mean.',
    chapterScopeBoundary: 'Your scope is one campaign, so this directory lists the people already in it. Adding someone from another campaign is an organization administrator’s action.',
    memberLabel: 'Worker',
    membersEmpty: 'No worker matched that search.',
    chapterLabel: 'Campaign',
    chaptersEmpty: 'No campaign is inside your administrator scope.',
    memberContext: (chapter, roles) => `Home campaign ${chapter} · roles ${roles}`,
    noHomeChapter: 'not recorded',
    noRoles: 'none',
    grantMembership: 'Grant membership',
    revokeMembership: 'Revoke membership',
    confirmRoleTitle: (name, role, granting) => granting ? `Grant ${role} to ${name}?` : `Remove ${role} from ${name}?`,
    confirmRoleBody: (role, granting) => granting
      ? `They get the ${role} role in this campaign as soon as you confirm. Their other campaigns are untouched. You can remove it here.`
      : `They lose the ${role} role in this campaign as soon as you confirm. Their other campaigns are untouched.`,
    confirmRevokeTitle: (name) => `Revoke ${name} from this campaign?`,
    confirmRevokeBody: 'Their campaign roles here end with the membership. Their other campaigns are untouched.',
    confirmRevoke: 'Revoke membership',
    cancel: 'Cancel',
    working: 'Working…',
    membershipGranted: (name) => `Membership granted for ${name}. The audit log names you as the actor.`,
    membershipRevoked: (name) => `Membership revoked for ${name}. The audit log names you as the actor.`,
    membershipError: 'That membership change was refused. Confirm your administrator scope over this campaign.',
    membershipUnconfirmed: (name) => `The membership change for ${name} was not confirmed. It may or may not have been recorded. Check the current memberships below before acting again.`,
    roleLabel: 'Campaign role',
    unitLabel: 'Committee unit',
    unitHelp: 'Choose a unit explicitly. The choice permanently replaces earlier whole-campaign coverage.',
    unitsLoading: 'Checking campaign units…',
    unitsUnavailable: 'Campaign units or current committee member coverage could not be confirmed.',
    noUnits: 'No units are available in this campaign.',
    reloadUnits: 'Reload campaign units',
    legacyCoverage: 'All units, kept from before units were required',
    roleBoundary: 'A role applies only inside the campaign named above, and only while the membership is active. Campaign lead access covers every unit, chapter-wide notices and campaign settings; a display title grants no access.',
    roleNames: {
      steward: 'Committee',
      coordinator: 'Campaign lead',
      advisor: 'Advisor',
      admin: 'Administrator',
      vp: 'Campaign chair',
    },
    unscopedVpLabel: 'Campaign chair',
    grantRole: 'Grant role',
    revokeRole: 'Remove role',
    roleGranted: (name) => `Role granted to ${name} in this campaign.`,
    roleRevoked: (name) => `Role removed from ${name} in this campaign.`,
    roleError: 'That role change was refused. The worker needs an active membership in this campaign first.',
    roleUnconfirmed: (name) => `The role change for ${name} was not confirmed. It may or may not have been recorded. Check the current roles below before acting again.`,
  },
  es: {
    title: 'Membresías de campaña',
    subtitle: 'Una persona puede pertenecer a más de una campaña. Cada cambio aquí es una acción auditada sobre la campaña que usted nombra.',
    loadingTitle: 'Verificando su alcance de administración',
    loadingBody: 'Leyendo las campañas que usted puede administrar antes de mostrar cualquier control.',
    scopeError: 'No se pudo confirmar su alcance de administración en esta campaña.',
    retryScope: 'Reintentar',
    deniedTitle: 'Membresías de campaña se abre como Administrador',
    deniedBody: 'Los cambios de membresía corresponden a la administración de la campaña dentro de su propia campaña, o a la administración de la organización en toda la organización.',
    previewBody: 'Las membresías de campaña se abren en una sesión autorizada. Esta vista previa no tiene directorio de trabajadores y aquí no se inventa ninguno.',
    searchLabel: 'Buscar a un trabajador por nombre',
    searchPlaceholder: 'Nombre del trabajador',
    search: 'Buscar trabajadores',
    searching: 'Buscando…',
    searchError: 'No se pudo buscar en el directorio con su autorización actual.',
    searchTooShort: 'Escriba al menos dos caracteres, o busque con el campo vacío para ver la primera página.',
    staleDirectory: 'El cambio quedó registrado, pero no se pudo volver a leer esta lista. Busque de nuevo para ver las membresías actuales.',
    refreshFailed: 'No se pudo volver a leer esta lista. Busque de nuevo para ver las membresías actuales antes de actuar.',
    refresh: 'Actualizar',
    resultsFor: (query) => (query ? `Resultados para “${query}”. Pulse Buscar para buscar el nombre que está escribiendo.` : 'Resultados de la primera página. Pulse Buscar para buscar el nombre que está escribiendo.'),
    membersTruncated: 'Hay más trabajadores que coinciden de los que cabe en esta página. Cargue la página siguiente o escriba más del nombre.',
    loadMore: 'Cargar más trabajadores',
    loadingMore: 'Cargando más…',
    directoryLimit: 'Hasta aquí llega esta lista en una sola búsqueda. Escriba más del nombre para llegar a la persona que busca.',
    chapterScopeBoundary: 'Su alcance es una sola campaña, por eso este directorio muestra a las personas que ya están en ella. Agregar a alguien de otra campaña corresponde a la administración de la organización.',
    memberLabel: 'Trabajador',
    membersEmpty: 'Ningún trabajador coincide con esa búsqueda.',
    chapterLabel: 'Campaña',
    chaptersEmpty: 'Ninguna campaña está dentro de su alcance de administración.',
    memberContext: (chapter, roles) => `Campaña base ${chapter} · funciones ${roles}`,
    noHomeChapter: 'sin registrar',
    noRoles: 'ninguna',
    grantMembership: 'Otorgar membresía',
    revokeMembership: 'Revocar membresía',
    confirmRoleTitle: (name, role, granting) => granting ? `¿Otorgar ${role} a ${name}?` : `¿Quitar ${role} a ${name}?`,
    confirmRoleBody: (role, granting) => granting
      ? `Obtiene la función ${role} en esta campaña en cuanto confirmes. Sus otras campañas no cambian. Puedes quitarla aquí.`
      : `Pierde la función ${role} en esta campaña en cuanto confirmes. Sus otras campañas no cambian.`,
    confirmRevokeTitle: (name) => `¿Revocar a ${name} de esta campaña?`,
    confirmRevokeBody: 'Sus funciones en esta campaña terminan junto con la membresía. Sus otras campañas no cambian.',
    confirmRevoke: 'Revocar membresía',
    cancel: 'Cancelar',
    working: 'Procesando…',
    membershipGranted: (name) => `Membresía otorgada a ${name}. El registro de auditoría lo nombra a usted.`,
    membershipRevoked: (name) => `Membresía revocada a ${name}. El registro de auditoría lo nombra a usted.`,
    membershipError: 'Se rechazó ese cambio de membresía. Confirme su alcance de administración sobre esta campaña.',
    membershipUnconfirmed: (name) => `No se confirmó el cambio de membresía de ${name}. Puede o no haber quedado registrado. Revise las membresías actuales abajo antes de actuar de nuevo.`,
    roleLabel: 'Función en la campaña',
    unitLabel: 'Unidad del integrante del comité',
    unitHelp: 'Elige una unidad expresamente. La elección reemplaza de forma permanente el acceso anterior a todo la campaña.',
    unitsLoading: 'Comprobando las unidades de la campaña…',
    unitsUnavailable: 'No se pudieron confirmar las unidades o el acceso actual del integrante del comité.',
    noUnits: 'No hay unidades disponibles en esta campaña.',
    reloadUnits: 'Volver a cargar las unidades',
    legacyCoverage: 'Todas las unidades, conservado desde antes de que se exigieran unidades',
    roleBoundary: 'Una función aplica solo dentro de la campaña nombrada arriba y solo mientras la membresía esté activa.',
    roleNames: {
      steward: 'Comité',
      coordinator: 'Líder de campaña',
      advisor: 'Asesor',
      admin: 'Administrador',
      vp: 'Presidencia de campaña',
    },
    unscopedVpLabel: 'Presidencia',
    grantRole: 'Otorgar función',
    revokeRole: 'Quitar función',
    roleGranted: (name) => `Función otorgada a ${name} en esta campaña.`,
    roleRevoked: (name) => `Función retirada a ${name} en esta campaña.`,
    roleError: 'Se rechazó ese cambio de función. El trabajador necesita primero una membresía activa en esta campaña.',
    roleUnconfirmed: (name) => `No se confirmó el cambio de función de ${name}. Puede o no haber quedado registrado. Revise las funciones actuales abajo antes de actuar de nuevo.`,
  },
};

// Chapter membership rows already carry separate chapter and organization
// grants. Keep both labels when both apply; legacy unscoped rows retain their
// wording rather than guessing that an organization grant is chapter access.
export function chapterMembershipRoleLabels(entry: {
  roles: readonly string[];
  chapterRoles?: readonly string[];
  organizationRoles?: readonly string[];
}): string[] {
  return entry.roles.flatMap((role) => {
    if (role !== 'vp') {
      const names: Partial<Record<string, string>> = chapterMembershipCopy.en.roleNames;
      return [names[role] ?? role.charAt(0).toUpperCase() + role.slice(1)];
    }
    const chapterLead = entry.chapterRoles?.includes('vp') === true;
    const organizationVp = entry.organizationRoles?.includes('vp') === true;
    return [
      ...(chapterLead ? ['Campaign lead'] : []),
      ...(organizationVp || !chapterLead ? ['Campaign chair'] : []),
    ];
  });
}

export const chapterVerificationCopy: Record<'en' | 'es', VerificationCopy> = {
  en: {
    connectionTitle: 'Operator verification',
    connectionBody: 'Record what the campaign-owned provider actually does. No credential is entered here.',
    noteLabel: 'Public note (optional)',
    notePlaceholder: 'What the campaign and its workers will read',
    mark: { active: 'Mark active', error: 'Mark error', disabled: 'Mark disabled' },
    verifying: 'Recording…',
    connectionVerified: 'Connection outcome recorded with your name.',
    failure: {
      'session-expired': 'Your session expired before the decision was recorded. Sign in again.',
      'not-permitted': 'This decision needs an organization-wide administrator over that campaign.',
      'request-changed': 'The request changed before your decision landed. Refresh and read it again.',
      'outcome-unconfirmed': 'The verification service did not confirm this decision. It may or may not have been recorded. Re-read the request and decide against its current state.',
    },
  },
  es: {
    connectionTitle: 'Verificación del operador',
    connectionBody: 'Registre lo que realmente hace el proveedor de la campaña. Aquí no se ingresa ninguna credencial.',
    noteLabel: 'Nota pública (opcional)',
    notePlaceholder: 'Lo que leerán la campaña y sus trabajadores',
    mark: { active: 'Marcar activo', error: 'Marcar con error', disabled: 'Marcar desactivado' },
    verifying: 'Registrando…',
    connectionVerified: 'Resultado de la conexión registrado con su nombre.',
    failure: {
      'session-expired': 'Su sesión expiró antes de registrar la decisión. Inicie sesión de nuevo.',
      'not-permitted': 'Esta decisión requiere administración de toda la organización sobre esa campaña.',
      'request-changed': 'La solicitud cambió antes de registrar su decisión. Actualice y léala otra vez.',
      'outcome-unconfirmed': 'El servicio de verificación no confirmó esta decisión. Puede o no haber quedado registrada. Vuelva a leer la solicitud y decida sobre su estado actual.',
    },
  },
};
