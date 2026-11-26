// Whose language a page shows (REQ-UG-SPANISH-COVERAGE-AND-LANGUAGE-CARRYOVER-20261030).
//
// sg-lang is the device's choice: someone picked English or Español on a
// signed-out page (the sign-in card, the landing page, a standalone page), so
// it shows where they chose it. A signed-in member's language is theirs, not
// the device's. It is kept in one account slot, and only that account reads
// it back: on the verification-code page, before its saved settings load. A
// member's choice therefore never becomes the device's: after sign-out the
// signed-out pages keep the device's own choice (an explicit one survives
// sign-out, pilot finding 20261003), with their language control on screen,
// and the next person to sign in does not inherit the last member's.
//
// The slot names the account by a short tag, not its id. The tag only tells
// accounts apart; it is not a secret.
const ACCOUNT_KEY = "sg-lang-account";
const LANGUAGES = new Set(["en", "es"]);

const storage = (win) => {
  try { return win?.localStorage ?? null; } catch { return null; }
};

// FNV-1a, 32 bits.
export function accountTag(userId) {
  let hash = 0x811c9dc5;
  for (const char of String(userId)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function rememberAccountLanguage(userId, lang, win = typeof window === "undefined" ? null : window) {
  if (!userId || !LANGUAGES.has(lang)) return;
  try { storage(win)?.setItem(ACCOUNT_KEY, JSON.stringify({ account: accountTag(userId), lang })); } catch { /* storage may be unavailable */ }
}

export function accountLanguage(userId, win = typeof window === "undefined" ? null : window) {
  if (!userId) return null;
  try {
    const slot = JSON.parse(storage(win)?.getItem(ACCOUNT_KEY) ?? "null");
    return slot?.account === accountTag(userId) && LANGUAGES.has(slot.lang) ? slot.lang : null;
  } catch {
    return null;
  }
}
