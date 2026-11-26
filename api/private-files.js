import { decryptInspectedCaseDocument } from "./_lib/sensitiveCaseDocuments.js";
import { decryptInspectedFormDocument, sealedFormInspectionRow } from "./_lib/sensitiveFormDocuments.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { downloadPrivateObjectBytes } from "./_lib/privateFileDownload.js";
import { inspectPrivateFileInWorker } from "./_lib/privateFileInspection.js";
import { privateFileScannerPolicy, scanPrivateFileWithClamd } from "./_lib/privateFileScanner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS = { case: "case-files", task: "chapter-task-files", form: "member-form-files", knowledge: "organization-knowledge" };
// The 60-second attempt lease is the only thing a busy caller waits on; the
// quota window is an hour. Seconds, because that is what Retry-After carries.
//
// `busy` is a POLL INTERVAL, not the remaining wait. The lease
// `authorize_private_upload_inspection` reserves runs for 60 seconds and a
// legitimate inspection may hold most of it (a 10 s download plus a scan
// bounded at 20 s), while the RPC answers `{busy: true}` without saying how
// much of the lease is left. Two seconds therefore told an honest client to
// give up in the middle of somebody else's scan. Five seconds is one poll of a
// scan that is genuinely running; the clients pair it with a budget that
// outlasts the whole lease (PRIVATE_FILE_BUSY_DEADLINE_MS in
// src/lib/privateFileAccess.js and its native twin), so a concurrent
// inspection is waited out instead of exhausting the caller's attempts.
// Polling costs no quota: the RPC returns `busy` before the quota is charged.
const RETRY_AFTER_SECONDS = { busy: 5, rateLimited: 3600 };
// Server-side classification of every refusal this handler can emit. It is
// written to the function log and NEVER to the caller: the response body keeps
// unknown, foreign, removed and unauthorized rows merged into one 403, so the
// endpoint cannot be used to enumerate which fileIds exist.
//
// The one class that IS surfaced is `reauth`: a stale MFA session is a fact
// about the caller's own session, decided by
// `authorize_private_upload_inspection` before p_file_id is looked at, so
// answering it distinctly reveals nothing about any row. Giving it its own 401
// is what lets a client tell "verify it is you" from "this file is not
// available to you" — the distinction native durable recovery needs in order to
// stop retaining a marker for an upload the service reconciler already removed
// (apps/mobile/src/services/attachments.ts).
const REFUSAL = {
  reauth: { status: 401, error: "file-check-reauth-required" },
  authorization: { status: 403, error: "not-authorized" },
  unavailable: { status: 503, error: "file-check-unavailable" },
};

// A refusal and an outage are not the same answer, and only one of them is a
// decision. `authorize_private_upload_inspection` raises `42501` for every
// row-shaped refusal, and PostgREST renders that as 403 (401 when the bearer
// itself is rejected). Everything else that can come back from that call — a
// timeout, a dropped connection, an unparseable body, an upstream 5xx, or the
// 404 of a rollout where the function is not deployed yet — is the server
// failing to decide, and both clients treat a decision as final: the native
// upload path reports that MFA must be repeated, so a transient Supabase
// outage used to strand an upload behind a reauthentication that could not fix
// it.
//
// This split reads ONLY the transport status of the authorization call. It
// never consults the file id, the row or the caller's permissions, so an
// unauthorized caller still receives exactly the 403 an absent row receives
// and the endpoint remains unusable as a file-existence oracle.
function isAuthorizationDecision(error) {
  const status = Number(error?.status);
  return status === 401 || status === 403;
}

// Diagnostics carry the kind and the class, never the fileId, the path, the
// bucket or any part of the caller's token.
function noteRefusal(kind, outcome) {
  console.error("[private-files]", { kind, outcome });
}
// A deliberate structural refusal is the file's own fault and is permanent for
// those bytes: the ledger must record `blocked`, never `failed`. `failed` means
// "we could not decide" and stays retryable, so the two must not be conflated.
// Every alternative below requires its trailing hyphen except the bare
// `private-file-executable`, which is the whole message. That matters for
// `size`: `private-file-size` (from privateFileInspection.js) is a SERVER-side
// bound on the downloaded byte length, not a caller-visible defect, while
// `private-file-size-mismatch` and `private-file-size-invalid-input` from
// privateFileSafety.js are. Matching bare `size` turned the former into a 422
// that told the caller their file was rejected when the server had failed.
const STRUCTURAL_REJECTION = /^private-file-(?:executable(?:-|$)|(?:mime|size|text|image|archive|pdf)-)/;
// Resource exhaustion, the PDF worker mutex and decoder-contract faults are
// server conditions wearing a structural prefix. They stay 503.
const STRUCTURAL_EXCEPTIONS = /budget|busy|decoder-contract/;

// The scanner policy is read and validated as one unit — host, port, both ends
// of the mutual TLS material, the pinned server SubjectPublicKeyInfo and the
// minimum engine version. A drifted or half-configured deployment resolves to
// nothing and the endpoint stays 503; there is no partially trusted scanner.
//
// It is read PER SURFACE, from the same resolved backend that selects the
// Supabase credentials, so the SAMPLE host presents the SAMPLE client
// certificate to the SAMPLE listener and the SaaS host presents its own. A
// surface whose seven values are unset resolves to nothing and stays 503 —
// per surface, never by falling back to the other surface's identity.
function scannerConfig(surface) {
  try { return privateFileScannerPolicy(process.env, surface); }
  catch { return null; }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "not-authorized" });
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2
    || typeof body.kind !== "string" || !Object.hasOwn(BUCKETS, body.kind) || typeof body.fileId !== "string" || !UUID.test(body.fileId)) {
    return json(response, 400, { error: "invalid-file-request" });
  }
  const fileId = body.fileId.toLowerCase();
  const backend = resolveSupabaseBackend(request);
  const config = scannerConfig(backend.surface);
  if (!config || ![backend.url, backend.publishableKey, backend.serviceRoleKey].every(Boolean)) {
    return json(response, 503, { error: "file-check-unavailable" });
  }
  // The API carries only small control messages. File bytes stay in private
  // Storage; an authenticated RPC derives the canonical target and reserves an
  // expiring attempt. Callers cannot supply a path, URL or scanner verdict.
  let target;
  try {
    target = await supabaseRpc(backend.url, backend.publishableKey, token, "authorize_private_upload_inspection", {
      p_kind: body.kind, p_file_id: fileId,
    }, { timeoutMs: 5000 });
  } catch (error) {
    // Deliberately merged: an unknown, foreign, removed or unauthorized row all
    // answer here, identically. A caller learns nothing about existence from
    // this. A transport, timeout, parsing or upstream failure — including the
    // rollout in which the RPC is not deployed yet — is NOT a decision and
    // answers with the retryable 503 instead, so a client stops treating an
    // outage as a permanent refusal.
    if (!isAuthorizationDecision(error)) {
      noteRefusal(body.kind, "authorization-unavailable");
      return json(response, REFUSAL.unavailable.status, { error: REFUSAL.unavailable.error });
    }
    noteRefusal(body.kind, "authorization-or-lifecycle");
    return json(response, REFUSAL.authorization.status, { error: REFUSAL.authorization.error });
  }
  if (target?.reauthRequired === true) {
    noteRefusal(body.kind, "reauth");
    return json(response, REFUSAL.reauth.status, { error: REFUSAL.reauth.error });
  }
  // Both waits are server-known, so the client never has to guess one. The
  // busy hint is one attempt lease turnaround; the quota hint is the hourly
  // window. A client that honours these does not spend its remaining quota on
  // a retry that cannot succeed yet.
  if (target?.rateLimited === true) {
    response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS.rateLimited));
    return json(response, 429, { error: "file-check-rate-limited" });
  }
  if (target?.busy === true) {
    response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS.busy));
    return json(response, 409, { error: "file-check-in-progress" });
  }
  if (target?.fileId === fileId && target.current === true) return json(response, 200, { fileId, status: "clean" });
  if (target?.fileId !== fileId || target.bucketId !== BUCKETS[body.kind]
    || !UUID.test(target.attemptId || "") || !UUID.test(target.objectId || "")
    || !(target.objectVersion === null || (typeof target.objectVersion === "string" && target.objectVersion.length <= 100))) {
    return json(response, 503, { error: "file-check-unavailable" });
  }
  const finish = (verdict, scan = {}) => supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
    "finish_private_upload_inspection", {
      p_attempt_id: target.attemptId, p_verdict: verdict,
      p_sha256: scan.sha256 ?? null, p_engine: scan.engine ?? null,
      p_signature_version: scan.signatureVersion ?? null, p_signature_updated_at: scan.signatureDate ?? null,
      p_scanned_at: scan.scannedAt ?? null,
    }, { timeoutMs: 5000 });
  let structuralRejection = false;
  try {
    // A sealed FMLA form attachment (#5747) is ciphertext at rest, like a case
    // file: its stored bytes cannot match the plaintext hash, so it is opened
    // before the same inspection and scan.
    const sealedForm = body.kind === "form" ? await sealedFormInspectionRow(backend, target) : null;
    const stored = await downloadPrivateObjectBytes(backend, body.kind === "case" || sealedForm ? { ...target, sha256: null } : target, { signal: AbortSignal.timeout(10000) });
    const bytes = body.kind === "case" ? await decryptInspectedCaseDocument(backend, target, stored)
      : sealedForm ? decryptInspectedFormDocument(backend, sealedForm, stored) : stored;
    let inspected;
    try {
      inspected = await inspectPrivateFileInWorker(bytes, {
        filename: target.filename, mimeType: target.mimeType, expectedSize: target.sizeBytes,
      });
    } catch (error) {
      structuralRejection = STRUCTURAL_REJECTION.test(error?.message || "")
        && !STRUCTURAL_EXCEPTIONS.test(error.message);
      throw error;
    }
    const scan = await scanPrivateFileWithClamd(bytes, { config, timeoutMs: 20000 });
    if (scan.sha256 !== inspected.sha256 || scan.sizeBytes !== inspected.sizeBytes
      || inspected.mimeType !== target.mimeType || !["clean", "blocked"].includes(scan.verdict)) throw new Error("inspection-mismatch");
    const result = await finish(scan.verdict, scan);
    if (result?.status !== scan.verdict) throw new Error("inspection-record-unavailable");
    if (scan.verdict === "blocked") return json(response, 422, { error: "file-rejected" });
    return json(response, 200, { fileId, status: "clean" });
  } catch {
    // An expired/superseded attempt cannot overwrite a later verdict. If the
    // verdict write is unavailable the object remains quarantined by default.
    //
    // A deliberate structural refusal is recorded as `blocked`: it is a
    // permanent decision about these exact bytes, and `failed` — "we could not
    // decide" — is retryable and indistinguishable from a scanner outage.
    // Since 20260906020000, `private.record_private_upload_scan` admits a
    // provenance-free `blocked` (all five scanner-provenance arguments null
    // together, so a partial claim is still validated in full), which is what
    // a refusal raised BEFORE the scan ran can honestly supply, so such a
    // refusal records the verdict it deserves. The `failed` fallback below
    // therefore now covers only a ledger write that is itself unavailable, so
    // the row is never left merely `pending`.
    // Every one of pending/failed/blocked denies every gate.
    const recorded = structuralRejection
      && await finish("blocked").then((result) => result?.status === "blocked", () => false);
    if (!recorded) await finish("failed").catch(() => {});
    return json(response, structuralRejection ? 422 : 503,
      { error: structuralRejection ? "file-rejected" : "file-check-unavailable" });
  }
}
