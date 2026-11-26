const en = {
  title: "Union Ground updates", notice: "Receive Union Ground product updates in your organization's workspace. Members can hide these updates. Union Ground sees your organization's follow status, not member lists or reading activity. Your administrator can stop following at any time.",
  empty: "No product updates to show.", hidden: "Product updates are hidden for you.", refresh: "Refresh updates", older: "Older updates", newest: "Newest updates",
  backgrounded: "Updates are hidden while this window is in the background.",
  hide: "Hide these updates", undo: "Show these updates", loading: "Loading updates…", unavailable: "Updates are unavailable. Refresh to try again.", expired: "Refresh to check for current updates.",
  settings: "Organization product updates", following: "Your organization is following product updates.", stopped: "Your organization is not following product updates.",
  follow: "Follow product updates", revoke: "Stop following", confirm: "Stop following for everyone in your organization? Previous updates will no longer be available and new deliveries will stop.",
  yes: "Stop following for everyone", cancel: "Cancel", saved: "Preference saved.", publisher: "Publish product updates", draft: "New update", titleEn: "English title", titleEs: "Spanish title", bodyEn: "English body", bodyEs: "Spanish body", expires: "Expires", save: "Save draft", review: "Review", publish: "Publish", withdraw: "Withdraw", edit: "Edit draft", correct: "Create correction",
  reviewNotice: "I reviewed both languages. This contains product information only, with no member, case, grievance or private-message information.",
  posts: "Editorial workspace", audit: "Publishing audit", moreAudit: "Older audit events", followers: "Organization follow status", moreFollowers: "More organizations", morePosts: "More posts", noPosts: "No posts yet.",
  draftState: "Draft", reviewedState: "Reviewed", publishedState: "Published", withdrawnState: "Withdrawn", active: "Following", revoked: "Not following", hideLocal: "Hide for this organization",
};
const es = {
  title: "Novedades de Union Ground", notice: "Recibe novedades del producto Union Ground en el espacio de trabajo de tu organización. Cada persona puede ocultarlas. Union Ground ve si tu organización sigue las novedades, no las listas de miembros ni su actividad de lectura. Tu administrador puede dejar de seguirlas en cualquier momento.",
  empty: "No hay novedades del producto.", hidden: "Has ocultado las novedades del producto.", refresh: "Actualizar novedades", older: "Novedades anteriores", newest: "Novedades recientes",
  backgrounded: "Las novedades se ocultan mientras esta ventana está en segundo plano.",
  hide: "Ocultar estas novedades", undo: "Mostrar estas novedades", loading: "Cargando novedades…", unavailable: "Las novedades no están disponibles. Actualiza para volver a intentar.", expired: "Actualiza para consultar las novedades actuales.",
  settings: "Novedades para la organización", following: "Tu organización sigue las novedades del producto.", stopped: "Tu organización no sigue las novedades del producto.",
  follow: "Seguir las novedades del producto", revoke: "Dejar de seguir", confirm: "¿Dejar de seguir para toda la organización? Las novedades anteriores ya no estarán disponibles y no se recibirán nuevas entregas.",
  yes: "Dejar de seguir para todos", cancel: "Cancelar", saved: "Preferencia guardada.", publisher: "Publicar novedades del producto", draft: "Nueva novedad", titleEn: "Título en inglés", titleEs: "Título en español", bodyEn: "Texto en inglés", bodyEs: "Texto en español", expires: "Vence", save: "Guardar borrador", review: "Revisar", publish: "Publicar", withdraw: "Retirar", edit: "Editar borrador", correct: "Crear corrección",
  reviewNotice: "He revisado ambos idiomas. Solo contiene información del producto, sin información sobre miembros, casos, agravios ni mensajes privados.",
  posts: "Espacio editorial", audit: "Historial de publicación", moreAudit: "Eventos anteriores", followers: "Estado de seguimiento de organizaciones", moreFollowers: "Más organizaciones", morePosts: "Más publicaciones", noPosts: "Aún no hay publicaciones.",
  draftState: "Borrador", reviewedState: "Revisado", publishedState: "Publicado", withdrawnState: "Retirado", active: "Sigue novedades", revoked: "No sigue novedades", hideLocal: "Ocultar para esta organización",
};
export const announcementCopy = locale => locale === "es" ? es : en;
// Record #9465 (W7-26): a hide that did not save is not "updates are unavailable".
en.saveFailed = "Your choice was not saved. Try again.";
es.saveFailed = "No se guardó tu elección. Vuelve a intentarlo.";
// #9469: a Follow whose answer and re-read were both lost.
en.followUnconfirmed = "We could not confirm whether your choice was saved. Check the follow status before you try again.";
es.followUnconfirmed = "No pudimos confirmar si se guardó tu elección. Revisa el estado de seguimiento antes de volver a intentarlo.";
en.checkFollow = "Check follow status";
es.checkFollow = "Revisar el estado de seguimiento";
