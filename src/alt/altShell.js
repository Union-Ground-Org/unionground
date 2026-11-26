// The alternate web shell switch (REQ-UG-ALT-SHELL-FOUNDATION-20261015).
//
// The October 10, 2026 design alternate ("Union Ground Site (resets alt,
// workspace)") is built as a second presentation layer inside the same app:
// App.jsx keeps every session, authorization, routing and data concern, and
// only the chrome and the pages the design restyles change. This module
// decides which shell a visit renders. Precedence:
//
//   1. the `shell` query parameter, `alt` or `classic`, which is also saved so
//      the choice survives in-app navigation and reloads;
//   2. the saved choice;
//   3. the build default, VITE_UG_DEFAULT_SHELL (`classic` unless set).
//
// The later swap is therefore one build setting, and either shell stays one
// query parameter away for comparison. Nothing here reads the session: the
// switch is a presentation preference, never an authorization input.

export const SHELL_QUERY_PARAM = "shell";
export const SHELL_STORAGE_KEY = "ug.shell";
export const ALT_SHELL = "alt";
export const CLASSIC_SHELL = "classic";

function normalize(value) {
  return value === ALT_SHELL || value === CLASSIC_SHELL ? value : null;
}

function storageOrNull(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readSaved(store) {
  try { return normalize(store?.getItem(SHELL_STORAGE_KEY)); } catch { return null; }
}

export function readShellChoice({ search, storage, defaultShell } = {}) {
  return explicitShellChoice({ search, storage })?.shell
    ?? normalize(defaultShell ?? import.meta.env?.VITE_UG_DEFAULT_SHELL) ?? CLASSIC_SHELL;
}

export function altShellEnabled(options) {
  return readShellChoice(options) === ALT_SHELL;
}

// REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: the alternate shell as
// an A/B member default view. The PostHog flag member-default-view ("control"
// keeps the classic shell, "alt" lands the member in this one) replaces the
// build default for members only, and a member's own switch, stored in this
// browser under the member like the other member UI preferences, overrides
// the flag. Precedence for a signed-in visit:
//
//   1. the `shell` query parameter (unchanged, saved as before);
//   2. the member's own switch (`ug.shell.member.<user id>`);
//   3. the device's saved query choice (`ug.shell`, unchanged);
//   4. the flag, only for a member without any staff, organization or chapter
//      role, outside the demo;
//   5. the build default, then classic ("control" also resolves here).
//
// The flag decides, and its exposure may be recorded, only at step 4.
export const MEMBER_SHELL_FLAG = "member-default-view";
export const MEMBER_SHELL_STORAGE_PREFIX = "ug.shell.member.";

function memberShellKey(userId) {
  return typeof userId === "string" && userId ? `${MEMBER_SHELL_STORAGE_PREFIX}${userId}` : null;
}

// The explicit choice a visit carries before any member is known: the query
// parameter (saved, as readShellChoice saves it) or the device's saved choice.
export function explicitShellChoice({ search, storage } = {}) {
  const query = new URLSearchParams(search ?? (typeof window === "undefined" ? "" : window.location.search));
  const fromQuery = normalize(query.get(SHELL_QUERY_PARAM));
  const store = storageOrNull(storage);
  if (fromQuery) {
    try { store?.setItem(SHELL_STORAGE_KEY, fromQuery); } catch { /* Storage may be unavailable. */ }
    return { shell: fromQuery, source: "query" };
  }
  const saved = readSaved(store);
  return saved ? { shell: saved, source: "saved" } : null;
}

export function readMemberShellPreference(userId, storage) {
  const key = memberShellKey(userId);
  if (!key) return null;
  try { return normalize(storageOrNull(storage)?.getItem(key)); } catch { return null; }
}

// Stores the member's own switch and retires the device's saved query choice,
// which would otherwise outrank it on the next visit. False when storage
// refuses the write; the caller still honours the choice for this page.
export function writeMemberShellPreference(userId, shell, storage) {
  const key = memberShellKey(userId);
  const value = normalize(shell);
  const store = storageOrNull(storage);
  if (!key || !value || !store) return false;
  try {
    store.setItem(key, value);
    store.removeItem(SHELL_STORAGE_KEY);
    return true;
  } catch { return false; }
}

// Members only: any staff, organization-wide or chapter role, an unknown or
// MFA-suspended roles read, a demo session or a missing member keeps the
// current shell regardless of the flag.
export function memberShellExperimentEligible({ signedIn, demo, data } = {}) {
  if (!signedIn || demo || !data?.member?.id || data.rolesUnknown || data.staffMfa?.blocked) return false;
  const held = [data.roles, data.member.organizationRoles, data.member.chapterRoles]
    .flatMap((roles) => (Array.isArray(roles) ? roles : []))
    .filter((role) => role !== "member");
  return held.length === 0;
}

export function resolveMemberShell({ explicit = null, preference = null, eligible = false, flagValue = null, defaultShell } = {}) {
  if (explicit?.source === "query" && normalize(explicit.shell)) return { shell: explicit.shell, flagDecides: false };
  if (normalize(preference)) return { shell: preference, flagDecides: false };
  if (normalize(explicit?.shell)) return { shell: explicit.shell, flagDecides: false };
  // "control" is today's member view: the build default, as before.
  const today = normalize(defaultShell ?? import.meta.env?.VITE_UG_DEFAULT_SHELL) ?? CLASSIC_SHELL;
  if (eligible) return { shell: flagValue === ALT_SHELL ? ALT_SHELL : today, flagDecides: true };
  return { shell: today, flagDecides: false };
}

// Keep the `shell` parameter on an in-app path only when it is present on the
// current page, so a copied link keeps showing what the person was looking at.
export function withShellParam(path, search = typeof window === "undefined" ? "" : window.location.search) {
  const choice = normalize(new URLSearchParams(search).get(SHELL_QUERY_PARAM));
  if (!choice || !path || /[?&]shell=/.test(path)) return path;
  const [base, hash = ""] = path.split("#");
  return `${base}${base.includes("?") ? "&" : "?"}${SHELL_QUERY_PARAM}=${choice}${hash ? `#${hash}` : ""}`;
}

// An explicit "open the task board" entrance (REQ-UG-ALT-SHELL-CASE-DESK-20261030).
// Under the alternate shell plain /m/tasks opens Work on the case board, so the
// entrance names the Work page's Tasks tab (view=tasks, the prototype's own
// #/work?view=tasks); the classic shell keeps /m/tasks.
export function tasksBoardHref({ demo = false, alt = false } = {}) {
  const query = [demo ? "demo=1" : "", alt ? "view=tasks" : ""].filter(Boolean).join("&");
  return query ? `/m/tasks?${query}` : "/m/tasks";
}
