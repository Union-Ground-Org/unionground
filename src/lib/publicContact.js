// Union Ground's published contacts. No Union Ground company statement,
// mailbox, or postal address is published yet, so there is no contact here and
// every page that would show one says so instead (the same honest preview the
// native legal reader gives, apps/mobile/src/lib/legalDocuments.ts). Add an
// owner-approved Union Ground mailbox here once it exists; never a sibling
// product's address. Each entry is a frozen { email, href: "mailto:<email>" }
// keyed by role (owner, sales, support).
export const PUBLIC_CONTACTS = Object.freeze({});

// The postal address a commercial page or a footer would print. None yet.
export const PUBLIC_POSTAL_ADDRESS = null;

// The published contact for a role, or null while none is published. Callers
// render their "no address published yet" copy for null; nothing invents one.
export function publicContact(role) {
  const entry = Object.hasOwn(PUBLIC_CONTACTS, role) ? PUBLIC_CONTACTS[role] : null;
  return entry && typeof entry.email === "string" && entry.email ? entry : null;
}
