// Explicit fictional UI preview only. Never used as a live-data fallback.
export function createConnectionPreview(now = new Date()) {
  const publishedAt = now.toISOString();
  const profile = (id, displayName, location, sectorKeys, issues, expertiseOffered, localKey, unionFamilyKey) => ({
    id, kind: "chapter", displayName, discoverable: true, location, sectorKeys,
    issuePriorities: issues.map((key) => ({ key, strength: 1 })),
    declaredIssueKeys: issues,
    assistanceNeeds: issues.map((key) => ({ key, strength: 1 })),
    expertiseOffered, localKey, unionFamilyKey, publishedAt,
    handshake: { eligible: true, partnerOrgId: `preview-union-${id}` },
  });
  const place = (state, metro) => ({ country: "US", state, metro });
  const source = profile("preview-river", "River Campaign", place("MA", "Boston"), ["care", "public-services"], ["staffing", "workload", "scheduling"], ["contract-enforcement"], "example-local-a", "example-union-a");
  return {
    workspace: { organizationId: "preview-connections", chapterId: source.id, profile: source, canPublish: true, canRequestHandshake: true, chapters: [{ id: source.id, name: source.displayName }] },
    profiles: [
      profile("preview-harbor", "Harbor Care Campaign", place("MA", "Boston"), ["care", "healthcare"], ["staffing", "workload"], ["staffing", "scheduling"], "example-local-b", "example-union-a"),
      profile("preview-valley", "Valley Public Services", place("MA", "Springfield"), ["public-services"], ["staffing", "scheduling"], ["workload"], "example-local-a", "example-union-a"),
      profile("preview-lakes", "Great Lakes Care Campaign", place("MI", "Detroit"), ["care", "public-services"], ["staffing", "workload", "scheduling"], ["staffing", "workload", "scheduling"], "example-local-c", "example-union-b"),
      profile("preview-school", "Central Schools Campaign", place("MA", "Boston"), ["education"], ["pay", "benefits"], ["pay", "benefits"], "example-local-d", "example-union-c"),
      profile("preview-transit", "Coastal Transit Campaign", place("RI", "Providence"), ["transportation"], ["scheduling", "safety"], ["scheduling"], "example-local-e", "example-union-d"),
      profile("preview-west", "Western Community Campaign", place("CA", "Oakland"), ["nonprofit", "care"], ["workload", "staffing"], ["workload", "training"], "example-local-f", "example-union-e"),
    ],
  };
}
