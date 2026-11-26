import { buildRegistryQuery, registrySearchPlan } from "../features/unionCatalog/registryQuery.js";
export { unionOrganizationSearchPattern } from "../features/unionCatalog/registryQuery.js";

const CHAPTER_LIFECYCLE_ENDPOINT = "/api/chapter-lifecycle-verification";

function requireResult(result, label) {
  if (result?.error) {
    const error = new Error(`${label}: ${result.error.message || "request failed"}`);
    error.code = result.error.code;
    error.status = result.status ?? result.error.status;
    throw error;
  }
  return result?.data ?? null;
}

function expectObject(result, label) {
  const data = requireResult(result, label);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label}: invalid response`);
  }
  return data;
}

// The server's selected membership is the only chapter this page acts for.
// The desktop chapter rail can show a demo browsing choice or a fallback
// chapter, so it is never an input here; the page reconciles the two in view
// (BUG-UG-WEB-ADMIN-HANDSHAKE-IGNORES-RAIL-CHAPTER-20261002) and
// changes the selection only through switch_my_chapter.
async function chapterMemberships(client) {
  const rows = requireResult(
    await client.rpc("get_my_chapter_memberships"),
    "Selected chapter",
  );
  if (!Array.isArray(rows)) throw new Error("Selected chapter: invalid response");
  const memberships = rows
    .filter((row) => typeof row?.chapterId === "string" && row.chapterId)
    .map((row) => ({ chapterId: row.chapterId, name: row.name || row.chapterId, selected: row.selected === true }));
  return { memberships, selected: memberships.find((row) => row.selected) ?? null };
}

export async function switchMyChapter(client, chapterId) {
  return expectObject(await client.rpc("switch_my_chapter", {
    p_chapter_id: String(chapterId || "").trim(),
  }), "Switch chapter");
}

export async function loadChapterLifecycleAdmin(client) {
  const { memberships, selected } = await chapterMemberships(client);
  const chapterId = selected?.chapterId ?? null;
  if (!chapterId) {
    return {
      chapterId: null,
      chapterName: null,
      memberships,
      binding: null,
      connections: [],
      handshakes: [],
      documents: [],
      events: [],
      sharedDocuments: [],
      latestHealth: null,
    };
  }

  const [binding, connections, handshakes, documents, events, sharedDocuments, health] = await Promise.all([
    client.from("chapter_union_org_bindings")
      .select("chapter_id,union_org_id,status,public_note,requested_at,verified_at,union_orgs(id,name,city,state,affiliation)")
      .eq("chapter_id", chapterId).limit(1),
    client.from("chapter_connection_readiness")
      .select("chapter_id,capability,status,provider_label,public_message,verified_at,updated_at")
      .eq("chapter_id", chapterId).order("capability"),
    client.from("chapter_handshakes")
      .select("id,title,status,data_scope,chapter_id,receiving_chapter_id,updated_at,union_orgs(name)")
      .order("updated_at", { ascending: false }).limit(100),
    client.from("chapter_documents")
      .select("id,title,document_type,status,chapter_id,updated_at")
      .eq("chapter_id", chapterId).eq("status", "published")
      .order("updated_at", { ascending: false }).limit(100),
    client.from("chapter_handshake_events")
      .select("id,handshake_id,transition,from_status,to_status,detail,created_at")
      .order("created_at", { ascending: false }).limit(100),
    client.from("chapter_handshake_documents")
      .select("handshake_id,document_id,shared_at,chapter_documents(title)")
      .order("shared_at", { ascending: false }).limit(100),
    client.from("chapter_health_snapshots")
      .select("id,chapter_id,measured_on,member_count,score,created_at")
      .eq("chapter_id", chapterId).order("measured_on", { ascending: false }).limit(1),
  ]);

  const rows = (result, label) => {
    const data = requireResult(result, label);
    if (!Array.isArray(data)) throw new Error(`${label}: invalid response`);
    return data;
  };
  const bindingRows = rows(binding, "Chapter binding");
  const healthRows = rows(health, "Chapter health");
  return {
    chapterId,
    chapterName: selected.name,
    memberships,
    binding: bindingRows[0] ?? null,
    connections: rows(connections, "Connection readiness"),
    handshakes: rows(handshakes, "Chapter handshakes"),
    documents: rows(documents, "Chapter documents"),
    events: rows(events, "Handshake events"),
    sharedDocuments: rows(sharedDocuments, "Shared handshake documents"),
    latestHealth: healthRows[0] ?? null,
  };
}

// Binding uses the same literal-safe nationwide search as the public directory.
// Keep the authenticated client here: search is reference data; requesting a
// binding still uses the existing audited, chapter-scoped RPC.
export async function searchUnionOrganizations(client, query, filters = {}) {
  const request = buildRegistryQuery(client, registrySearchPlan(query, filters));
  if (!request) return [];
  const data = requireResult(await request, "Union organization search");
  if (!Array.isArray(data)) throw new Error("Union organization search: invalid response");
  return data;
}

export async function requestChapterUnionOrgBinding(client, unionOrgId) {
  return expectObject(await client.rpc("request_chapter_union_org_binding", {
    p_union_org_id: String(unionOrgId || "").trim(),
  }), "Request chapter binding");
}

export async function shareChapterHandshakeDocument(client, handshakeId, documentId, idempotencyKey) {
  return expectObject(await client.rpc("share_chapter_handshake_document", {
    p_handshake_id: handshakeId,
    p_document_id: documentId,
    p_idempotency_key: idempotencyKey,
  }), "Share handshake document");
}

export async function requestChapterConnectionSetup(client, capability, providerLabel = "") {
  return expectObject(await client.rpc("request_chapter_connection_setup", {
    p_capability: capability,
    p_provider_label: String(providerLabel || "").trim(),
  }), "Request connection setup");
}

export async function grantMemberChapterMembership(client, userId, chapterId) {
  return expectObject(await client.rpc("grant_member_chapter_membership", {
    p_user_id: userId,
    p_chapter_id: chapterId,
  }), "Grant chapter membership");
}

export async function revokeMemberChapterMembership(client, userId, chapterId) {
  return expectObject(await client.rpc("revoke_member_chapter_membership", {
    p_user_id: userId,
    p_chapter_id: chapterId,
  }), "Revoke chapter membership");
}

// The member's exact chapter state for the membership card
// (BUG-UG-CHAPTER-MEMBERSHIP-EXACT-STATE-READ-20261103): each active
// chapter in the caller's organization, whether it is home, the chapter roles
// held there and whether it is their last. A chapter Admin gets their selected
// chapter only, so the read is complete only at organization scope.
export async function loadMemberChapterMemberships(client, userId) {
  const data = expectObject(await client.rpc("get_member_chapter_memberships_for_admin", {
    p_user_id: userId,
  }), "Member chapter memberships");
  if (!Array.isArray(data.chapters)) throw new Error("Member chapter memberships: invalid response");
  return {
    userId: data.userId ?? userId,
    complete: data.scope === "organization",
    chapters: data.chapters
      .filter((row) => typeof row?.chapterId === "string" && row.chapterId)
      .map((row) => ({
        chapterId: row.chapterId,
        home: row.home === true,
        lastChapter: row.lastChapter === true,
        roles: Array.isArray(row.roles) ? row.roles.filter((role) => typeof role === "string") : [],
      })),
  };
}

export async function setMemberChapterRole(client, userId, chapterId, role, enabled) {
  return expectObject(await client.rpc("set_member_chapter_role", {
    p_user_id: userId,
    p_chapter_id: chapterId,
    p_role: role,
    p_enabled: enabled === true,
  }), "Set chapter role");
}

async function verify(session, body) {
  if (!session?.access_token) throw new Error("session-expired");
  const response = await fetch(CHAPTER_LIFECYCLE_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "verification-unavailable");
  return payload?.result ?? { accepted: true };
}

// The endpoint decides a binding only for a platform operator
// (SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101), so
// the organization admin screen no longer offers it.
export function verifyChapterUnionOrgBinding(session, fields) {
  return verify(session, {
    action: "verify-binding",
    chapterId: fields.chapterId,
    unionOrgId: fields.unionOrgId,
    verified: fields.verified === true,
    publicNote: fields.publicNote || "",
  });
}

export function verifyChapterConnectionSetup(session, fields) {
  return verify(session, {
    action: "verify-connection",
    chapterId: fields.chapterId,
    capability: fields.capability,
    status: fields.status,
    publicMessage: fields.publicMessage || "",
  });
}
