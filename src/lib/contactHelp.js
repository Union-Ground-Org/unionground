// The problem list on the public Contact page (/contact): the common sign-in
// and invitation problems with the self-service path for each, shown before
// the mailboxes. It lives in this module, not the i18n barrel, so adding a
// line does not move the pinned catalogue hashes in the counsel packet.
//
// No reply time is stated anywhere here: the Terms disclaim a guaranteed
// response time without a signed SLA, and a target needs an owner-approved,
// recorded and tested coverage_escalation_verified before it can be published
export const CONTACT_HELP = {
  en: {
    title: "Common problems",
    intro: "Most sign-in and invitation problems have a quick fix.",
    items: [
      { key: "password", text: "I forgot my password or cannot sign in.", href: "/reset-password", action: "Reset your password" },
      { key: "invitation", text: "My invitation did not arrive or its link no longer works. Ask your campaign administrator to send a new invitation. If it was the invitation to set up a new campaign, there is no administrator to ask yet: reach the Union Ground team through Request an invite.", href: null, action: null },
      { key: "union", text: "My campaign is not on Union Ground yet.", href: "/request-invite", action: "Request an invite" },
      { key: "authenticator", text: "I lost my authenticator app. Use a recovery code if you saved one. Otherwise ask your campaign administrator to reset your two-step sign-in. If you are your campaign's only administrator, reach the Union Ground team through Request an invite.", href: null, action: null },
    ],
  },
  es: {
    title: "Problemas comunes",
    intro: "La mayoría de los problemas de inicio de sesión e invitaciones tienen una solución rápida.",
    items: [
      { key: "password", text: "Olvidé mi contraseña o no puedo iniciar sesión.", href: "/reset-password", action: "Restablece tu contraseña" },
      { key: "invitation", text: "Mi invitación no llegó o su enlace ya no funciona. Pide a tu administración de campaña que te envíe una invitación nueva. Si era la invitación para configurar una campaña nueva, todavía no hay administración a quien pedírselo: comunícate con el equipo de Union Ground desde Pide una invitación.", href: null, action: null },
      { key: "union", text: "Mi campaña todavía no está en Union Ground.", href: "/request-invite", action: "Pide una invitación" },
      { key: "authenticator", text: "Perdí mi aplicación de autenticación. Usa un código de recuperación si guardaste uno. Si no, pide a tu administración de campaña que restablezca tu inicio de sesión en dos pasos. Si eres la única persona administradora de tu campaña, comunícate con el equipo de Union Ground desde Pide una invitación.", href: null, action: null },
    ],
  },
};

// An unsupported language shows the English list.
export function contactHelpFor(lang) {
  return CONTACT_HELP[lang] ?? CONTACT_HELP.en;
}
