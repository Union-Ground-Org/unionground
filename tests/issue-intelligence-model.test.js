import { describe, expect, it } from "vitest";
import {
  ISSUE_DESTINATIONS, ISSUE_FAMILIES, actionRecommendations, guidanceRecommendations, headlineCopy, issueDraftHref,
  joinEvidenceList, normalizeIssueSignals, pollDrafts, readIssueDraft, reasonCopy, signalsForMemberSurface, summaryCopy,
} from "../src/features/issueIntelligence/model.js";
import { issueIntelligenceCatalogue } from "../src/lib/i18n/issueIntelligence.js";
import { catalogue } from "../src/lib/i18n.js";

const staffPayload = {
  enabled: true,
  viewer: "staff",
  windowDays: 30,
  signals: [
    { family: ISSUE_FAMILIES.contractRights, threadKey: "contract-rights-confusion", confidence: "strong", trend: "rising", evidenceFamilies: ["qa", "messages", "cases", "polls"] },
    { family: ISSUE_FAMILIES.retaliation, threadKey: "retaliation-protected-activity-pressure", confidence: "emerging", trend: "stable", evidenceFamilies: ["retaliation_reports", "messages"] },
  ],
};

describe("issue intelligence projection", () => {
  it("orders retaliation first and keeps staff detail for staff", () => {
    const result = normalizeIssueSignals(staffPayload);
    expect(result.enabled).toBe(true);
    expect(result.viewer).toBe("staff");
    expect(result.signals.map((signal) => signal.family)).toEqual([ISSUE_FAMILIES.retaliation, ISSUE_FAMILIES.contractRights]);
    expect(result.signals[1]).toMatchObject({ confidence: "strong", trend: "rising", evidenceFamilies: ["qa", "messages", "cases", "polls"] });
  });

  it("drops staff fields, unknown families, duplicates and unknown evidence for members", () => {
    const result = normalizeIssueSignals({
      enabled: true,
      viewer: "member",
      signals: [
        { family: ISSUE_FAMILIES.contractRights, confidence: "strong", evidenceFamilies: ["qa"], contributors: 40 },
        { family: ISSUE_FAMILIES.contractRights },
        { family: "made_up_family" },
        null,
      ],
    });
    expect(result.signals).toEqual([{ family: ISSUE_FAMILIES.contractRights, threadKey: "contract-rights-confusion", key: "contractRights" }]);
    const staff = normalizeIssueSignals({ enabled: true, viewer: "staff", signals: [{ family: ISSUE_FAMILIES.retaliation, confidence: "huge", trend: "up", evidenceFamilies: ["kyr", "secret_text", "kyr"] }] });
    expect(staff.signals[0]).toMatchObject({ confidence: "emerging", trend: "stable", evidenceFamilies: ["kyr"] });
  });

  it("treats a disabled or malformed payload as no signals", () => {
    expect(normalizeIssueSignals({ enabled: false, viewer: "staff", signals: staffPayload.signals })).toEqual({ enabled: false, viewer: "staff", signals: [] });
    expect(normalizeIssueSignals(null).signals).toEqual([]);
    expect(normalizeIssueSignals([]).signals).toEqual([]);
  });

  it("shows worker banners on Home and the rights page only", () => {
    const { signals } = normalizeIssueSignals({ ...staffPayload, viewer: "member" });
    expect(signalsForMemberSurface(signals, "today")).toHaveLength(2);
    expect(signalsForMemberSurface(signals, "rights")).toHaveLength(2);
    expect(signalsForMemberSurface(signals, "settings")).toHaveLength(0);
  });
});

describe("issue intelligence recommendations (old output.ts and privacy.ts)", () => {
  const { signals } = normalizeIssueSignals(staffPayload);
  const [retaliation, contract] = signals;

  it("never gives members staff coordination actions", () => {
    expect(actionRecommendations(contract, "member")).toEqual([]);
    expect(actionRecommendations(retaliation, "member")).toEqual([]);
  });

  it("restores the staff action set, including poll and case escalation on a strong signal", () => {
    expect(actionRecommendations(contract, "staff").map((item) => item.kind)).toEqual(["steward_followup", "outreach_group", "poll_suggestion", "escalation_review"]);
    expect(actionRecommendations({ ...contract, confidence: "active", evidenceFamilies: ["qa", "messages"] }, "staff").map((item) => item.kind)).toEqual(["steward_followup", "outreach_group"]);
    expect(actionRecommendations(retaliation, "staff").map((item) => item.kind)).toEqual(["retaliation_review", "task_followup", "steward_followup"]);
  });

  it("gates contract guidance by confidence for staff and gives members the full list", () => {
    expect(guidanceRecommendations({ ...contract, confidence: "emerging" }, "staff").map((item) => item.kind)).toEqual(["rights_explainer"]);
    expect(guidanceRecommendations({ ...contract, confidence: "active" }, "staff").map((item) => item.kind)).toEqual(["rights_explainer", "faq"]);
    expect(guidanceRecommendations(contract, "member").map((item) => item.kind)).toEqual(["rights_explainer", "faq", "checklist"]);
    expect(guidanceRecommendations(retaliation, "member").map((item) => item.kind)).toEqual(["rights_explainer", "report_path", "checklist", "form"]);
  });

  // Union Ground has no contract clauses or articles (owner decision,
  // 2026-10-13): no guidance points at an article and no destination opens a
  // clauses page, for any signal, viewer or confidence.
  it("never recommends a contract article or a clauses destination", () => {
    expect(ISSUE_DESTINATIONS).not.toHaveProperty("clauses");
    expect(Object.values(ISSUE_DESTINATIONS).some((destination) => destination.view === "clauses" || destination.path === "/m/clauses")).toBe(false);
    for (const signal of signals) {
      for (const viewer of ["member", "staff"]) {
        for (const confidence of ["emerging", "active", "strong"]) {
          const items = [...guidanceRecommendations({ ...signal, confidence }, viewer), ...actionRecommendations({ ...signal, confidence }, viewer)];
          expect(items.map((item) => item.kind)).not.toContain("contract_article");
          expect(items.map((item) => item.destination)).not.toContain("clauses");
        }
      }
    }
  });

  it("offers poll drafts only to staff on a strong contract-rights signal", () => {
    expect(pollDrafts(contract, "staff")).toHaveLength(3);
    expect(pollDrafts(contract, "member")).toEqual([]);
    expect(pollDrafts({ ...contract, confidence: "active" }, "staff")).toEqual([]);
    expect(pollDrafts(retaliation, "staff")).toEqual([]);
  });

  it("maps every recommendation to a known in-app destination", () => {
    for (const signal of signals) {
      for (const item of [...guidanceRecommendations(signal, "staff"), ...actionRecommendations(signal, "staff")]) {
        expect(ISSUE_DESTINATIONS[item.destination], item.destination).toBeDefined();
      }
    }
  });

  it("builds member and staff copy keys that exist in both languages", () => {
    const keys = [];
    for (const signal of signals) {
      for (const viewer of ["member", "staff"]) {
        keys.push(headlineCopy(signal, viewer).key, reasonCopy(signal, viewer).key);
        const summary = summaryCopy(signal, viewer);
        keys.push(summary.whatItIs, summary.whyItMatters);
        if (summary.whatChanged) keys.push(summary.whatChanged.key);
        const family = signal.key;
        for (const item of guidanceRecommendations(signal, viewer)) keys.push(`issueIntelligence.guide.${family}.${item.kind}.title`, `issueIntelligence.guide.${family}.${item.kind}.description`);
        for (const item of actionRecommendations(signal, viewer)) keys.push(`issueIntelligence.action.${family}.${item.kind}.title`, `issueIntelligence.action.${family}.${item.kind}.description`);
        for (const draft of pollDrafts(signal, viewer)) keys.push(draft.labelKey, draft.questionKey);
      }
      for (const evidence of signal.evidenceFamilies) keys.push(`issueIntelligence.evidence.${evidence}`);
    }
    for (const key of keys) {
      expect(issueIntelligenceCatalogue.en[key], `${key} en`).toBeTruthy();
      expect(issueIntelligenceCatalogue.es[key], `${key} es`).toBeTruthy();
    }
    expect(Object.keys(issueIntelligenceCatalogue.es).sort()).toEqual(Object.keys(issueIntelligenceCatalogue.en).sort());
  });

  it("registers the switch labels for the Feature switches & limits page in both languages", () => {
    for (const key of [
      "features.intelligence.issue_signals", "features.intelligence.issue_signals_contract_rights_family",
      "features.intelligence.issue_signals_retaliation_family", "limits.intelligence.issue_signal_min_segment",
    ]) {
      for (const suffix of ["label", "description"]) {
        expect(catalogue.en[`settings.def.${key}.${suffix}`]).toBeTruthy();
        expect(catalogue.es[`settings.def.${key}.${suffix}`]).toBeTruthy();
      }
    }
  });

  it("joins evidence labels the way the old reason summary did", () => {
    expect(joinEvidenceList(["Q&A"], "and")).toBe("Q&A");
    expect(joinEvidenceList(["Q&A", "messages", "cases"], "and")).toBe("Q&A, messages and cases");
  });
});

describe("poll draft hand-off", () => {
  it("round-trips a bounded plain-text question through the campaigns link", () => {
    const href = issueDraftHref("How confident are you that you know your rights under the current contract?");
    expect(href.startsWith("/m/campaigns?issueDraft=")).toBe(true);
    expect(readIssueDraft(href.slice(href.indexOf("?")))).toBe("How confident are you that you know your rights under the current contract?");
  });

  it("strips markup characters, bounds length and ignores trivial drafts", () => {
    expect(readIssueDraft(`?issueDraft=${encodeURIComponent("<b>Which part of the contract?</b>")}`)).toBe("b Which part of the contract? /b");
    expect(readIssueDraft(`?issueDraft=${"x".repeat(400)}`)).toHaveLength(280);
    expect(readIssueDraft("?issueDraft=hi")).toBeNull();
    expect(readIssueDraft("")).toBeNull();
  });
});
