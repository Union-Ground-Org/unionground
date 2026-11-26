import { resolveSupabaseBackend } from "./_lib/backend.js";
import { createHash } from "node:crypto";
import { bearerToken, json, methodGuard, requireEnv, supabaseHeaders, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import {
  chunkKnowledgeText,
  extractKnowledgeText,
  publicIngestError,
  resolveKnowledgeConverter,
} from "./_lib/knowledgeIngest.js";

const INVOCATION_BUDGET_MS = 50_000;
const CLEANUP_RESERVE_MS = 5_000;

function remainingRequestMs(deadlineAt, cap = 20_000) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 500) throw new Error("knowledge-ingest-time-budget");
  return Math.max(250, Math.min(cap, remaining));
}

// THE VERDICT IS RE-ESTABLISHED IMMEDIATELY BEFORE THE PRIVILEGED READ.
//
// `authorize_knowledge_ingest` checks `private_upload_is_current` and then
// hands back a bucket and an object name that this handler reads with the
// SERVICE ROLE — the one path in the product where knowledge bytes leave
// Storage without the restrictive quarantine policy being evaluated. The
// completion RPC (and the inert, uncalled CBA draft writer) re-read the verdict
// under the owning `storage.objects` lock
// (20260906024000 / 20260906026000), so nothing can be INDEXED on a lapsed
// verdict; this closes the other end, so nothing is DOWNLOADED and EXTRACTED
// on one either.
//
// `authorize_private_upload_inspection` is the re-check because it is the
// caller's own JWT asking the same ledger predicate the storage policy asks,
// with MFA and the feature ACL applied, and because an object that is already
// current short-circuits inside the RPC before the attempt lease and the
// hourly quota are touched — so the ordinary path costs nothing. Only an
// explicit `{fileId, current: true}` for this exact file proceeds: `busy`,
// `rateLimited`, `reauthRequired` and a full attempt target all mean the
// verdict is not current right now, and this handler must not extract bytes on
// a maybe. It carries no path, digest or verdict outward — invariant 1 is
// unchanged.
async function assertVerdictStillCurrent(backend, token, target, deadlineAt) {
  const fileId = String(target?.fileId || "");
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error("knowledge-verdict-unavailable");
  let verdict;
  try {
    verdict = await supabaseRpc(backend.url, backend.publishableKey, token,
      "authorize_private_upload_inspection", { p_kind: "knowledge", p_file_id: fileId },
      { timeoutMs: remainingRequestMs(deadlineAt) });
  } catch {
    throw new Error("knowledge-verdict-unavailable");
  }
  if (verdict?.current !== true || String(verdict?.fileId || "").toLowerCase() !== fileId.toLowerCase()) {
    throw new Error("knowledge-file-inspection-required");
  }
}

async function downloadObject(backend, target, deadlineAt) {
  const path = String(target.objectName || "").split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${backend.url}/storage/v1/object/authenticated/${encodeURIComponent(target.bucketId)}/${path}`, {
    headers: supabaseHeaders(backend.serviceRoleKey, backend.serviceRoleKey),
    signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
  });
  if (!response.ok) throw Object.assign(new Error("knowledge-storage-download-failed"), { status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== Number(target.byteSize) || bytes.length > 10 * 1024 * 1024) {
    throw new Error("knowledge-storage-size-mismatch");
  }
  // Computed from what actually arrived, not copied from the authorization that
  // promised it. This digest is what the provenance ledger records, so it has to
  // describe the bytes that were converted rather than the bytes that were
  // expected — those are the same value only when nothing went wrong.
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (target.contentSha256 && sourceSha256 !== target.contentSha256) {
    throw new Error("knowledge-storage-digest-mismatch");
  }
  return { bytes, sourceSha256 };
}

// THE ONE ERROR THE PROVENANCE WRITE IS ALLOWED TO SURVIVE.
//
// `public.record_knowledge_conversion` is created by migration 20260907110000,
// whose hosted application is a separately sequenced `hosted-schema-cutover`
// gate. Between the deploy of this code and that apply the function does not
// exist, and an unguarded call would turn EVERY knowledge ingest into a 422 —
// a total outage of a working feature, not a degraded mode.
//
// So exactly one failure is tolerated: a 404 stating that the function is not
// there yet. PostgREST answers `PGRST202` when the function is missing from its
// schema cache. PostgreSQL `42883` can also be surfaced for a missing helper or
// overload inside an existing function, so it is never a rollout-window signal.
// Every other failure — a refusal, a timeout, a constraint, a write whose
// statement may have committed — still propagates and still stops the ingest,
// so provenance-before-content holds in full the moment the function exists.
// carries the rollout window and the
// order the controller should sequence it in.
const RPC_FUNCTION_NOT_FOUND = new Set(["PGRST202"]);

function rpcFunctionMissing(error) {
  return Number(error?.status) === 404 && RPC_FUNCTION_NOT_FOUND.has(String(error?.code ?? ""));
}

// PROVENANCE IS WRITTEN BEFORE THE CONTENT IT EXPLAINS.
//
// If the chunk write landed first and this failed, the product would hold
// model-grounding text with no record of where it came from — the exact gap
// REQ-UG-DOCUMENT-CONVERSION-PROVENANCE exists to close. In the other order
// the worst case is a recorded attempt whose content was refused, which is true
// and useful. The RPC derives the attempt number and change kind itself, so
// nothing here can relabel a changed source as a retry.
async function recordConversion(backend, target, sourceId, provenance, deadlineAt) {
  if (!provenance) return null;
  try {
    await supabaseRpc(
      backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "record_knowledge_conversion", {
        p_organization_id: target.organizationId,
        p_source_id: sourceId,
        p_actor_user_id: target.actorUserId,
        p_conversion: provenance,
      }, { timeoutMs: remainingRequestMs(deadlineAt) },
    );
    return true;
  } catch (error) {
    if (!rpcFunctionMissing(error)) throw error;
    // Structured so an operator can alert on it, and deliberately identifier
    // free: this line says the schema is behind the code, which is a property
    // of the deployment and not of any organization, source or member.
    console.warn(JSON.stringify({
      event: "knowledge-conversion-provenance-unavailable",
      rpc: "record_knowledge_conversion",
      status: Number(error?.status) || null,
      code: String(error?.code ?? ""),
      migration: "20260907110000_knowledge_conversion_provenance",
      detail: "conversion provenance was not recorded; apply the migration to the hosted database",
    }));
    return null;
  }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  const startedAt = Date.now();
  const operationDeadlineAt = startedAt + INVOCATION_BUDGET_MS - CLEANUP_RESERVE_MS;
  const hardDeadlineAt = startedAt + INVOCATION_BUDGET_MS;
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method not allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey], () => json(response, 503, { error: "not configured" }))) return;
  const token = bearerToken(request);
  const sourceId = String(request.body?.sourceId || "");
  if (!token || !/^[0-9a-f-]{36}$/i.test(sourceId)) return json(response, 401, { error: "not authorized" });

  let target;
  try {
    target = await supabaseRpc(backend.url, backend.publishableKey, token, "authorize_knowledge_ingest", {
      p_source_id: sourceId,
    }, { timeoutMs: remainingRequestMs(operationDeadlineAt) });
    if (target?.rateLimited) {
      return json(response, 429, { error: "knowledge ingestion is busy; try again later" });
    }
  } catch (error) {
    return json(response, Number(error?.status || 403), { error: "not authorized" });
  }

  // Carried out of the try so the failure path can record the same attempt it
  // would have recorded on success. A conversion that failed is provenance too:
  // "this converter, at this version, could not read these bytes" is the answer
  // to a question an operator will otherwise have to guess at.
  let converter = null;
  let sourceSha256 = null;
  let conversionRecorded = false;
  try {
    await assertVerdictStillCurrent(backend, token, target, operationDeadlineAt);
    const downloaded = await downloadObject(backend, target, operationDeadlineAt);
    const bytes = downloaded.bytes;
    sourceSha256 = downloaded.sourceSha256;
    converter = resolveKnowledgeConverter(target.fileName, target.mimeType);
    remainingRequestMs(operationDeadlineAt);
    const extractionStartedAt = Date.now();
    const content = await extractKnowledgeText(bytes, target.fileName, target.mimeType, {
      signal: AbortSignal.timeout(remainingRequestMs(operationDeadlineAt, INVOCATION_BUDGET_MS)),
    });
    const extractionMs = Date.now() - extractionStartedAt;
    remainingRequestMs(operationDeadlineAt);
    const chunks = chunkKnowledgeText(content);
    conversionRecorded = Boolean(await recordConversion(backend, target, sourceId, converter && {
      ...converter,
      sourceSha256,
      sourceByteSize: bytes.length,
      outcome: "succeeded",
      metadata: {
        inputBytes: bytes.length,
        outputCharacters: content.length,
        chunkCount: chunks.length,
        extractionMs,
      },
    }, operationDeadlineAt));
    const result = await supabaseRpc(
      backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "replace_knowledge_source_chunks", {
        p_organization_id: target.organizationId,
        p_source_id: sourceId,
        p_actor_user_id: target.actorUserId,
        p_chunks: chunks,
        p_error_code: null,
      }, { timeoutMs: remainingRequestMs(operationDeadlineAt) },
    );
    // No contract-article drafts: Union Ground has no CBA ingest (owner
    // decision D5), so replace_cba_knowledge_drafts stays inert and uncalled,
    // whatever category the document was filed under.
    return json(response, 200, { source: result });
  } catch (error) {
    const errorCode = publicIngestError(error);
    // BEST-EFFORT, AND DELIBERATELY SO.
    //
    // This marks the source failed and clears its chunks — but
    // `replace_knowledge_source_chunks` is itself gated by
    // `private.knowledge_source_object_verdict_locked`, so when the reason we
    // are here is that the verdict LAPSED, this write is refused too (42501)
    // and swallowed below: the source keeps its previous health and chunks and
    // only the 422 reaches the caller. That is the gate working, not a gap — no
    // service-role write touches a source whose file is no longer cleanly
    // inspected — and it is safe because the read-path gates deny retrieval,
    // review and publication on the same predicate. On every other failure the
    // verdict is still current, so the write lands and the source is recorded
    // failed. docs/security/private-upload-inspection.md §6 states both halves.
    const cleanupRemaining = hardDeadlineAt - Date.now();
    if (cleanupRemaining >= 500) {
      // Best-effort like the cleanup write beside it, and for the same reason:
      // a failure to record why the ingest failed must not replace the error the
      // caller is owed. A file whose type was never ingestible has no converter
      // and therefore no attempt to record.
      if (converter && sourceSha256 && !conversionRecorded) {
        await recordConversion(backend, target, sourceId, {
          ...converter,
          sourceSha256,
          sourceByteSize: Number(target.byteSize),
          outcome: "failed",
          errorCode,
          metadata: {},
        }, hardDeadlineAt).catch(() => {});
      }
      await supabaseRpc(
        backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
        "replace_knowledge_source_chunks", {
          p_organization_id: target.organizationId,
          p_source_id: sourceId,
          p_actor_user_id: target.actorUserId,
          p_chunks: [],
          p_error_code: errorCode,
        }, { timeoutMs: Math.min(CLEANUP_RESERVE_MS, cleanupRemaining) },
      ).catch(() => {});
    }
    return json(response, 422, { error: errorCode });
  }
}
