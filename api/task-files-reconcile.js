import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import { productionBackendFromEnv, requestHostname, resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, safeSecretEqual as safeEqual, supabaseHeaders, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";

// Case/task attachment reconciliation
// (REQ-UNION-BASE-TASK-FILES-RECONCILIATION-20260805, G5 two-phase extension).
// Invoked daily two ways, both bearing CRON_SECRET: a pg_cron tick POSTs via
// pg_net at 04:37 UTC — twenty minutes after the 90-day task purge, so bytes
// the purge cascade just orphaned are swept the same morning — and a daily
// Vercel cron GET is the plan-safe backstop. Overlapping invocations are
// harmless: the RPC's deletes are idempotent and the Storage API tolerates
// already-gone paths.
//
// Division of labour: reconcile_chapter_task_files (kept under its stable
// compatibility name and service-role only) owns every SQL-visible decision
// for both private buckets. This endpoint owns the one thing SQL cannot do:
// deleting exact objects through the Storage API so the BYTES leave the
// backing store, then running a zero-page second pass to retire pending rows.
//
// The route is the same for every environment; the request host picks the
// backend and the backend picks the bearer
// (BUG-UG-REMOVED-ATTACHMENTS-NEVER-CLEANED-SERVER-SIDE-20261018).
// The SaaS portal and Vercel cron sweep production under CRON_SECRET. The
// demo portal sweeps the pinned SAMPLE backend only for a database tick POST
// bearing SAMPLE_TASK_FILES_RECONCILE_SECRET, configured on that database by
// public.configure_task_files_reconcile. The checked-in Vercel cron never
// reaches SAMPLE.

// Every private bucket. member-form-files and organization-knowledge carry only
// rowless-object targets (SEC-UG-PRIVATE-BUCKET-ORPHAN-SWEEP-COVERAGE-20260920).
const BUCKETS = new Set(["case-files", "chapter-task-files", "member-form-files", "organization-knowledge"]);
const RPC_TIMEOUT_MS = 20_000;
const DELETE_TIMEOUT_MS = 30_000;
const DELETE_BATCH = 100;
// Mirrors the RPC's own hard cap. Anything past it is reported as remaining
// and becomes the next tick's work — a backlog rolls forward visibly, never
// silently.
const MAX_ORPHANS_PER_RUN = 500;

function logFailure(scope, detail) {
  console.error(`[task-files-reconcile] ${scope}: ${detail}`);
}

export function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function validObjectName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !value.includes("\0");
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDeletionTarget(target) {
  return Boolean(
    target
    && typeof target === "object"
    && !Array.isArray(target)
    && BUCKETS.has(target.bucketId)
    && validObjectName(target.objectName)
  );
}

function deletionTargetKey(bucketId, objectName) {
  return `${bucketId}\0${objectName}`;
}

async function deleteOrphanBatch(supabaseUrl, serviceKey, bucket, names) {
  try {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: supabaseHeaders(serviceKey, serviceKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: names }),
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `storage http ${response.status}` };
    // A 2xx answers with the objects it ACTUALLY removed; a path that was
    // already gone is simply absent from the list. Count what the response
    // confirms rather than what was requested — a 200 carrying an empty list
    // (permission drift, backend filtering) must not read as a finished sweep.
    let confirmed;
    try {
      confirmed = JSON.parse(await response.text());
    } catch {
      confirmed = null;
    }
    if (!Array.isArray(confirmed)) return { ok: false, recoverable: false, reason: "storage malformed response" };
    const confirmedNames = confirmed.map((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string"
        ? entry.name
        : null
    ));
    const expected = new Set(names);
    const actual = new Set(confirmedNames.filter(Boolean));
    if (confirmedNames.some((name) => !name)
      || actual.size !== confirmedNames.length
      || [...actual].some((name) => !expected.has(name))) {
      return {
        ok: false,
        recoverable: false,
        reason: "storage returned malformed or unexpected object confirmations",
      };
    }
    const missingNames = names.filter((name) => !actual.has(name));
    if (missingNames.length > 0) {
      return {
        ok: false,
        recoverable: true,
        confirmedNames: [...actual],
        missingNames,
        reason: "storage did not confirm the exact requested objects",
      };
    }
    return { ok: true, confirmedNames: [...actual], missingNames: [] };
  } catch (error) {
    const name = error?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        recoverable: true,
        confirmedNames: [],
        missingNames: names,
        reason: "storage timeout",
      };
    }
    return {
      ok: false,
      recoverable: true,
      confirmedNames: [],
      missingNames: names,
      reason: "storage network",
    };
  }
}

// The RPC's answer is the sole authority for what gets deleted, so a response
// that lost its shape must stop the run — defaulting a missing counter to zero
// would let a contract drift report a clean pass forever.
export function malformedReport(report, { requireExpectedObjects = false } = {}) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return true;
  if (!Array.isArray(report.orphanObjects)) return true;
  if (report.objectDeletes !== undefined && !Array.isArray(report.objectDeletes)) return true;
  if (Array.isArray(report.objectDeletes)
    && report.objectDeletes.some((target) => !validDeletionTarget(target))) return true;
  if (requireExpectedObjects && !Array.isArray(report.expectedObjectsRemaining)) return true;
  if (report.expectedObjectsRemaining !== undefined
    && (!Array.isArray(report.expectedObjectsRemaining)
      || report.expectedObjectsRemaining.some((target) => !validDeletionTarget(target)))) return true;
  const counters = ["staleRowsRemoved", "staleRowsSkippedBlind", "orphanTotal"];
  if (report.objectDeletes !== undefined) counters.push(
    "objectDeleteTotal",
    "pendingRowsClaimed",
    "removalRowsRetired",
    "removalObjectTotal",
  );
  if (counters.some((key) => !validCounter(report[key]))) return true;
  if (typeof report.ranAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(report.ranAt)
    || !Number.isFinite(Date.parse(report.ranAt))) return true;

  if (Array.isArray(report.objectDeletes)) {
    const uniqueTargets = new Set(report.objectDeletes.map(
      (target) => `${target.bucketId}\0${target.objectName}`,
    ));
    if (report.objectDeleteTotal < uniqueTargets.size) return true;
    if (report.removalObjectTotal > report.objectDeleteTotal) return true;
  } else {
    const uniqueLegacyNames = new Set(report.orphanObjects.filter(validObjectName));
    if (report.orphanTotal < uniqueLegacyNames.size) return true;
  }
  return false;
}

function deletionTargets(report) {
  if (Array.isArray(report.objectDeletes)) {
    return report.objectDeletes.map((target) => ({
      bucketId: target.bucketId,
      objectName: target.objectName,
    }));
  }
  // Rolling-deploy compatibility: the preceding RPC shape reported only task
  // bucket names. It remains safe to honor until every environment has the
  // two-bucket migration.
  return report.orphanObjects
    .filter(validObjectName)
    .map((objectName) => ({ bucketId: "chapter-task-files", objectName }));
}

async function runReconcileRpc(supabaseUrl, serviceKey, cap, expectedDeletedObjects) {
  const parameters = { p_max_orphan_objects: cap };
  if (expectedDeletedObjects) parameters.p_expected_deleted_objects = expectedDeletedObjects;
  return supabaseRpc(
    supabaseUrl,
    serviceKey,
    serviceKey,
    "reconcile_chapter_task_files",
    parameters,
    { timeoutMs: RPC_TIMEOUT_MS },
  );
}

function usableReconcileSecret(value) {
  const secret = String(value || "");
  const hasControlCharacter = Array.from(secret).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return secret.length >= 32 && secret.length <= 512 && !hasControlCharacter;
}

// The demo-portal sweep deletes bytes with a service key, so it must prove the
// backend is the pinned SAMPLE project and that neither the key nor the bearer
// is shared with production or with another dispatcher.
export function sampleIsolationFailure(backend, env = process.env) {
  const production = productionBackendFromEnv(env);
  const pinnedSampleUrl = pinnedSampleSupabaseOrigin().replace(/\/$/, "");
  if (!backend.url || backend.url !== pinnedSampleUrl || !backend.serviceRoleKey) {
    return "sample_backend_isolation_required";
  }
  const backendCredentialCollision = [
    production.publishableKey,
    production.serviceRoleKey,
    backend.publishableKey,
  ].filter(Boolean).some((credential) => safeEqual(backend.serviceRoleKey, credential));
  if ((production.url && production.url === backend.url) || backendCredentialCollision) {
    return "sample_backend_isolation_required";
  }
  // Called only after the bearer matched a usable SAMPLE secret.
  const sampleSecret = env.SAMPLE_TASK_FILES_RECONCILE_SECRET;
  const forbiddenSecrets = [
    env.CRON_SECRET,
    env.SAMPLE_NOTIFICATION_DISPATCH_SECRET,
    env.SAMPLE_INTEGRATION_DISPATCH_SECRET,
    env.INTEGRATION_DISPATCH_SECRET,
    production.publishableKey,
    production.serviceRoleKey,
    backend.publishableKey,
    backend.serviceRoleKey,
  ].filter(Boolean);
  if (forbiddenSecrets.some((secret) => safeEqual(sampleSecret, secret))) {
    return "sample_reconcile_secret_isolation_required";
  }
  return null;
}

async function handleSampleReconcile(request, response, backend) {
  if (request.method !== "POST") {
    json(response, 405, { error: "method not allowed" });
    return;
  }
  // Only the SAMPLE database's pg_net tick (or an operator POST) reaches this
  // branch. A Vercel cron marker is refused even with the SAMPLE bearer.
  if (requestHostname(request) !== "demo.example.com" || request.headers["x-vercel-cron"] !== undefined) {
    json(response, 404, { error: "not available" });
    return;
  }
  const reconcileSecret = process.env.SAMPLE_TASK_FILES_RECONCILE_SECRET;
  if (!usableReconcileSecret(reconcileSecret) || !safeEqual(bearerToken(request), reconcileSecret)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const isolationFailure = sampleIsolationFailure(backend);
  if (isolationFailure) {
    json(response, 503, { error: isolationFailure });
    return;
  }
  await reconcile(response, backend.url, backend.serviceRoleKey, { surface: "demo" });
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "method not allowed" }))) return;
  // Fail closed: a missing, short or placeholder CRON_SECRET authorizes nobody.
  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") {
    await handleSampleReconcile(request, response, backend);
    return;
  }
  const cron = cronAuthorization(request);
  if (!cron.ok) {
    json(response, cron.status, cronRefusalBody(cron));
    return;
  }
  const { url: supabaseUrl, serviceRoleKey: serviceKey } = backend;
  if (requireEnv([supabaseUrl, serviceKey], () => json(response, 503, { error: "not configured" }))) return;
  await reconcile(response, supabaseUrl, serviceKey);
}

// One sweep against one already-authorized backend. `labels` is merged into
// every answer so a SAMPLE tick's net._http_response row names its surface.
async function reconcile(response, supabaseUrl, serviceKey, labels = {}) {
  const respond = (status, payload) => json(response, status, { ...labels, ...payload });
  const startedAt = Date.now();

  let report;
  try {
    report = await runReconcileRpc(supabaseUrl, serviceKey, MAX_ORPHANS_PER_RUN);
  } catch (error) {
    const reason = String(error?.message || error);
    logFailure("rpc", reason);
    respond(500, { error: reason, elapsedMs: Date.now() - startedAt });
    return;
  }

  if (malformedReport(report)) {
    logFailure("rpc", "reconcile report lost its shape");
    respond(500, { error: "malformed reconcile report", elapsedMs: Date.now() - startedAt });
    return;
  }

  const targets = deletionTargets(report);
  const exactAbsenceProofSupported = Array.isArray(report.objectDeletes);
  const byBucket = new Map();
  for (const target of targets) {
    const names = byBucket.get(target.bucketId) ?? [];
    if (!names.includes(target.objectName)) names.push(target.objectName);
    byBucket.set(target.bucketId, names);
  }

  const confirmedObjectKeys = new Set();
  const unconfirmedObjectKeys = new Set();
  let requestedObjects = 0;
  let hardFailedBatches = 0;
  for (const [bucket, bucketNames] of byBucket) {
    for (const names of chunk(bucketNames, DELETE_BATCH)) {
      requestedObjects += names.length;
      const outcome = await deleteOrphanBatch(supabaseUrl, serviceKey, bucket, names);
      for (const name of outcome.confirmedNames ?? []) {
        confirmedObjectKeys.add(deletionTargetKey(bucket, name));
      }
      if (outcome.ok) {
        continue;
      }
      if (outcome.recoverable) {
        for (const name of outcome.missingNames) {
          unconfirmedObjectKeys.add(deletionTargetKey(bucket, name));
        }
        logFailure("delete", `${outcome.reason} (${outcome.missingNames.length} object(s) require exact absence proof)`);
      } else {
        hardFailedBatches += 1;
        logFailure("delete", `${outcome.reason} (${names.length} object(s) kept for the next run)`);
      }
    }
  }

  let cleanupReport = null;
  if (requestedObjects > 0) {
    try {
      cleanupReport = await runReconcileRpc(
        supabaseUrl,
        serviceKey,
        0,
        exactAbsenceProofSupported ? targets : undefined,
      );
    } catch (error) {
      const reason = String(error?.message || error);
      logFailure("post-delete-rpc", reason);
      respond(500, { error: reason, elapsedMs: Date.now() - startedAt });
      return;
    }
    if (malformedReport(cleanupReport, { requireExpectedObjects: exactAbsenceProofSupported })) {
      logFailure("post-delete-rpc", "reconcile report lost its shape");
      respond(500, { error: "malformed post-delete reconcile report", elapsedMs: Date.now() - startedAt });
      return;
    }
  }

  const orphanTotal = Number(report.orphanTotal);
  const objectDeleteTotal = Number(report.objectDeleteTotal ?? report.orphanTotal);
  const requestedObjectKeys = new Set(targets.map(
    (target) => deletionTargetKey(target.bucketId, target.objectName),
  ));
  const remainingObjectKeys = new Set((cleanupReport?.expectedObjectsRemaining ?? []).map(
    (target) => deletionTargetKey(target.bucketId, target.objectName),
  ));
  if ([...remainingObjectKeys].some((key) => !requestedObjectKeys.has(key))) {
    logFailure("post-delete-rpc", "exact absence report named an unrequested object");
    respond(500, { error: "malformed post-delete reconcile report", elapsedMs: Date.now() - startedAt });
    return;
  }
  const deletedObjects = [...confirmedObjectKeys]
    .filter((key) => !remainingObjectKeys.has(key)).length;
  // Only the new RPC shape can prove that an unconfirmed Storage target is
  // already absent. During a rolling database deploy the legacy second pass
  // has no expected-target oracle at all, so every unconfirmed name must stay
  // unresolved instead of being inferred absent from a missing field.
  const alreadyAbsentObjects = exactAbsenceProofSupported
    ? [...unconfirmedObjectKeys].filter((key) => !remainingObjectKeys.has(key)).length
    : 0;
  const unresolvedObjects = exactAbsenceProofSupported
    ? remainingObjectKeys.size
    : unconfirmedObjectKeys.size;
  const staleRowsSkippedBlind = Math.max(
    Number(report.staleRowsSkippedBlind),
    Number(cleanupReport?.staleRowsSkippedBlind ?? 0),
  );
  const body = {
    staleRowsRemoved: Number(report.staleRowsRemoved) + Number(cleanupReport?.staleRowsRemoved ?? 0),
    pendingRowsClaimed: Number(report.pendingRowsClaimed ?? 0),
    removalRowsRetired: Number(report.removalRowsRetired ?? 0)
      + Number(cleanupReport?.removalRowsRetired ?? 0),
    removalObjectTotal: Number(report.removalObjectTotal ?? 0),
    staleRowsSkippedBlind,
    orphanTotal,
    objectDeleteTotal,
    requestedObjects,
    deletedObjects,
    alreadyAbsentObjects,
    remainingOrphans: Math.max(0, objectDeleteTotal - deletedObjects - alreadyAbsentObjects),
    elapsedMs: Date.now() - startedAt,
  };

  // A cron that always reports success is a cron nobody watches: anything that
  // kept the sweep from finishing has to come back non-2xx so it lands in the
  // Vercel logs and in net._http_response next to the tick that caused it.
  if (hardFailedBatches > 0 || unresolvedObjects > 0) {
    const failedBatches = hardFailedBatches + (unresolvedObjects > 0 ? 1 : 0);
    respond(502, { ...body, error: `${failedBatches} object-delete batch(es) failed` });
    return;
  }
  // A 2xx sweep requires an exact receipt for every requested object. Storage
  // absence is not inferred from an empty or partial delete response; a later
  // reconciliation pass can explicitly prove absence before metadata retires.
  if (requestedObjects > 0 && deletedObjects + alreadyAbsentObjects !== requestedObjects) {
    respond(502, { ...body, error: "storage did not confirm every requested deletion" });
    return;
  }
  if (staleRowsSkippedBlind > 0) {
    respond(500, { ...body, error: "reconcile RPC cannot see the bucket; stale rows left in place" });
    return;
  }
  respond(200, body);
}
