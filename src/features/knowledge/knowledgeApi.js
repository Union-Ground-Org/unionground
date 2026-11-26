import { normalizeUploadFile } from "../../lib/heicNormalization.js";
import { downloadPrivateFileBlob, requestPrivateFileInspection } from "../../lib/privateFileAccess.js";

function operationError(label, error) {
  const wrapped = new Error(error?.message || `${label} failed`);
  wrapped.code = error?.code;
  // The server's machine token, when it sent one (for example
  // knowledge_file_external_unsupported), so the panel can translate it.
  wrapped.details = error?.details ?? null;
  wrapped.cause = error;
  return wrapped;
}

async function rpc(client, name, params = {}, label = name) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw operationError(label, error);
  return data;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

async function pagedRpc(client, name, params, pageSize, label) {
  const rows = [];
  let cursor = { p_cursor_created_at: null, p_cursor_id: null };
  let cursorSignature = null;
  while (true) {
    const page = array(await rpc(client, name, { ...params, ...cursor }, label));
    rows.push(...page);
    if (page.length < pageSize) return rows;
    const last = page.at(-1);
    const nextCursor = {
      p_cursor_created_at: last?.createdAt,
      p_cursor_id: last?.id,
    };
    if (!nextCursor.p_cursor_created_at || !nextCursor.p_cursor_id) {
      throw new Error(`${label} returned an invalid page cursor`);
    }
    const nextSignature = `${nextCursor.p_cursor_created_at}:${nextCursor.p_cursor_id}`;
    if (nextSignature === cursorSignature) throw new Error(`${label} repeated a page cursor`);
    cursor = nextCursor;
    cursorSignature = nextSignature;
  }
}

export async function loadKnowledgeWorkspace(client, {
  staff = false,
  health = false,
  chapterId = null,
} = {}) {
  if (!client) return {
    collections: [], catalog: [], sources: [], files: [], chapters: [],
    embedding: { status: "unset", connected: false },
    drive: { status: "unset", connected: false },
  };
  const base = await Promise.all([
    rpc(client, "list_knowledge_collections", {
      p_chapter_id: staff ? chapterId || null : null,
    }, "Load knowledge collections"),
    pagedRpc(client, "list_resource_catalog_page", { p_query: null, p_category: null }, 80, "Load resource catalog"),
    rpc(client, "get_google_drive_activation", {}, "Load Google Drive status"),
  ]);
  let sources = [];
  let files = [];
  let chapters = [];
  let embedding = { status: "unset", connected: false };
  if (staff) {
    [files, chapters] = await Promise.all([
      pagedRpc(client, "list_steward_library_files_page", {
        p_query: null, p_status: null, p_category: null,
      }, 80, "Load steward library"),
      rpc(client, "list_knowledge_upload_chapters", {}, "Load upload chapters"),
    ]);
  }
  let sourceHealth = null;
  if (health) {
    [sources, embedding, sourceHealth] = await Promise.all([
      pagedRpc(client, "list_knowledge_ingest_sources_page", {}, 100, "Load ingestion health"),
      rpc(client, "get_knowledge_embedding_activation", {}, "Load embedding status"),
      // REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001: the hourly
      // roll-up. A soft read: the card keeps its per-source list without it.
      rpc(client, "get_knowledge_source_health", {}, "Load source health check").catch(() => null),
    ]);
  }
  return {
    collections: array(base[0]),
    catalog: array(base[1]),
    drive: base[2] || { status: "unset", connected: false },
    sources: array(sources),
    files: array(files),
    chapters: array(chapters),
    embedding: embedding || { status: "unset", connected: false },
    sourceHealth: sourceHealth && typeof sourceHealth === "object" && !Array.isArray(sourceHealth) ? sourceHealth : null,
  };
}

export function saveKnowledgeCollection(client, fields) {
  return rpc(client, "save_knowledge_collection", {
    p_collection_id: fields.collectionId || null,
    p_title: fields.title,
    p_description: fields.description || "",
    p_visibility: fields.visibility || "organization",
    p_scope: fields.scope || "chapter",
    p_chapter_id: fields.chapterId || null,
  }, "Save knowledge collection");
}

export function setKnowledgeCollectionItem(client, fields) {
  return rpc(client, "set_knowledge_collection_item", {
    p_collection_id: fields.collectionId,
    p_item_kind: fields.itemKind,
    p_item_id: fields.itemId,
    p_include: fields.include !== false,
    p_sort_order: fields.sortOrder ?? 500,
    p_chapter_id: fields.chapterId || null,
  }, "Update collection placement");
}

export function deleteKnowledgeCollection(client, collectionId, chapterId = null) {
  return rpc(client, "delete_knowledge_collection", {
    p_collection_id: collectionId,
    p_chapter_id: chapterId || null,
  }, "Delete knowledge collection");
}

export async function listKnowledgeReviewArticles(client, chapterId) {
  return array(await rpc(client, "list_knowledge_review_articles_snapshot", {
    p_chapter_id: chapterId,
  }, "Load review articles"));
}

export function listKnowledgeRevisions(client, articleId, chapterId = null) {
  return rpc(client, "list_chapter_kb_revisions", {
    p_article_id: articleId,
    p_chapter_id: chapterId,
  }, "Load revision history");
}

export function restoreKnowledgeRevision(client, articleId, revisionId, confirmVerified, chapterId = null) {
  return rpc(client, "restore_chapter_kb_revision", {
    p_article_id: articleId,
    p_revision_id: revisionId,
    p_confirm_verified: Boolean(confirmVerified),
    p_idempotency_key: crypto.randomUUID(),
    p_chapter_id: chapterId,
  }, "Restore knowledge revision");
}

export async function retryKnowledgeSource(client, sourceId) {
  const response = await fetch("/api/knowledge-ingest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await sessionToken(client)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourceId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw operationError("Ingest knowledge source", { message: result.error || `HTTP ${response.status}` });
  return result.source;
}

export function getKnowledgeIngestSource(client, sourceId) {
  return rpc(client, "get_knowledge_ingest_source", {
    p_source_id: sourceId,
  }, "Load ingest source");
}

export function retryKnowledgeIngestSource(client, sourceId, idempotencyKey = crypto.randomUUID()) {
  return rpc(client, "retry_knowledge_ingest_source", {
    p_source_id: sourceId,
    p_idempotency_key: idempotencyKey,
  }, "Retry ingest source");
}

const CONVERSION_BASE_COLUMNS = "id,organization_id,source_id,file_id,attempt,outcome,error_code,change_kind,converted_at,conversion_reviewed_at,conversion_reviewed_by";
const CONVERSION_REVIEW_COLUMNS = "review_status,rejection_reason";

// `review_status` and `rejection_reason` reach hosted projects only at the
// separately sequenced `hosted-schema-cutover` gate. Between this code
// deploying and that apply, PostgREST answers `42703` / `PGRST204` for those
// two columns. An unguarded select would raise a panel-wide alert on every
// knowledge-workspace load for every staff user. Probe once per session: if
// the columns are absent, retry with the pre-existing set and keep using it.
let conversionReviewColumnsAvailable = null;

export function isMissingConversionReviewColumnError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "42703" || code === "PGRST204"
    || /column .* does not exist/i.test(message)
    || /could not find the ['"].*['"] column/i.test(message);
}

export function resetKnowledgeConversionReviewColumnProbe() {
  conversionReviewColumnsAvailable = null;
}

/**
 * The authoritative answer to "can this deployment write a rejection yet?".
 *
 * Callers must not infer it from the listed rows: an empty list carries no
 * row to read the flag from, and `[].every(...)` is `true`, which would report
 * a pre-cutover deployment as ready and hide the Deny hint.
 */
export function knowledgeConversionReviewColumnsAvailable() {
  return conversionReviewColumnsAvailable !== false;
}

function shapeKnowledgeConversion(row, { reviewColumnsAvailable = true } = {}) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    attempt: row.attempt,
    outcome: row.outcome,
    errorCode: row.error_code || null,
    changeKind: row.change_kind,
    convertedAt: row.converted_at,
    reviewedAt: row.conversion_reviewed_at || null,
    reviewedBy: row.conversion_reviewed_by || null,
    reviewStatus: reviewColumnsAvailable ? row.review_status || null : null,
    rejectionReason: reviewColumnsAvailable ? row.rejection_reason || null : null,
    reviewColumnsAvailable,
  };
}

function conversionSelect(includeReview) {
  return includeReview
    ? `${CONVERSION_BASE_COLUMNS},${CONVERSION_REVIEW_COLUMNS}`
    : CONVERSION_BASE_COLUMNS;
}

const KNOWLEDGE_CONVERSION_PAGE_SIZE = 20;
const KNOWLEDGE_CONVERSION_MAX_PAGE_SIZE = 100;

// The whole point of this read is a bounded window, so the caller's page size is
// bounded rather than trusted: `.limit()` would take -1, 1000000 or the string
// "10" verbatim, and `hasMore` compares `rows.length === pageSize`, which a
// non-integer silently breaks. Anything that is not a positive integer falls
// back to the default; anything larger than the cap is clamped to it.
function conversionPageSize(value) {
  if (!Number.isInteger(value) || value <= 0) return KNOWLEDGE_CONVERSION_PAGE_SIZE;
  return Math.min(value, KNOWLEDGE_CONVERSION_MAX_PAGE_SIZE);
}

const CONVERSION_CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An ISO-8601 instant as PostgREST returns it. Deliberately a whitelist: the
// value is interpolated into an `or` filter expression, which takes a filter
// grammar rather than a bound parameter, so nothing outside this alphabet may
// reach it.
const CONVERSION_CURSOR_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$/;

// PostgREST has no row-value comparison, so the keyset is spelled out: strictly
// older, or the same instant with a smaller id. Ordering on converted_at alone
// would drop every row that shares an instant with the last row of a page, and
// a batch conversion writes several attempts in one transaction.
function conversionKeyset(cursor) {
  const convertedAt = String(cursor?.convertedAt || "");
  const id = String(cursor?.id || "");
  if (!CONVERSION_CURSOR_AT.test(convertedAt) || !CONVERSION_CURSOR_ID.test(id)) {
    throw new Error("Load knowledge conversions received an invalid page cursor");
  }
  return `converted_at.lt."${convertedAt}",and(converted_at.eq."${convertedAt}",id.lt.${id})`;
}

// The ledger is read in two sections so a settled decision can never spend a
// page a reviewer needs for actionable work, while staying reachable. Each
// section is keyset-paginated on its own, which an ordering trick plus an
// offset could not do without skipping rows as decisions are recorded.
const KNOWLEDGE_CONVERSION_SECTIONS = Object.freeze(["needs_review", "settled"]);

function queryKnowledgeConversions(client, includeReview, {
  organizationId,
  section = "needs_review",
  cursor = null,
  pageSize = KNOWLEDGE_CONVERSION_PAGE_SIZE,
} = {}) {
  let query = client.from("organization_knowledge_conversions")
    .select(conversionSelect(includeReview))
    // The ledger is organization-scoped and a reviewer may be staff in more
    // than one organization. Without this filter the newest page interleaves
    // organizations with nothing on screen saying which row belongs to which.
    .eq("organization_id", organizationId);
  query = section === "settled"
    ? query.not("conversion_reviewed_at", "is", null)
    : query.is("conversion_reviewed_at", null);
  if (cursor) query = query.or(conversionKeyset(cursor));
  return query
    .order("converted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
}

function conversionPage(data, reviewColumnsAvailable, pageSize) {
  const rows = array(data);
  const conversions = rows.map((row) => shapeKnowledgeConversion(row, { reviewColumnsAvailable }));
  const last = rows.at(-1);
  // A full page is the only evidence a next page may exist; a short page is the
  // end of the list. The cursor is the last row's own sort key, so a decision
  // recorded between two reads cannot make a later page skip an unread row.
  const hasMore = rows.length === pageSize && Boolean(last?.converted_at) && Boolean(last?.id);
  return {
    conversions,
    hasMore,
    nextCursor: hasMore ? { convertedAt: last.converted_at, id: last.id } : null,
  };
}

/**
 * One page of ONE organization's conversion ledger, newest first.
 *
 * `section` is `needs_review` (the default) or `settled`. Returns
 * `{ section, conversions, hasMore, nextCursor }`; pass the returned
 * `nextCursor` back as `cursor` to read the following page of that section.
 */
export async function listKnowledgeConversions(client, organizationId, options = {}) {
  if (!organizationId) throw new Error("Load knowledge conversions requires an organization id");
  const section = options.section || "needs_review";
  if (!KNOWLEDGE_CONVERSION_SECTIONS.includes(section)) {
    throw new Error(`Load knowledge conversions received an unknown section: ${section}`);
  }
  const pageSize = conversionPageSize(options.pageSize);
  const query = { ...options, organizationId, section, pageSize };
  if (conversionReviewColumnsAvailable !== false) {
    const { data, error } = await queryKnowledgeConversions(client, true, query);
    if (!error) {
      conversionReviewColumnsAvailable = true;
      return { section, ...conversionPage(data, true, pageSize) };
    }
    if (!isMissingConversionReviewColumnError(error)) {
      throw operationError("Load knowledge conversions", error);
    }
    conversionReviewColumnsAvailable = false;
  }
  const { data, error } = await queryKnowledgeConversions(client, false, query);
  if (error) throw operationError("Load knowledge conversions", error);
  return { section, ...conversionPage(data, false, pageSize) };
}

export function reviewKnowledgeConversion(client, organizationId, conversionId) {
  return rpc(client, "review_knowledge_conversion", {
    p_organization_id: organizationId,
    p_conversion_id: conversionId,
  }, "Review knowledge conversion");
}

export function rejectKnowledgeConversion(client, organizationId, conversionId, reason) {
  return rpc(client, "reject_knowledge_conversion", {
    p_organization_id: organizationId,
    p_conversion_id: conversionId,
    p_reason: reason,
  }, "Reject knowledge conversion");
}

export function clearKnowledgeSource(client, sourceId) {
  return rpc(client, "clear_knowledge_ingest_source_chunks", {
    p_source_id: sourceId,
    p_idempotency_key: crypto.randomUUID(),
  }, "Clear source chunks");
}

async function sha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadStewardLibraryFile(client, file, fields, { onPhase } = {}) {
  // HEIC is converted before anything is measured: the digest, the byte size
  // and the declared MIME must all describe the bytes that actually land in
  // the bucket, or the inspector's comparison fails on the steward's behalf.
  const source = await normalizeUploadFile(file);
  const prepared = await rpc(client, "prepare_steward_library_upload", {
    p_file_name: source.name,
    p_byte_size: source.size,
    p_content_sha256: await sha256(source),
    p_title: fields.title || source.name,
    p_summary: fields.summary || "",
    p_category: fields.category || "general",
    p_idempotency_key: crypto.randomUUID(),
    p_chapter_id: fields.category === "contract" ? fields.chapterId || null : null,
  }, "Prepare steward upload");
  const target = await rpc(client, "get_knowledge_file_storage_target", {
    p_file_id: prepared.fileId,
    p_storage_handle: prepared.storageHandle,
    p_mode: "upload",
  }, "Authorize steward upload");
  try {
    const { error } = await client.storage.from(target.bucketId).upload(target.objectName, source, {
      // The server's declared type, not `file.type`. A browser-guessed content
      // type that disagrees with the prepared row is a self-inflicted refusal:
      // the inspector compares the stored object's metadata to the row.
      contentType: target.mimeType,
      upsert: false,
    });
    if (error) throw operationError("Upload steward file", error);
    // Between the bytes and the metadata completion that makes them
    // indexable, publishable and downloadable. Any failure here falls into the
    // rollback below, so nothing unscanned survives in the bucket.
    try { onPhase?.("checking"); } catch { /* the caller's UI, not our transaction */ }
    await requestPrivateFileInspection(client, "knowledge", prepared.fileId);
    const completed = await rpc(client, "complete_steward_library_upload", {
      p_upload_id: prepared.fileId,
      p_idempotency_key: crypto.randomUUID(),
    }, "Complete steward upload");
    if (!completed?.sourceId) throw new Error("Completed steward upload did not return its source");
    try {
      await retryKnowledgeSource(client, completed.sourceId);
      return completed;
    } catch (error) {
      // The protected object and its failed-source health are now durable.
      // Keep both so an authorized operator can inspect and retry; cleanup is
      // reserved for failures before metadata completion.
      return { ...completed, ingestionError: error?.message || "knowledge-ingest-failed" };
    }
  } catch (error) {
    await client.storage.from(target.bucketId).remove([target.objectName]).catch(() => {});
    await rpc(client, "cancel_steward_library_upload", {
      p_file_id: prepared.fileId,
      p_storage_handle: prepared.storageHandle,
    }, "Cancel steward upload").catch(() => {});
    throw error;
  }
}

export function reviewStewardLibraryFile(client, fileId, decision) {
  return rpc(client, "review_steward_library_file", {
    p_file_id: fileId,
    p_decision: decision,
  }, "Review steward file");
}

export function publishStewardLibraryFile(client, fileId, category) {
  return rpc(client, "publish_steward_file_to_catalog", {
    p_file_id: fileId,
    p_category: category || null,
    p_idempotency_key: crypto.randomUUID(),
  }, "Publish resource");
}

function storageHandle(download) {
  const parts = String(download?.href || "").split(":");
  return parts[0] === "knowledge" && parts.length >= 3 ? parts[1] : "";
}

/**
 * Read a protected knowledge file's bytes with the reader's own JWT.
 *
 * The signed URL this replaces was a decision made once and honoured for five
 * minutes afterwards, which a later quarantine could not revoke; an
 * authenticated read re-evaluates the restrictive policy every time. The
 * `download:` disposition went with it, so the caller supplies the file name
 * to an `<a download>` instead.
 */
export async function knowledgeFileBlob(client, fileId, mode) {
  const catalog = mode === "catalog";
  const download = await rpc(
    client,
    catalog ? "download_resource_catalog_item" : "download_steward_library_file",
    { p_file_id: fileId },
    "Authorize knowledge download",
  );
  const handle = storageHandle(download);
  if (!handle) throw new Error("Knowledge download did not return an opaque handle");
  const target = await rpc(client, "get_knowledge_file_storage_target", {
    p_file_id: fileId,
    p_storage_handle: handle,
    p_mode: catalog ? "catalog_download" : "steward_download",
  }, "Resolve knowledge download");
  const blob = await downloadPrivateFileBlob(client, {
    bucketId: target.bucketId,
    objectName: target.objectName,
  });
  return { blob, fileName: target.fileName || "knowledge-file" };
}

/** Ask for a fresh inspection of a knowledge file whose verdict aged out. */
export async function recheckKnowledgeFile(client, fileId) {
  await requestPrivateFileInspection(client, "knowledge", fileId);
  return { fileId, status: "clean" };
}

async function sessionToken(client) {
  const { data, error } = await client.auth.getSession();
  if (error || !data?.session?.access_token) throw operationError("Authorize Google Drive", error || { message: "Session unavailable" });
  return data.session.access_token;
}

async function driveRequest(client, action, body = {}) {
  const response = await fetch(`/api/google-drive?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await sessionToken(client)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(operationError("Google Drive", { message: result.error || `HTTP ${response.status}` }), { siteAddress: result.siteAddress });
  }
  return result;
}

// A connect finishes only in the browser and on the host that started it
// (#9557). Started from another host (a deployment or preview address), the
// route names the site address; open the same page there to connect.
export async function beginGoogleDriveConnection(client) {
  let result;
  try {
    result = await driveRequest(client, "start");
  } catch (error) {
    const site = String(error?.siteAddress || "");
    if (error?.message === "use-site-address" && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site) && site !== window.location.origin) {
      // The library tab of Organize holds the Drive Connect button.
      window.location.assign(`${site}/m/organize/library`);
      return;
    }
    throw error;
  }
  if (!/^https:\/\/accounts\.google\.com\//.test(result.authorizationUrl || "")) {
    throw new Error("Google Drive authorization URL is invalid");
  }
  window.location.assign(result.authorizationUrl);
}

// REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: an optional filing target
// { kind: "case" | "meeting", id } narrows every Drive call to that case's or
// meeting's folder; null keeps the shared resources folder.
function driveTargetBody(target) {
  return target && ["case", "meeting"].includes(target.kind) && target.id
    ? { target: { kind: target.kind, id: String(target.id) } }
    : {};
}

export async function listGoogleDriveFilingTargets(client) {
  const data = await rpc(client, "list_google_drive_filing_targets", {}, "Load Google Drive folders");
  return {
    enabled: data?.enabled === true,
    cases: array(data?.cases).filter((item) => item?.id && item?.folderName),
    meetings: array(data?.meetings).filter((item) => item?.id && item?.folderName),
  };
}

export async function listConnectedDriveFiles(client, target = null) {
  return array((await driveRequest(client, "list", driveTargetBody(target))).files);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export async function uploadConnectedDriveFile(client, file, target = null) {
  if (file.size > 3 * 1024 * 1024) throw new Error("Google Drive uploads are limited to 3 MB from this screen");
  return driveRequest(client, "upload", {
    ...driveTargetBody(target),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  });
}

export async function downloadConnectedDriveFile(client, file, target = null) {
  if (Number(file?.size || 0) > 3 * 1024 * 1024) {
    throw new Error("Google Drive downloads are limited to 3 MB from this screen");
  }
  const result = await driveRequest(client, "download", { ...driveTargetBody(target), fileId: file.id });
  const bytes = Uint8Array.from(atob(result.contentBase64 || ""), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name || "drive-file";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function disconnectGoogleDrive(client) {
  return rpc(client, "disconnect_google_drive", {}, "Disconnect Google Drive");
}
