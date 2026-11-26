// New passwords only. Existing passwords are checked by the sign-in server.
// Preserve the owner's stricter, 24-character passphrase minimum everywhere.
export const NEW_PASSWORD_MIN = 24;
export const NEW_PASSWORD_MAX = 256;

// One pre-attempt minimum, shared by web, native, Home and invitation copy.
export const NEW_PASSWORD_RULE = Object.freeze({
  en: `Use at least ${NEW_PASSWORD_MIN} characters.`,
  es: `Usa al menos ${NEW_PASSWORD_MIN} caracteres.`,
});
// Which side of the length rule a new password misses while it is typed:
// "short", "long", or "" when the field is empty or within the rule, so a
// page can say why its save stays unavailable (#9448).
export function newPasswordLengthIssue(value) {
  const length = String(value ?? "").length;
  if (length === 0) return "";
  if (length < NEW_PASSWORD_MIN) return "short";
  return length > NEW_PASSWORD_MAX ? "long" : "";
}
// The reasons beside the field; {count} is the current length.
export const NEW_PASSWORD_TOO_SHORT = Object.freeze({
  en: `Too short: {count} of the ${NEW_PASSWORD_MIN} characters needed.`,
  es: `Demasiado corta: {count} de los ${NEW_PASSWORD_MIN} caracteres necesarios.`,
});
export const NEW_PASSWORD_TOO_LONG = Object.freeze({
  en: `Too long: {count} characters. Use no more than ${NEW_PASSWORD_MAX}.`,
  es: `Demasiado larga: {count} caracteres. Usa un máximo de ${NEW_PASSWORD_MAX}.`,
});
export const NEW_PASSWORD_ADVICE = Object.freeze({
  en: `A passphrase of ordinary words with spaces is easiest to remember: keep adding words until it reaches ${NEW_PASSWORD_MIN} characters, for example “copper kettle mountain parade” (make up your own).`,
  es: `Una frase de palabras comunes con espacios es lo más fácil de recordar: agrega palabras hasta llegar a ${NEW_PASSWORD_MIN} caracteres, por ejemplo “tetera cobre montaña desfile” (inventa la tuya).`,
});
