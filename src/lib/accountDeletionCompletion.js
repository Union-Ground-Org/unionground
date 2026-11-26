// Contains no account identifier, token, or member content. Acknowledgement is
// explicit; auth events must never dismiss an irreversible operation's result.
export function deletionCompletion(result) {
  if (result?.deleted !== true) return null;
  return { audited: result.audited === true };
}

export const deletionCompletionCopy = {
  en: {
    title: "Your account has been deleted",
    uncertainTitle: "We could not confirm account deletion",
    uncertainBody: "Do not submit another deletion request. Continue to sign in to check whether your account still exists, or contact support.",
    body: "You are signed out. You can no longer sign in with this account.",
    pending: "Your account was deleted. The final confirmation record is still being recorded; no action is needed from you.",
    cleanup: "Finishing cleanup on this device…",
    cleanupFailed: "This device could not finish clearing its saved session. Keep this screen open and retry cleanup.",
    retry: "Retry device cleanup",
    continue: "Continue to sign in",
    sample: "Continue to SAMPLE demo",
  },
  es: {
    title: "Tu cuenta ha sido eliminada",
    uncertainTitle: "No pudimos confirmar la eliminación de tu cuenta",
    uncertainBody: "No envíes otra solicitud de eliminación. Continúa al inicio de sesión para comprobar si tu cuenta todavía existe o contacta al soporte.",
    body: "Tu sesión está cerrada. Ya no puedes iniciar sesión con esta cuenta.",
    pending: "Tu cuenta fue eliminada. Todavía estamos registrando la confirmación final; no necesitas hacer nada.",
    cleanup: "Terminando la limpieza en este dispositivo…",
    cleanupFailed: "No se pudo terminar de borrar la sesión guardada en este dispositivo. Mantén esta pantalla abierta y vuelve a intentar la limpieza.",
    retry: "Reintentar la limpieza del dispositivo",
    continue: "Continuar al inicio de sesión",
    sample: "Continuar a la demostración SAMPLE",
  },
};
