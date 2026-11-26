// The public /get-app page (Get Union Ground), which the invitation emails' QR
// code opens, split out of the src/lib/i18n.js barrel like unionCatalog.js.
// This file is the ONLY declaration of every `getApp.` key; the barrel spreads
// it back into `catalogue`, so `t()` is unchanged for every web importer.
//
// Copy rules: never name a real organization, and never offer a phone app
// that is not actually available (src/lib/appDownloads.js decides).
export const getAppCatalogue = {
  en: {
    "getApp.eyebrow": "Invited workers",
    "getApp.title": "Get Union Ground",
    "getApp.intro": "Union Ground accounts are by invitation only. After you accept your invitation, we email you a temporary sign-in password. Sign in with your email address and that password, then choose your own password in Settings, under Security.",
    "getApp.webTitle": "Website",
    "getApp.webBody": "Works in any up-to-date browser on a computer or phone.",
    "getApp.webAction": "Sign in on the website",
    "getApp.iosTitle": "iPhone",
    "getApp.androidTitle": "Android",
    "getApp.appUnavailable": "The app isn't available to download yet. Use the website in your phone's browser for now.",
    // REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-17):
    // with neither app listed, one note replaces two identical cards.
    "getApp.phoneAppsTitle": "Phone apps",
    "getApp.appsUnavailable": "The iPhone and Android apps aren't available to download yet. Use the website in your phone's browser for now.",
    "getApp.qrLabel": "QR code that opens this page",
    "getApp.qrBody": "On a computer? Scan this code with your phone's camera to open this page on your phone.",
    "getApp.noInvitation": "No invitation yet?",
    "getApp.appAction": "Get the app",
  },
  es: {
    "getApp.eyebrow": "Trabajadores invitados",
    "getApp.title": "Obtén Union Ground",
    "getApp.intro": "Las cuentas de Union Ground son solo por invitación. Después de aceptar tu invitación, te enviamos una contraseña temporal por correo. Inicia sesión con tu correo y esa contraseña, y luego elige tu propia contraseña en Configuración, en Seguridad.",
    "getApp.webTitle": "Sitio web",
    "getApp.webBody": "Funciona en cualquier navegador actualizado de computadora o teléfono.",
    "getApp.webAction": "Entrar en el sitio web",
    "getApp.iosTitle": "iPhone",
    "getApp.androidTitle": "Android",
    "getApp.appUnavailable": "La app todavía no se puede descargar. Por ahora, usa el sitio web en el navegador de tu teléfono.",
    "getApp.phoneAppsTitle": "Apps para teléfono",
    "getApp.appsUnavailable": "Las apps para iPhone y Android todavía no se pueden descargar. Por ahora, usa el sitio web en el navegador de tu teléfono.",
    "getApp.qrLabel": "Código QR que abre esta página",
    "getApp.qrBody": "¿Estás en una computadora? Escanea este código con la cámara de tu teléfono para abrir esta página en tu teléfono.",
    "getApp.noInvitation": "¿Todavía no tienes invitación?",
    "getApp.appAction": "Obtener la app",
  },
};
