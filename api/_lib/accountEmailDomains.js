// Government and employer email domains can never be a Union Ground account
// address (REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102).
//
// The rules live in config/account-blocked-email-domains.json. Routes that
// create an account or set an account email refuse a blocked address here,
// before they call Auth, so the person gets a clear answer. The database
// trigger private.guard_account_email_domain applies the same rules to every
// auth.users insert and email change, including the paths no route sees
// (a direct PUT /auth/v1/user, SAML just-in-time accounts), so a route that
// cannot read the config lets the request through to that backstop.
//
// Each api/ function that imports this module lists the config in
// vercel.json includeFiles.
import { readFileSync } from "node:fs";

export const EMAIL_DOMAIN_BLOCKED = "email-domain-blocked";

const COUNTRY = /^[a-z]{2}$/;

let rulesCache = null;
export function accountEmailDomainRules() {
  if (!rulesCache) {
    const parsed = JSON.parse(readFileSync(new URL("../../config/account-blocked-email-domains.json", import.meta.url), "utf8"));
    const list = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).toLowerCase());
    rulesCache = Object.freeze({
      topLevel: list(parsed?.government?.topLevel),
      countrySecondLevel: list(parsed?.government?.countrySecondLevel),
      suffixes: list(parsed?.government?.suffixes),
      usStateLevel: list(parsed?.government?.usStateLevel),
      usLocality: list(parsed?.government?.usLocality),
      usStates: list(parsed?.government?.usStates),
      employer: list(parsed?.employer),
    });
  }
  return rulesCache;
}

export function accountEmailDomain(value) {
  const email = String(value ?? "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).replace(/\.+$/, "");
}

// "government", "employer" or null. Mirrors private.account_email_block_reason.
export function accountEmailBlockReason(value, rules = accountEmailDomainRules()) {
  const domain = accountEmailDomain(value);
  if (!domain) return null;
  const labels = domain.split(".");
  const n = labels.length;
  const within = (suffix) => domain === suffix || domain.endsWith(`.${suffix}`);
  const last = labels[n - 1];
  if (rules.topLevel.includes(last)) return "government";
  if (n >= 2 && COUNTRY.test(last) && rules.countrySecondLevel.includes(labels[n - 2])) return "government";
  if (rules.suffixes.some(within)) return "government";
  if (last === "us" && n >= 3 && COUNTRY.test(labels[n - 2])) {
    if (rules.usStateLevel.includes(labels[n - 3])) return "government";
    if (n >= 4 && rules.usLocality.includes(labels[n - 4])) return "government";
    // <place>.<state>.us itself is the locality's own delegation (riverside.ca.us).
    if (n === 3 && rules.usStates.includes(labels[n - 2])) return "government";
  }
  if (rules.employer.some(within)) return "employer";
  return null;
}

// True only for an address the rules refuse. A config read failure answers
// false: the database trigger still refuses the address.
export function accountEmailDomainBlocked(value) {
  try {
    return accountEmailBlockReason(value) !== null;
  } catch {
    return false;
  }
}
