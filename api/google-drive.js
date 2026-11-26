import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import {
  buildGoogleDriveAuthorizationUrl,
  buildGoogleDriveOauthMaterial,
  downloadGoogleDriveFile,
  ensureGoogleDriveRootFolder,
  exchangeGoogleDriveCode,
  resolveGoogleDriveFilingFolder,
  listGoogleDriveFiles,
  refreshGoogleDriveAccessToken,
  uploadGoogleDriveFile,
} from "./_lib/googleDrive.js";
import {
  boundOAuthState,
  boundOAuthStateHash,
  newOAuthStateBinding,
  oauthStateBindingCookie,
  readOAuthStateBinding,
  startOnOtherSiteAddress,
} from "./_lib/oauthStateBinding.js";

const DRIVE_BINDING_COOKIE = "google_drive_oauth_binding";

const MAX_DRIVE_BYTES = 3 * 1024 * 1024;
const MAX_DRIVE_BASE64_LENGTH = Math.ceil(MAX_DRIVE_BYTES / 3) * 4;

function queryValue(request, key) {
  const direct = request?.query?.[key];
  if (Array.isArray(direct)) return String(direct[0] || "");
  if (direct != null) return String(direct);
  try { return new URL(request.url, "https://local.invalid").searchParams.get(key) || ""; } catch { return ""; }
}

function redirect(response, location) {
  response.status(302).setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function safeLog(kind, reason) {
  // Never log user, organization, OAuth code/state, token, or error body.
  // The stable reason is enough for operational triage.
  console.error("[google-drive]", { kind, reason });
}

async function userAuthorization(request, backend, action) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const authorization = await supabaseRpc(backend.url, backend.publishableKey, token, "authorize_google_drive_operation", {
    p_action: action,
  });
  if (authorization?.rateLimited) {
    throw Object.assign(new Error("google drive rate limited"), { status: 429 });
  }
  return authorization;
}

// REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: an optional { kind, id } filing
// target (a case or a meeting). Its authorization is the target's own rule,
// checked by authorize_google_drive_filing; without one the shared resources
// folder is used exactly as before.
export function filingTarget(body) {
  const target = body?.target;
  if (target == null) return null;
  if (typeof target !== "object" || !["case", "meeting"].includes(target.kind)
      || typeof target.id !== "string" || !target.id || target.id.length > 200) {
    throw Object.assign(new Error("invalid filing target"), { status: 400 });
  }
  return { kind: target.kind, id: target.id };
}

async function filingAuthorization(request, backend, action, target) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const authorization = await supabaseRpc(backend.url, backend.publishableKey, token, "authorize_google_drive_filing", {
    p_action: action,
    p_target_kind: target.kind,
    p_target_id: target.id,
  });
  if (authorization?.rateLimited) {
    throw Object.assign(new Error("google drive rate limited"), { status: 429 });
  }
  return authorization;
}

async function serviceCredential(backend, organizationId) {
  return supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, "read_google_drive_refresh_token", {
    p_organization_id: organizationId,
  });
}

function publicFailure(error) {
  const status = Number(error?.status || 500);
  if (status === 400) return { status, error: "invalid google drive request" };
  if (status === 401 || status === 403) return { status, error: "not authorized" };
  if (status === 404) return { status, error: "not configured" };
  if (status === 413) return { status, error: "google drive file is too large for this screen" };
  if (status === 429) return { status, error: "google drive is busy; try again later" };
  return { status: status >= 400 && status < 600 ? status : 500, error: "google drive request failed" };
}

export function decodeBoundedBase64(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > MAX_DRIVE_BASE64_LENGTH
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length > 0 && bytes.length <= MAX_DRIVE_BYTES ? bytes : null;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "method not allowed" }))) return;
  const action = queryValue(request, "action") || "list";
  const backend = resolveSupabaseBackend(request);
  const clientId = String(process.env.GOOGLE_DRIVE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_DRIVE_REDIRECT_URI || "").trim();
  if (requireEnv(
    [backend.url, backend.publishableKey, backend.serviceRoleKey, clientId, clientSecret, redirectUri],
    () => json(response, 503, { error: "google drive is not configured" }),
  )) return;
  if (action !== "callback" && request.method !== "POST") {
    return json(response, 405, { error: "method not allowed" });
  }

  if (action === "start") {
    const token = bearerToken(request);
    if (!token) return json(response, 401, { error: "not authorized" });
    if (!/^https:\/\//.test(redirectUri)) return json(response, 503, { error: "google drive redirect is not configured" });
    const siteAddress = startOnOtherSiteAddress(request, redirectUri);
    if (siteAddress) return json(response, 409, { error: "use-site-address", siteAddress });
    const material = buildGoogleDriveOauthMaterial();
    const binding = newOAuthStateBinding();
    try {
      await supabaseRpc(backend.url, backend.publishableKey, token, "begin_google_drive_oauth", {
        p_state_hash: boundOAuthStateHash(material.state, binding),
        p_code_verifier: material.codeVerifier,
        p_redirect_uri: redirectUri,
        p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      response.setHeader("Set-Cookie", oauthStateBindingCookie(DRIVE_BINDING_COOKIE, binding, redirectUri));
      return json(response, 200, {
        authorizationUrl: buildGoogleDriveAuthorizationUrl({
          clientId,
          redirectUri,
          state: material.state,
          codeChallenge: material.codeChallenge,
        }),
      });
    } catch (error) {
      const failure = publicFailure(error);
      return json(response, failure.status, { error: failure.error });
    }
  }

  if (action === "callback") {
    if (request.method !== "GET") return json(response, 405, { error: "method not allowed" });
    const code = queryValue(request, "code");
    const state = queryValue(request, "state");
    const destination = `${new URL(redirectUri).origin}/m/organize?drive=`;
    if (!code || !state) {
      safeLog("callback_refused", queryValue(request, "error") ? "provider_denied" : "invalid_callback");
      return redirect(response, `${destination}failed`);
    }
    const boundState = boundOAuthState(state, readOAuthStateBinding(request.headers, DRIVE_BINDING_COOKIE));
    if (!boundState) {
      safeLog("callback_refused", "browser_binding_missing");
      return redirect(response, `${destination}failed`);
    }
    let reason = "state_claim_failed";
    try {
      const claimed = await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "claim_google_drive_oauth_state",
        { p_state: boundState },
      );
      // Only the return that claimed this browser's start spends its binding. A
      // refused or stray visit leaves it, so it cannot void a connect in progress.
      response.setHeader("Set-Cookie", oauthStateBindingCookie(DRIVE_BINDING_COOKIE, "", redirectUri, { clear: true }));
      if (claimed.redirectUri !== redirectUri) {
        reason = "redirect_mismatch";
        throw Object.assign(new Error("oauth redirect mismatch"), { status: 403 });
      }
      reason = "code_exchange_failed";
      const tokens = await exchangeGoogleDriveCode({
        clientId,
        clientSecret,
        code,
        codeVerifier: claimed.codeVerifier,
        redirectUri: claimed.redirectUri,
      });
      reason = "root_folder_failed";
      const rootFolderId = await ensureGoogleDriveRootFolder({ accessToken: tokens.accessToken });
      reason = "credential_store_failed";
      await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "complete_google_drive_oauth",
        {
          p_organization_id: claimed.organizationId,
          p_user_id: claimed.userId,
          p_refresh_token: tokens.refreshToken,
          p_scopes: tokens.scope,
          p_account_email: tokens.accountEmail,
          p_root_folder_id: rootFolderId,
        },
      );
      return redirect(response, `${destination}connected`);
    } catch {
      safeLog("callback_refused", reason);
      return redirect(response, `${destination}failed`);
    }
  }

  try {
    const target = filingTarget(request.body);
    const authorization = target
      ? await filingAuthorization(request, backend, action, target)
      : await userAuthorization(request, backend, action);
    const credential = await serviceCredential(backend, authorization.organizationId);
    const accessToken = await refreshGoogleDriveAccessToken({
      clientId,
      clientSecret,
      refreshToken: credential.refreshToken,
    });
    const rootFolderId = authorization.rootFolderId || credential.rootFolderId;
    if (!rootFolderId) throw Object.assign(new Error("not configured"), { status: 503 });
    // A case or meeting folder is created on the first upload only; listing or
    // downloading from a folder that does not exist yet finds nothing.
    const folderId = target
      ? await resolveGoogleDriveFilingFolder({
        accessToken,
        rootFolderId,
        groupFolderName: authorization.groupFolderName,
        folderName: authorization.folderName,
        create: action === "upload",
        targetKey: `${authorization.targetKind}:${authorization.targetId}`,
        reserveFolder: async ({ parentId, name, targetKey, proposedId }) => {
          const reservation = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
            "reserve_google_drive_filing_folder", {
              p_organization_id: authorization.organizationId, p_root_folder_id: rootFolderId,
              p_parent_folder_id: parentId, p_target_key: targetKey,
              p_folder_name: name, p_proposed_folder_id: proposedId,
            });
          return reservation?.folderId || "";
        },
      })
      : rootFolderId;

    if (action === "list") {
      return json(response, 200, { files: folderId ? await listGoogleDriveFiles({ accessToken, rootFolderId: folderId }) : [] });
    }
    if (action === "upload") {
      const bytes = decodeBoundedBase64(request.body?.contentBase64);
      if (!bytes) {
        return json(response, 413, { error: "drive upload must be between 1 byte and 3 MB" });
      }
      const file = await uploadGoogleDriveFile({
        accessToken,
        rootFolderId: folderId,
        name: request.body?.name,
        mimeType: request.body?.mimeType,
        bytes,
      });
      return json(response, 200, { file });
    }
    if (action === "download") {
      if (!folderId) throw Object.assign(new Error("not found"), { status: 404 });
      const bytes = await downloadGoogleDriveFile({
        accessToken,
        fileId: request.body?.fileId,
        rootFolderId: folderId,
      });
      return json(response, 200, { contentBase64: bytes.toString("base64") });
    }
    return json(response, 404, { error: "unknown google drive action" });
  } catch (error) {
    const failure = publicFailure(error);
    return json(response, failure.status, { error: failure.error });
  }
}
