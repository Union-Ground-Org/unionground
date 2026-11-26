import { EMAIL_LINK_HOSTS } from "./emailLinkHosts.js";

// Email credentials stay in fragments: neither the web server nor Referer
// receives them. Only these two associated routes may carry email credentials.
export const EMAIL_AUTH_PATHS = Object.freeze({
  invitation: "/app/invite",
  passwordReset: "/app/reset-password",
});
export const INVITATION_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const RESET_LINK_TICKET = /^t1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,512}$/;

export function emailedAuthLink(origin, kind, token) {
  const path = EMAIL_AUTH_PATHS[kind];
  if (!path) throw new Error("Unknown email link kind");
  const url = new URL(path, origin);
  url.hash = new URLSearchParams({ [kind === "invitation" ? "invite" : "token"]: token }).toString();
  return url.toString();
}

export function parseEmailedAuthLink(value) {
  if (typeof value !== "string" || value.length > 4096
      || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !EMAIL_LINK_HOSTS.includes(url.host)
      || url.username || url.password || url.search) return null;
  const kind = Object.keys(EMAIL_AUTH_PATHS).find((key) => EMAIL_AUTH_PATHS[key] === url.pathname);
  if (!kind) return null;
  const key = kind === "invitation" ? "invite" : "token";
  const params = new URLSearchParams(url.hash.slice(1));
  if ([...params.keys()].length !== 1 || !params.has(key)) return null;
  const token = params.get(key);
  if (!(kind === "invitation" ? INVITATION_LINK_TOKEN : RESET_LINK_TICKET).test(token || "")) return null;
  return { kind, token };
}
