export const notificationCopy = {
  en: {
    title: 'Private notifications',
    privateBody: 'Notification previews never include sensitive issue details.',
    reconnectBody: 'Reconnect this phone to restore private notifications.',
    registeredApple: 'Registered with Apple push. Previews never include sensitive issue details.',
    registeredAndroid: 'Registered with Android push. Previews never include sensitive issue details.',
    enable: 'Enable', reconnect: 'Reconnect', disable: 'Disable', working: 'Working…',
    enabledTitle: 'Notifications enabled',
    enabledBody: 'This phone is registered. Notification previews remain private.',
    unavailableTitle: 'Notifications unavailable',
    unavailableBody: 'Check notification permission and your connection, then try again.',
    disabledTitle: 'Notifications disabled',
    disabledBody: 'This phone will no longer receive notifications.',
    disableFailedTitle: 'Could not disable notifications',
    disableFailedBody: 'Check your connection and try again.',
  },
  es: {
    title: 'Notificaciones privadas',
    privateBody: 'Las vistas previas nunca incluyen detalles confidenciales de asuntos.',
    reconnectBody: 'Vuelve a conectar este teléfono para restaurar las notificaciones privadas.',
    registeredApple: 'Registrado con Apple Push. Las vistas previas nunca incluyen detalles confidenciales de asuntos.',
    registeredAndroid: 'Registrado con Android Push. Las vistas previas nunca incluyen detalles confidenciales de asuntos.',
    enable: 'Activar', reconnect: 'Reconectar', disable: 'Desactivar', working: 'Procesando…',
    enabledTitle: 'Notificaciones activadas',
    enabledBody: 'Este teléfono está registrado. Las vistas previas permanecen privadas.',
    unavailableTitle: 'Notificaciones no disponibles',
    unavailableBody: 'Revisa el permiso de notificaciones y tu conexión, e inténtalo de nuevo.',
    disabledTitle: 'Notificaciones desactivadas',
    disabledBody: 'Se eliminó el registro protegido de notificaciones de este teléfono.',
    disableFailedTitle: 'No se pudieron desactivar las notificaciones',
    disableFailedBody: 'Revisa tu conexión e inténtalo de nuevo.',
  },
} as const;

export function notificationCopyFor(language: string | null | undefined) {
  return notificationCopy[language === 'es' ? 'es' : 'en'];
}
