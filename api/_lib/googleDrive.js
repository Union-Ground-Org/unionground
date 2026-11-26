import { createHash, randomBytes } from "node:crypto";
import { brandText } from "./brand.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// In this deployment's product name (api/_lib/brand.js).
const rootFolderName = () => brandText("Union Ground resources");
const MAX_JSON_DOWNLOAD_BYTES = 3 * 1024 * 1024;
const MAX_DRIVE_LIST_PAGES = 20;
const MAX_DRIVE_LIST_FILES = 2000;
const DRIVE_LIST_TIMEOUT_MS = 15_000;
const GOOGLE_ID_TOKEN_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const MAX_ACCOUNT_EMAIL_LENGTH = 320;
const ACCOUNT_EMAIL_PATTERN = /^[^\s@"'<>\\]+@[^\s@."'<>\\]+(?:\.[^\s@."'<>\\]+)+$/;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function boundedText(value, max) {
  const result = String(value || "").trim();
  return result.length <= max ? result : result.slice(0, max);
}

// The id_token arrives on the direct TLS call to Google's token endpoint, so the
// signature does not have to be re-checked (OpenID Connect Core 3.1.3.7); the
// binding claims still do, because the email is stored and audited as the
// connected account identity.
export function readGoogleDriveAccountEmail(idToken, { clientId, now = Date.now() } = {}) {
  const segments = String(idToken || "").split(".");
  if (segments.length !== 3) return "";
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return "";
  }
  if (!claims || typeof claims !== "object") return "";
  if (!GOOGLE_ID_TOKEN_ISSUERS.has(claims.iss)) return "";
  if (!clientId || claims.aud !== clientId) return "";
  if (!(Number(claims.exp) * 1000 > now)) return "";
  if (claims.email_verified !== true && claims.email_verified !== "true") return "";
  const email = String(claims.email || "").trim();
  if (email.length > MAX_ACCOUNT_EMAIL_LENGTH || !ACCOUNT_EMAIL_PATTERN.test(email)) return "";
  return email.toLowerCase();
}

export function buildGoogleDriveOauthMaterial() {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const stateHash = createHash("sha256").update(state).digest("hex");
  return { state, stateHash, codeVerifier, codeChallenge };
}

export function buildGoogleDriveAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function googleJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const code = boundedText(body?.error?.status || body?.error || body?.error_description || label, 120);
    throw Object.assign(new Error(`${label}-failed`), { status: response.status, code });
  }
  return body;
}

export async function exchangeGoogleDriveCode({
  fetchImpl = fetch,
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const result = await googleJson(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, "google-drive-code-exchange");
  if (!result?.access_token || !result?.refresh_token) {
    throw new Error("google-drive-code-exchange-incomplete");
  }
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    scope: boundedText(result.scope || DRIVE_SCOPE, 2000),
    accountEmail: readGoogleDriveAccountEmail(result.id_token, { clientId }),
  };
}

export async function refreshGoogleDriveAccessToken({
  fetchImpl = fetch,
  clientId,
  clientSecret,
  refreshToken,
}) {
  const result = await googleJson(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  }, "google-drive-token-refresh");
  if (!result?.access_token) throw new Error("google-drive-token-refresh-incomplete");
  return result.access_token;
}

function driveHeaders(accessToken, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

function escapeDriveLiteral(value) {
  return String(value || "")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .trim();
}

export async function ensureGoogleDriveRootFolder({ fetchImpl = fetch, accessToken, rootFolderId = "" }) {
  if (rootFolderId) return rootFolderId;
  const query = `mimeType='${FOLDER_MIME}' and name='${escapeDriveLiteral(rootFolderName())}' and 'root' in parents and trashed=false`;
  const listUrl = new URL(`${GOOGLE_DRIVE_URL}/files`);
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("fields", "files(id,name)");
  listUrl.searchParams.set("pageSize", "1");
  const listed = await googleJson(fetchImpl, listUrl, {
    headers: driveHeaders(accessToken),
  }, "google-drive-root-list");
  if (listed?.files?.[0]?.id) return listed.files[0].id;
  const created = await googleJson(fetchImpl, `${GOOGLE_DRIVE_URL}/files?fields=id`, {
    method: "POST",
    headers: driveHeaders(accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({ name: rootFolderName(), mimeType: FOLDER_MIME }),
  }, "google-drive-root-create");
  if (!created?.id) throw new Error("google-drive-root-create-incomplete");
  return created.id;
}

// REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: the old lib/google/drive.ts
// getOrCreateFolderByName, scoped to a parent folder this application owns.
// With the drive.file scope only folders Union Ground created are visible, so a
// same-named folder made by hand elsewhere is never picked up. Returns "" when
// the folder does not exist and `create` is false.
export async function resolveGoogleDriveChildFolder({ fetchImpl = fetch, accessToken, parentId, name, create = false, reserveFolder }) {
  const safeParent = boundedText(parentId, 256);
  const safeName = boundedText(String(name || "").split("").map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "/" || character === "\\" ? " " : character;
  }).join(""), 200);
  if (!/^[A-Za-z0-9_-]+$/.test(safeParent) || !safeName) throw new Error("invalid-google-drive-folder");
  if (create && typeof reserveFolder !== "function") throw new Error("google-drive-folder-reservation-required");
  const reserved = reserveFolder ? await reserveFolder({ parentId: safeParent, name: safeName, proposedId: null }) : "";
  const listUrl = new URL(`${GOOGLE_DRIVE_URL}/files`);
  listUrl.searchParams.set("q", `mimeType='${FOLDER_MIME}' and name='${escapeDriveLiteral(safeName)}' and '${escapeDriveLiteral(safeParent)}' in parents and trashed=false`);
  listUrl.searchParams.set("fields", "files(id,name)");
  listUrl.searchParams.set("pageSize", "1");
  const listed = reserved ? null : await googleJson(fetchImpl, listUrl, { headers: driveHeaders(accessToken) }, "google-drive-folder-list");
  const existing = listed?.files?.[0]?.id;
  if (!create) return reserved || existing || "";
  let folderId = reserved;
  if (!folderId) {
    const generated = existing ? null : await googleJson(fetchImpl, `${GOOGLE_DRIVE_URL}/files/generateIds?count=1&space=drive`, {
      headers: driveHeaders(accessToken),
    }, "google-drive-folder-id");
    const proposedId = existing || generated?.ids?.[0];
    if (!proposedId) throw new Error("google-drive-folder-id-incomplete");
    folderId = await reserveFolder({ parentId: safeParent, name: safeName, proposedId });
    if (!folderId || !/^[A-Za-z0-9_-]{1,256}$/.test(folderId)) throw new Error("google-drive-folder-reservation-incomplete");
    if (folderId === existing) return folderId;
  }
  // Google accepts pre-generated IDs for folders. A concurrent create/retry
  // receives 409 for the same ID, instead of creating another folder.
  // https://developers.google.com/workspace/drive/api/guides/create-file
  try {
    const created = await googleJson(fetchImpl, `${GOOGLE_DRIVE_URL}/files?fields=id`, {
      method: "POST", headers: driveHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ id: folderId, name: safeName, mimeType: FOLDER_MIME, parents: [safeParent] }),
    }, "google-drive-folder-create");
    if (created?.id !== folderId) throw new Error("google-drive-folder-create-incomplete");
  } catch (error) {
    if (error.status !== 409) throw error;
    const found = await googleJson(fetchImpl, `${GOOGLE_DRIVE_URL}/files/${encodeURIComponent(folderId)}?fields=id,mimeType,parents,trashed`, {
      headers: driveHeaders(accessToken),
    }, "google-drive-folder-existing");
    if (found?.id !== folderId || found.mimeType !== FOLDER_MIME || found.trashed || !found.parents?.includes(safeParent)) {
      throw new Error("google-drive-folder-reservation-mismatch", { cause: error });
    }
  }
  return folderId;
}

/** Root -> group ("Cases"/"Meetings") -> immutable target identity. */
export async function resolveGoogleDriveFilingFolder({ fetchImpl = fetch, accessToken, rootFolderId, groupFolderName, folderName, targetKey, create = false, reserveFolder }) {
  const reserve = (key) => reserveFolder ? (folder) => reserveFolder({ ...folder, targetKey: key }) : undefined;
  const groupId = await resolveGoogleDriveChildFolder({ fetchImpl, accessToken, parentId: rootFolderId, name: groupFolderName, create, reserveFolder: reserve(`group:${groupFolderName}`) });
  if (!groupId) return "";
  return resolveGoogleDriveChildFolder({ fetchImpl, accessToken, parentId: groupId, name: folderName, create, reserveFolder: reserve(targetKey) });
}

export async function listGoogleDriveFiles({ fetchImpl = fetch, accessToken, rootFolderId }) {
  const url = new URL(`${GOOGLE_DRIVE_URL}/files`);
  url.searchParams.set("q", `'${escapeDriveLiteral(rootFolderId)}' in parents and trashed=false`);
  url.searchParams.set("fields", "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("pageSize", "100");
  const incomplete = () => Object.assign(new Error("google-drive-list-incomplete"), { status: 502 });
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("google-drive-list-timeout"), { status: 504 });
      controller.abort(error);
      reject(error);
    }, DRIVE_LIST_TIMEOUT_MS);
  });
  const collect = async () => {
    const files = [];
    const seenTokens = new Set();
    for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(new URL(url), { headers: driveHeaders(accessToken), signal: controller.signal });
      const text = await response.text();
      controller.signal.throwIfAborted();
      let result;
      try { result = text ? JSON.parse(text) : null; } catch { result = null; }
      if (!response.ok) {
        const code = boundedText(result?.error?.status || result?.error || "google-drive-list", 120);
        throw Object.assign(new Error("google-drive-list-failed"), { status: response.status, code });
      }
      if (!result || typeof result !== "object" || Array.isArray(result)
          || (result.files !== undefined && !Array.isArray(result.files))
          || (result.incompleteSearch !== undefined && result.incompleteSearch !== false)) throw incomplete();
      const pageFiles = result.files ?? [];
      if (files.length + pageFiles.length > MAX_DRIVE_LIST_FILES) throw incomplete();
      files.push(...pageFiles.map((file) => ({
        id: boundedText(file.id, 256),
        name: boundedText(file.name, 200),
        mimeType: boundedText(file.mimeType, 160),
        size: Number(file.size || 0),
        modifiedTime: file.modifiedTime || null,
        webViewLink: /^https:\/\//.test(file.webViewLink || "") ? file.webViewLink : null,
      })));
      const next = result.nextPageToken;
      if (next == null || next === "") return files;
      if (typeof next !== "string" || next.length > 4096 || seenTokens.has(next)) throw incomplete();
      seenTokens.add(next);
      url.searchParams.set("pageToken", next);
    }
    throw incomplete();
  };
  // One deadline includes every page and its body; no partial array escapes.
  try { return await Promise.race([collect(), deadline]); } finally { clearTimeout(timer); }
}

export async function uploadGoogleDriveFile({
  fetchImpl = fetch,
  accessToken,
  rootFolderId,
  name,
  mimeType,
  bytes,
}) {
  const safeName = boundedText(String(name || "").split("").map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "/" || character === "\\" ? "-" : character;
  }).join(""), 200) || "untitled";
  const safeMimeType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(String(mimeType || ""))
    ? String(mimeType)
    : "application/octet-stream";
  const boundary = `union-ground-${base64url(randomBytes(18))}`;
  const metadata = JSON.stringify({ name: safeName, parents: [rootFolderId] });
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
      + `--${boundary}\r\nContent-Type: ${safeMimeType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--`);
  const result = await googleJson(fetchImpl, `${GOOGLE_UPLOAD_URL}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink`, {
    method: "POST",
    headers: driveHeaders(accessToken, { "Content-Type": `multipart/related; boundary=${boundary}` }),
    body: Buffer.concat([prefix, Buffer.from(bytes), suffix]),
  }, "google-drive-upload");
  return result;
}

export async function downloadGoogleDriveFile({ fetchImpl = fetch, accessToken, fileId, rootFolderId }) {
  const safeId = boundedText(fileId, 256);
  const safeRootFolderId = boundedText(rootFolderId, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(safeId) || !/^[A-Za-z0-9_-]+$/.test(safeRootFolderId)) {
    throw new Error("invalid-google-drive-file-id");
  }
  const metadata = await googleJson(
    fetchImpl,
    `${GOOGLE_DRIVE_URL}/files/${encodeURIComponent(safeId)}?fields=id,parents,size`,
    { headers: driveHeaders(accessToken) },
    "google-drive-download-metadata",
  );
  if (!Array.isArray(metadata?.parents) || !metadata.parents.includes(safeRootFolderId)) {
    throw Object.assign(new Error("google-drive-download-outside-root"), { status: 404 });
  }
  if (Number(metadata.size || 0) > MAX_JSON_DOWNLOAD_BYTES) {
    throw Object.assign(new Error("google-drive-download-too-large"), { status: 413 });
  }
  const response = await fetchImpl(`${GOOGLE_DRIVE_URL}/files/${encodeURIComponent(safeId)}?alt=media`, {
    headers: driveHeaders(accessToken),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error("google-drive-download-failed"), { status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_JSON_DOWNLOAD_BYTES) {
    throw Object.assign(new Error("google-drive-download-too-large"), { status: 413 });
  }
  return bytes;
}

export const GOOGLE_DRIVE_SCOPE = DRIVE_SCOPE;
