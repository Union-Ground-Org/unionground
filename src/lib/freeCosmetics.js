// Shared catalog vocabulary and RPC adapter: no client grants, points or money.
/** @typedef {'theme' | 'badge' | 'icon'} CosmeticKind */
/** @typedef {{ key: string, kind: CosmeticKind, labelEn: string, labelEs: string, earned: boolean, selected: boolean | null }} CosmeticItem */
/** @typedef {{ id: string, userId: string, itemKey: string, grantedBy: string | null, source: string, reason: string, createdAt: string, memberName: string | null }} CosmeticAward */
/** @typedef {{ organizationId: string, canGrant: boolean, items: CosmeticItem[], history: CosmeticAward[], recipients: { id: string, name: string }[] }} CosmeticWorkspace */
/** @typedef {{ rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown, error: unknown }> }} CosmeticRpcClient */
/**
 * @typedef {object} FreeCosmeticsApi
 * @property {(search?: string) => Promise<CosmeticWorkspace>} load
 * @property {(userId: string, itemKey: string, reason: string) => Promise<string>} grant
 * @property {(kind: CosmeticKind, itemKey: string | null) => Promise<void>} select
 */
// The server retired the only theme cosmetic (Union green only, Nov 3, 2026),
// so no theme key is offered.
/** @type {Readonly<Record<Exclude<CosmeticKind, 'theme'>, string>>} */
export const COSMETIC_KEYS = Object.freeze({ badge: 'learning-spark', icon: 'golden-mark' });
/** @type {{ en: Record<string, string>, es: Record<string, string> }} */
export const cosmeticCopy = {
  en: {
    title: 'Free cosmetics', intro: 'Themes, badges and app icons. Always free, with no points, purchases or change to app access.',
    milestone: 'Complete a Know your rights checklist to earn Learning Spark. Your administrator can grant any cosmetic from day one.',
    loading: 'Loading cosmetics…', unavailable: 'Cosmetics could not be refreshed.', retry: 'Try again',
    apply: 'Apply', remove: 'Remove', earned: 'Earned', locked: 'Not earned yet', selected: 'Applied',
    grant: 'Grant cosmetic', member: 'Member', item: 'Cosmetic', reason: 'Reason', search: 'Find a member',
    recipientHelp: 'Up to 100 matching members. Search by name to narrow the list.',
    choose: 'Choose a member', history: 'Award history · latest 100', empty: 'No cosmetic awards yet.',
    failed: 'The change could not be confirmed. Try again; a repeated grant does not create a second award.',
    saved: 'Change saved.', busy: 'Saving…', granted: 'Award confirmed.', admin: 'Grant a free cosmetic',
    iconWeb: 'App icons apply in the iOS or Android app. This website keeps its own icon.',
    iconUnsupported: 'This build cannot change the launcher icon. Your earned icon remains available for a supported build.',
    iconFailed: 'The launcher icon could not be changed. Retry to match the saved selection.',
    badge: 'Learning Spark badge', checklist: 'Know your rights checklist completed',
    theme: 'Theme', icon: 'App icon', badgeKind: 'Badge', searchAction: 'Search',
  },
  es: {
    title: 'Artículos cosméticos gratuitos', intro: 'Temas, insignias e iconos. Siempre gratis, sin puntos, compras ni cambios al acceso a la aplicación.',
    milestone: 'Completa una lista de Conoce tus derechos para ganar Chispa de aprendizaje. Tu administrador puede otorgar cualquier artículo desde el primer día.',
    loading: 'Cargando artículos…', unavailable: 'No se pudieron actualizar los artículos.', retry: 'Reintentar',
    apply: 'Aplicar', remove: 'Quitar', earned: 'Obtenido', locked: 'Aún no obtenido', selected: 'Aplicado',
    grant: 'Otorgar artículo', member: 'Miembro', item: 'Artículo', reason: 'Motivo', search: 'Buscar un miembro',
    recipientHelp: 'Hasta 100 miembros coincidentes. Busca por nombre para reducir la lista.',
    choose: 'Elige un miembro', history: 'Historial · últimos 100 premios', empty: 'Todavía no hay premios cosméticos.',
    failed: 'No se pudo confirmar el cambio. Reintenta; repetir un premio no crea otro.',
    saved: 'Cambio guardado.', busy: 'Guardando…', granted: 'Premio confirmado.', admin: 'Otorgar un artículo gratuito',
    iconWeb: 'Los iconos se aplican en la aplicación iOS o Android. Este sitio conserva su propio icono.',
    iconUnsupported: 'Esta versión no puede cambiar el icono de inicio. Tu icono obtenido sigue disponible para una versión compatible.',
    iconFailed: 'No se pudo cambiar el icono de inicio. Reintenta para aplicar la selección guardada.',
    badge: 'Insignia Chispa de aprendizaje', checklist: 'Lista de Conoce tus derechos completada',
    theme: 'Tema', icon: 'Icono', badgeKind: 'Insignia', searchAction: 'Buscar',
  },
};

/** @param {string} language */
export function cosmeticCopyFor(language) {
  return cosmeticCopy[language === 'es' ? 'es' : 'en'];
}

/**
 * @param {CosmeticRpcClient} client
 * @param {string} organizationId
 * @returns {FreeCosmeticsApi}
 */
export function createFreeCosmeticsApi(client, organizationId) {
  async function unwrap(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }
  return {
    load: async (search = '') => /** @type {CosmeticWorkspace} */ (await unwrap(client.rpc('get_free_cosmetics', { p_organization_id: organizationId, p_search: search }))),
    grant: async (userId, itemKey, reason) => /** @type {string} */ (await unwrap(client.rpc('grant_free_cosmetic', { p_organization_id: organizationId, p_user_id: userId, p_item_key: itemKey, p_reason: reason.trim() }))),
    select: async (kind, itemKey) => /** @type {void} */ (await unwrap(client.rpc('set_free_cosmetic', { p_organization_id: organizationId, p_kind: kind, p_item_key: itemKey }))),
  };
}

/**
 * @param {CosmeticWorkspace | null} workspace
 * @param {CosmeticKind} kind
 * @returns {string | null}
 */
export function selectedCosmetic(workspace, kind) {
  return workspace?.items?.find((item) => item.kind === kind && item.earned && item.selected)?.key ?? null;
}
