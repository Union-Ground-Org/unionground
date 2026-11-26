import { useCallback, useEffect, useMemo, useState } from "react";
import { ORGANIZATION_ROLES } from "../features/tenancy/organizationScope.js";

// Pay-only session/actor seam. Do not import other MI1 domains here.

export const PAY_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  webWiring: "ad2aef01af257be3d6fbbbe985b24f984cf8f222",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server actions",
    "legacy service-role browser clients",
    "fictional live tenants or seeded CBA rates",
    "in-memory writes presented as persisted success",
    "QA, analytics, integrations, operations, and public-directory wiring",
  ]),
});

export function isMissingRpcError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

function uniqueRoles(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((role) => ORGANIZATION_ROLES.includes(role)))]
    .sort((left, right) => ORGANIZATION_ROLES.indexOf(left) - ORGANIZATION_ROLES.indexOf(right));
}

export function payRolesForSelectedHat({ selectedHat = "member", availableRoles = [], sample = false } = {}) {
  if (selectedHat === "member" || !ORGANIZATION_ROLES.includes(selectedHat)) return [];
  if (!sample && !uniqueRoles(availableRoles).includes(selectedHat)) return [];
  return [selectedHat];
}

export function buildPayActor({
  userId = null,
  organizationId = null,
  chapterId = null,
  roles = [],
  organizationRoles = roles,
  chapterRoles = [],
  membershipStatus = organizationId ? "active" : null,
  organizationStatus = organizationId ? "active" : null,
  mfaSatisfied = false,
  selectedHat = "member",
} = {}) {
  const orgRoles = uniqueRoles(organizationRoles);
  const chapterGrantRoles = uniqueRoles(chapterRoles);
  return Object.freeze({
    userId: userId || null,
    organizationId: organizationId || null,
    selectedOrganizationId: organizationId || null,
    chapterId: chapterId || null,
    roles: Object.freeze(uniqueRoles(roles)),
    organizationRoles: Object.freeze(orgRoles),
    chapterRoles: Object.freeze(chapterGrantRoles),
    membershipStatus: membershipStatus || (organizationId ? "active" : "inactive"),
    organizationStatus: organizationStatus || (organizationId ? "active" : null),
    mfaSatisfied: Boolean(mfaSatisfied),
    selectedHat: selectedHat || "member",
    authenticated: Boolean(userId),
    role: selectedHat === "member" ? (orgRoles[0] || null) : selectedHat,
  });
}

export async function loadOrganizationSessionScope(client) {
  if (!client?.rpc) {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
  try {
    const { data, error } = await client.rpc("get_my_chapter_memberships");
    if (error) {
      return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
    }
    const memberships = Array.isArray(data) ? data : [];
    const selected = memberships.find((row) => row?.selected) || memberships[0] || null;
    return {
      organizationId: selected?.organizationId || null,
      chapterId: selected?.chapterId || null,
      organizationRoles: uniqueRoles(selected?.organizationRoles),
      chapterRoles: uniqueRoles(selected?.chapterRoles),
      unavailable: false,
    };
  } catch {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
}

export function mergePaySessionScope(actor, scope = {}) {
  const explicitOrganizationId = actor?.organizationId || actor?.selectedOrganizationId || null;
  const trustedScopeAvailable = scope.organizationId !== undefined && !scope.loading && !scope.unavailable;
  const merged = buildPayActor({
    ...actor,
    organizationId: trustedScopeAvailable ? scope.organizationId : explicitOrganizationId,
    chapterId: trustedScopeAvailable ? scope.chapterId : actor?.chapterId,
    organizationRoles: trustedScopeAvailable ? scope.organizationRoles : actor?.organizationRoles,
    chapterRoles: trustedScopeAvailable ? scope.chapterRoles : actor?.chapterRoles,
  });
  return Object.freeze({
    ...merged,
    organizationScopeState: explicitOrganizationId
      ? "ready"
      : scope.loading
        ? "loading"
        : scope.unavailable
          ? "retry"
          : "ready",
  });
}

export function usePayScopedActor(client, actor) {
  const explicitOrganizationId = actor?.organizationId || actor?.selectedOrganizationId || null;
  const rolesKey = JSON.stringify(uniqueRoles(actor?.roles));
  const organizationRolesKey = JSON.stringify(uniqueRoles(actor?.organizationRoles));
  const chapterRolesKey = JSON.stringify(uniqueRoles(actor?.chapterRoles));
  const stableActor = useMemo(() => buildPayActor({
    userId: actor?.userId,
    organizationId: explicitOrganizationId,
    chapterId: actor?.chapterId,
    roles: JSON.parse(rolesKey),
    organizationRoles: JSON.parse(organizationRolesKey),
    chapterRoles: JSON.parse(chapterRolesKey),
    membershipStatus: actor?.membershipStatus,
    organizationStatus: actor?.organizationStatus,
    mfaSatisfied: actor?.mfaSatisfied,
    selectedHat: actor?.selectedHat,
  }), [
    actor?.chapterId,
    actor?.membershipStatus,
    actor?.mfaSatisfied,
    actor?.organizationStatus,
    actor?.selectedHat,
    actor?.userId,
    chapterRolesKey,
    explicitOrganizationId,
    organizationRolesKey,
    rolesKey,
  ]);
  const needsOrganizationLookup = Boolean(
    client?.rpc && !explicitOrganizationId,
  );
  const [attempt, setAttempt] = useState(0);
  const [scoped, setScoped] = useState(() => mergePaySessionScope(stableActor, {
    loading: needsOrganizationLookup,
  }));
  useEffect(() => {
    let active = true;
    setScoped(mergePaySessionScope(stableActor, { loading: needsOrganizationLookup }));
    if (!client?.rpc) {
      return () => {
        active = false;
      };
    }
    loadOrganizationSessionScope(client).then((scope) => {
      if (!active) return;
      setScoped(mergePaySessionScope(stableActor, scope));
    });
    return () => {
      active = false;
    };
  }, [attempt, client, needsOrganizationLookup, stableActor]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return Object.freeze({ actor: scoped, retry });
}

export const PAY_DATABASE_DEPENDENCIES = Object.freeze({
  migration: "20260822020000_mi1_w1_feature_persistence.sql",
  writeScopeGuardMigration: "20260826002000_pay_scale_expected_organization_guard.sql",
  rpcs: Object.freeze([
    "list_pay_scale_grades",
    "list_pay_scale_steps",
    "upsert_pay_scale_grade",
    "upsert_pay_scale_step",
  ]),
  tables: Object.freeze(["pay_scale_grades", "pay_scale_steps"]),
  sessionScope: Object.freeze(["get_my_chapter_memberships"]),
});
