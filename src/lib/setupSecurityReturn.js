const ADMIN_PATH = "/m/admin";
const REVIEW_PATH = "/m/admin/setup-review";
const SECURITY_PATH = "/m/settings/security";
const RETURN_KEY = "setupReturnTo";

// This detour carries public setup context, never an arbitrary redirect or
// authority to enter Admin. The shell still checks the current role and hat.
export function safeAdminSetupPath(value) {
  if (typeof value !== "string" || !value || value.length > 2048
    || /[^\x21-\x7e]|[\\#]/.test(value)) return null;
  const [pathname, ...queryParts] = value.split("?");
  if (pathname !== ADMIN_PATH && pathname !== REVIEW_PATH) return null;
  if (queryParts.length > 1) return null;
  const search = new URLSearchParams(queryParts[0] || "");
  if (pathname === ADMIN_PATH && search.toString()) return null;
  for (const [key, entry] of search) {
    if (search.getAll(key).length !== 1) return null;
    if (key === "union") {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry)) return null;
    } else if (key !== "build" || entry !== "chapter") return null;
  }
  const query = search.toString();
  return pathname + (query ? `?${query}` : "");
}

export function setupReviewReturnPath(pathname, search = "") {
  if (typeof pathname !== "string" || pathname.replace(/\/+$/, "") !== REVIEW_PATH
    || typeof search !== "string" || search.length > 2048) return null;
  const context = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === "union" || key === "build") context.append(key, value);
  }
  const query = context.toString();
  return safeAdminSetupPath(REVIEW_PATH + (query ? `?${query}` : ""));
}

export function setupSecurityPath(returnTo) {
  const path = safeAdminSetupPath(returnTo);
  return path && path !== ADMIN_PATH
    ? `${SECURITY_PATH}?${new URLSearchParams({ [RETURN_KEY]: path })}`
    : SECURITY_PATH;
}

export function adminSetupPathFromSearch(search) {
  if (typeof search !== "string" || search.length > 4096) return ADMIN_PATH;
  const targets = new URLSearchParams(search).getAll(RETURN_KEY);
  return targets.length === 1 ? safeAdminSetupPath(targets[0]) || ADMIN_PATH : ADMIN_PATH;
}
