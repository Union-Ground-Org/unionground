// Thin RPC wrappers for the setup review and the placement card
// (REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925), in the
// src/lib/chapterLifecycleApi.js shape: `(client, …)`, one call each, and
// every error wrapped in MemberApiError so `code` survives for the page.
//
// The structure write is the unchanged import_organization_structure (dry run,
// then commit). The three placement RPCs belong to the Phase 4a DB half; until
// a hosted migration window applies it, the read answers PGRST202/42883 and
// the card shows "unavailable" without ever calling a write.
import { MemberApiError } from "../../lib/memberApi.js";
import { loadCatalogProfile, probeCatalogStatus } from "../unionCatalog/catalogSearch.js";
import { normalizeSetupProfile } from "./setupPayload.js";
import { starterCatalogContext } from "./starterRecommendations.js";

// The setup review pins the release it read a profile from (brief A4), so a
// live catalog without a release label reads as unavailable here.
export async function probeSetupCatalog(client) {
  const { catalog, status } = await probeCatalogStatus(client);
  if (catalog !== "live" || typeof status?.releaseLabel !== "string") return { catalog: "unavailable", status: null };
  return { catalog: "live", status: { releaseLabel: status.releaseLabel, dataAsOf: status.dataAsOf } };
}

export function loadSetupProfile(client, key) {
  return loadCatalogProfile(client, key, (raw) => ({ ...normalizeSetupProfile(raw), starter: starterCatalogContext(raw) }));
}

export async function importOrganizationStructure(client, selectedHat, payload, dryRun) {
  const { data, error } = await client.rpc("import_organization_structure", {
    p_selected_hat: selectedHat,
    p_payload: payload,
    p_dry_run: dryRun,
  });
  if (error) throw new MemberApiError("Organization structure import", error);
  return data;
}

function normalizePlacement(data) {
  const placement = data?.placement;
  if (!placement || typeof placement !== "object") return null;
  return {
    parentCatalogKey: typeof placement.parentCatalogKey === "string" ? placement.parentCatalogKey : null,
    parentName: typeof placement.parentName === "string" ? placement.parentName : null,
    parentActive: placement.parentActive !== false,
    unlistedParentName: typeof placement.unlistedParentName === "string" ? placement.unlistedParentName : null,
    unlistedParentState: typeof placement.unlistedParentState === "string" ? placement.unlistedParentState : null,
    identityUnlisted: placement.identityUnlisted === true,
    // Lead ruling: verified means the placement's verified_at is set, which
    // only Phase 3a can write. No 4a response carries it, so every 4a
    // placement reads as self-reported whatever its status text says.
    verificationStatus: typeof placement.verifiedAt === "string" && placement.verifiedAt ? "verified" : "self_reported",
  };
}

export async function getOrganizationCatalogPlacement(client, organizationId) {
  const { data, error } = await client.rpc("get_organization_catalog_placement", {
    p_selected_hat: "admin",
    p_expected_organization_id: organizationId,
  });
  if (error) throw new MemberApiError("Organization placement", error);
  return normalizePlacement(data);
}

export async function setOrganizationCatalogPlacement(client, organizationId, fields, idempotencyKey) {
  const { data, error } = await client.rpc("set_organization_catalog_placement", {
    p_selected_hat: "admin",
    p_expected_organization_id: organizationId,
    p_parent_catalog_key: fields.parentCatalogKey ?? null,
    p_unlisted_parent_name: fields.unlistedParentName ?? null,
    p_unlisted_parent_state: fields.unlistedParentState ?? null,
    p_identity_unlisted: fields.identityUnlisted === true,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new MemberApiError("Save placement", error);
  return normalizePlacement(data);
}

export async function clearOrganizationCatalogPlacement(client, organizationId, idempotencyKey) {
  const { data, error } = await client.rpc("clear_organization_catalog_placement", {
    p_selected_hat: "admin",
    p_expected_organization_id: organizationId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new MemberApiError("Remove placement", error);
  return normalizePlacement(data);
}
