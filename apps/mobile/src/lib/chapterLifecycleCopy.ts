import type { MobileHandshake } from '../services/supabase';

type ChapterLifecycleCopy = {
  title: string;
  subtitle: string;
  refresh: string;
  staleSuffix: string;
  refreshError: string;
  bindingTitle: string;
  bindingBody: string;
  bindingEmpty: string;
  bindingSearchLabel: string;
  bindingSearchPlaceholder: string;
  bindingSearch: string;
  bindingSearching: string;
  bindingResults: string;
  bindingSearchEmpty: string;
  bindingSearchFailed: string;
  bindingRequest: string;
  bindingRequesting: string;
  bindingRequested: string;
  bindingRequestError: string;
  status: Record<'requested' | 'verified' | 'rejected', string>;
  cancelRequest: string;
  startRequest: string;
  noPartnersTitle: string;
  noPartnersBody: string;
  partnerLabel: string;
  requestTitleLabel: string;
  requestTitleA11y: string;
  requestTitlePlaceholder: string;
  purposeLabel: string;
  purposeA11y: string;
  purposePlaceholder: string;
  dataBoundary: string;
  scopes: Record<MobileHandshake['dataScope'], string>;
  directions: Record<MobileHandshake['direction'], string>;
  agreementStates: Record<MobileHandshake['status'], string>;
  sending: string;
  send: string;
  loadingTitle: string;
  loadingBody: string;
  emptyTitle: string;
  emptyBody: string;
  requestError: string;
  transitionError: string;
  working: string;
  accept: string;
  decline: string;
  activate: string;
  close: string;
  cancel: string;
  confirmDeclineTitle(title: string): string;
  confirmCloseTitle(title: string): string;
  confirmDeclineBody: string;
  confirmCloseBody: string;
  confirmDecline: string;
  confirmClose: string;
  confirmAnnouncement(action: 'decline' | 'close', title: string): string;
  documentTitle: string;
  documentBody: string;
  documentEmpty: string;
  documentSelected(title: string): string;
  shareDocument: string;
  sharingDocument: string;
  documentShared: string;
  documentError: string;
};

export const chapterLifecycleCopy: Record<'en' | 'es', ChapterLifecycleCopy> = {
  en: {
    title: 'Campaign agreements',
    subtitle: 'Requests become active only after authorized signatures from both campaigns. No worker data is exchanged.',
    refresh: 'Refresh',
    staleSuffix: ' Showing the last confirmed requests.',
    refreshError: 'Partnership requests could not be refreshed through this campaign.',
    bindingTitle: 'Union organization binding',
    bindingBody: 'A campaign admin requests the real organization record. Union Ground confirms that the campaign is that union office before sister-campaign requests open; your organization\'s administrators cannot verify it.',
    bindingEmpty: 'No binding has been requested for this campaign.',
    bindingSearchLabel: 'Find the real union organization',
    bindingSearchPlaceholder: 'Union, local number, or city',
    bindingSearch: 'Search organizations',
    bindingSearching: 'Searching…',
    bindingResults: 'Matching organizations',
    bindingSearchEmpty: 'No union organization matches that search.',
    bindingSearchFailed: 'The search could not be completed. Try again.',
    bindingRequest: 'Request binding review',
    bindingRequesting: 'Requesting…',
    bindingRequested: 'Binding review requested.',
    bindingRequestError: 'The binding request was not confirmed. Refresh your admin authorization and try again.',
    status: { requested: 'Requested', verified: 'Verified', rejected: 'Rejected' },
    cancelRequest: 'Cancel new request',
    startRequest: 'Start agreement request',
    noPartnersTitle: 'No verified sister campaigns',
    noPartnersBody: 'An organization-wide administrator must verify both real campaign bindings before a two-sided request can be sent.',
    partnerLabel: 'Verified sister campaign',
    requestTitleLabel: 'Request title',
    requestTitleA11y: 'Agreement request title',
    requestTitlePlaceholder: 'Shared training library',
    purposeLabel: 'Purpose',
    purposeA11y: 'Agreement request purpose',
    purposePlaceholder: 'What both campaigns will do together',
    dataBoundary: 'Data boundary',
    scopes: { docs_only: 'Published documents only', no_member_data: 'No worker data', aggregate_only: 'Privacy-safe totals only' },
    directions: { incoming: 'Incoming', outgoing: 'Outgoing' },
    agreementStates: { draft: 'Draft', requested: 'Requested', accepted: 'Accepted', active: 'Active', declined: 'Declined', closed: 'Closed' },
    sending: 'Sending…',
    send: 'Send two-sided request',
    loadingTitle: 'Loading requests',
    loadingBody: 'Checking both participating campaign scopes.',
    emptyTitle: 'No partnership requests',
    emptyBody: 'Only a verified, onboarded sister campaign can receive a two-sided request.',
    requestError: 'The partnership request was not confirmed.',
    transitionError: 'The request was not changed.',
    working: 'Working…',
    accept: 'Accept request',
    decline: 'Decline',
    activate: 'Countersign and activate',
    close: 'Close request',
    cancel: 'Cancel',
    confirmDeclineTitle: (title) => `Decline “${title}”?`,
    confirmCloseTitle: (title) => `Close “${title}”?`,
    confirmDeclineBody: 'The requesting campaign will see that this request was declined.',
    confirmCloseBody: 'Both campaigns will keep the audit history, but no further exchange can occur.',
    confirmDecline: 'Confirm decline',
    confirmClose: 'Confirm close',
    confirmAnnouncement: (action, title) => `${action === 'decline' ? 'Decline' : 'Close'} ${title}? Confirmation required.`,
    documentTitle: 'Published document exchange',
    documentBody: 'Choose one published campaign document, then share it only through an active documents-only agreement.',
    documentEmpty: 'No published campaign document is available to share.',
    documentSelected: (title) => `Selected document: ${title}`,
    shareDocument: 'Share selected document',
    sharingDocument: 'Sharing…',
    documentShared: 'Document shared through the active agreement.',
    documentError: 'The document was not shared. Refresh the agreement and document status.',
  },
  es: {
    title: 'Acuerdos entre campañas',
    subtitle: 'Las solicitudes se activan solo después de las firmas autorizadas de ambas campañas. No se intercambian datos de trabajadores.',
    refresh: 'Actualizar',
    staleSuffix: ' Se muestran las últimas solicitudes confirmadas.',
    refreshError: 'No se pudieron actualizar las solicitudes de alianza de esta campaña.',
    bindingTitle: 'Vínculo con la organización sindical',
    bindingBody: 'Un administrador de la campaña solicita el registro real. Union Ground confirma que la campaña es esa oficina sindical antes de habilitar solicitudes; los administradores de su organización no pueden verificarlo.',
    bindingEmpty: 'No se ha solicitado un vínculo para esta campaña.',
    bindingSearchLabel: 'Buscar la organización sindical real',
    bindingSearchPlaceholder: 'Sindicato, número de local o ciudad',
    bindingSearch: 'Buscar organizaciones',
    bindingSearching: 'Buscando…',
    bindingResults: 'Organizaciones coincidentes',
    bindingSearchEmpty: 'Ninguna organización sindical coincide con esa búsqueda.',
    bindingSearchFailed: 'No se pudo completar la búsqueda. Inténtelo de nuevo.',
    bindingRequest: 'Solicitar revisión del vínculo',
    bindingRequesting: 'Solicitando…',
    bindingRequested: 'Se solicitó la revisión del vínculo.',
    bindingRequestError: 'No se confirmó la solicitud del vínculo. Actualice su autorización e inténtelo de nuevo.',
    status: { requested: 'Solicitado', verified: 'Verificado', rejected: 'Rechazado' },
    cancelRequest: 'Cancelar nueva solicitud',
    startRequest: 'Iniciar acuerdo',
    noPartnersTitle: 'No hay campañas hermanas verificadas',
    noPartnersBody: 'Union Ground debe confirmar los vínculos de ambos campañas con su oficina sindical antes de enviar una solicitud bilateral.',
    partnerLabel: 'Campaña hermana verificada',
    requestTitleLabel: 'Título de la solicitud',
    requestTitleA11y: 'Título de la solicitud de acuerdo',
    requestTitlePlaceholder: 'Biblioteca compartida de capacitación',
    purposeLabel: 'Propósito',
    purposeA11y: 'Propósito de la solicitud de acuerdo',
    purposePlaceholder: 'Lo que harán juntas ambas campañas',
    dataBoundary: 'Límite de datos',
    scopes: { docs_only: 'Solo documentos publicados', no_member_data: 'Sin datos de trabajadores', aggregate_only: 'Solo totales que protegen la privacidad' },
    directions: { incoming: 'Recibido', outgoing: 'Enviado' },
    agreementStates: { draft: 'Borrador', requested: 'Solicitado', accepted: 'Aceptado', active: 'Activo', declined: 'Rechazado', closed: 'Cerrado' },
    sending: 'Enviando…',
    send: 'Enviar solicitud bilateral',
    loadingTitle: 'Cargando solicitudes',
    loadingBody: 'Comprobando el alcance de ambas campañas participantes.',
    emptyTitle: 'No hay solicitudes de alianza',
    emptyBody: 'Solo una campaña hermana verificada e incorporada puede recibir una solicitud bilateral.',
    requestError: 'No se confirmó la solicitud de alianza.',
    transitionError: 'No se cambió la solicitud.',
    working: 'Procesando…',
    accept: 'Aceptar solicitud',
    decline: 'Rechazar',
    activate: 'Contrafirmar y activar',
    close: 'Cerrar solicitud',
    cancel: 'Cancelar',
    confirmDeclineTitle: (title) => `¿Rechazar “${title}”?`,
    confirmCloseTitle: (title) => `¿Cerrar “${title}”?`,
    confirmDeclineBody: 'La campaña solicitante verá que la solicitud fue rechazada.',
    confirmCloseBody: 'Ambas campañas conservarán el historial de auditoría, pero no podrá haber más intercambios.',
    confirmDecline: 'Confirmar rechazo',
    confirmClose: 'Confirmar cierre',
    confirmAnnouncement: (action, title) => `¿${action === 'decline' ? 'Rechazar' : 'Cerrar'} ${title}? Se requiere confirmación.`,
    documentTitle: 'Intercambio de documentos publicados',
    documentBody: 'Elija un documento publicado y compártalo solo mediante un acuerdo activo limitado a documentos.',
    documentEmpty: 'No hay ningún documento publicado disponible para compartir.',
    documentSelected: (title) => `Documento seleccionado: ${title}`,
    shareDocument: 'Compartir documento seleccionado',
    sharingDocument: 'Compartiendo…',
    documentShared: 'Documento compartido mediante el acuerdo activo.',
    documentError: 'No se compartió el documento. Actualice el estado del acuerdo y del documento.',
  },
};
