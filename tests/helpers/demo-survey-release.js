import baseline from "../../content/legal/release-stamp.json";

// A prospective deployment proof; production must obtain this from legal-pack.
export function demoSurveyReleaseFiles() {
  const migrationId = "20991110130000";
  const instruments = ["privacy-policy", "terms-of-use", "accessibility-statement", "ai-disclosure", "retention-schedule"];
  const stamp = {
    ...baseline,
    release: {
      generatorVersion: baseline.generatorVersion,
      baseCommit: "a".repeat(40),
      migrationId,
      date: "2099-11-10",
      privacyEffective: "2099-11-10",
      migrationSha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
      consumed: [{ name: "survey.json", sha256: "c".repeat(64) }],
      versions: Object.fromEntries(instruments.map((id) => [id, "1.0.0"])),
      material: Object.fromEntries(instruments.map((id) => [id, false])),
      gatedPaths: [{ id: "demo-survey-offer", kind: "retention", releaseId: migrationId }],
    },
  };
  const stampText = JSON.stringify(stamp);
  return {
    pendingDirectoryPresent: true,
    pendingTexts: [],
    stampText,
    deployment: { stampJson: stampText, liveReleaseIds: [migrationId], verifiedPackReleaseIds: [migrationId] },
  };
}
