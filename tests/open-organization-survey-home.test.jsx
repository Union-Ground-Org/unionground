// BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111: a
// member with one open organization survey (Engagement studio) saw "0 open
// surveys" on Home and "No open votes or surveys right now" in Campaigns &
// priorities while Voice listed the survey, because both read member_surveys
// only. Home, Voting and the VP priorities now count the surveys
// get_member_engagement_snapshot returns, and the Home card opens Voice.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { openOrganizationSurveys, organizationSurveysFromSnapshot, voiceAvailabilityLabel } from "../src/lib/voiceAvailability.js";
import { vpPriorities } from "../src/views/VpView.jsx";

// Relative to the clock the mounted card reads, so the open survey stays open
// whenever the suite runs (gate r1s3 on #8260: a fixed Nov 13 close expired).
const NOW = new Date();
const CLOSES = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();

// The engagement snapshot as the RPC returns it for a member with one open survey.
const snapshot = {
  quarterlyGate: { required: false, completed: false, unlocked: true },
  surveys: [{ id: "org-survey-1", title: "Fall staffing check-in", closesAt: CLOSES, opensAt: null, session: null, questions: [] }],
};
const t = (key, values) => `${key}:${values?.count ?? ""}`;

describe("organizationSurveysFromSnapshot", () => {
  it("reads every survey the snapshot returns as open, with the viewer's answered state", () => {
    expect(organizationSurveysFromSnapshot(snapshot)).toEqual([
      { id: "org-survey-1", title: "Fall staffing check-in", closesAt: CLOSES, answered: false },
    ]);
    expect(organizationSurveysFromSnapshot({ surveys: [{ id: "s2", title: "Done", closesAt: "", session: { status: "submitted" } }] }))
      .toEqual([{ id: "s2", title: "Done", closesAt: null, answered: true }]);
  });

  it("is empty for an unreadable snapshot or malformed rows", () => {
    expect(organizationSurveysFromSnapshot(null)).toEqual([]);
    expect(organizationSurveysFromSnapshot({ surveys: "bad" })).toEqual([]);
    expect(organizationSurveysFromSnapshot({ surveys: [null, { id: 3, title: "x" }, { id: "s", title: "" }] })).toEqual([]);
  });
});

describe("voiceAvailabilityLabel", () => {
  it("names open organization surveys apart from the plan's surveys (#9533 B-4)", () => {
    const organizationSurveys = organizationSurveysFromSnapshot(snapshot);
    expect(voiceAvailabilityLabel([], t, organizationSurveys)).toBe("voting.openVotesMany:0 · voting.openSurveysMany:0 · voting.voiceSurveysOne:1");
    expect(voiceAvailabilityLabel([{ kind: "pulse", closed: false }], t, organizationSurveys)).toBe("voting.openVotesMany:0 · voting.openSurveysOne:1 · voting.voiceSurveysOne:1");
    expect(voiceAvailabilityLabel([], t)).toBe("voting.openVotesMany:0 · voting.openSurveysMany:0");
  });

  it("leaves closed items out and reads an unreadable survey list as none", () => {
    const planItems = [
      { kind: "ballot", closed: false },
      { kind: "ballot", closed: true },
      { kind: "pulse", closed: true },
    ];
    expect(voiceAvailabilityLabel(planItems, t, null)).toBe("voting.openVotesOne:1 · voting.openSurveysMany:0");
  });
});

describe("the closing window is applied when counting (gate r1s2 on #8260)", () => {
  const closesAt = "2026-11-11T20:00:00.000Z";
  const cached = [{ id: "s", title: "Closing", closesAt, answered: false }, { id: "n", title: "No close", closesAt: null, answered: false }];
  it("stops counting a cached survey once its closing time passes", () => {
    const before = Date.parse(closesAt) - 60_000;
    const after = Date.parse(closesAt) + 60_000;
    expect(openOrganizationSurveys(cached, before).map((item) => item.id)).toEqual(["s", "n"]);
    expect(openOrganizationSurveys(cached, new Date(after)).map((item) => item.id)).toEqual(["n"]);
    expect(openOrganizationSurveys(cached, Date.parse(closesAt)).map((item) => item.id)).toEqual(["n"]);
    expect(openOrganizationSurveys("bad", after)).toEqual([]);
    expect(voiceAvailabilityLabel([], t, cached, before)).toBe("voting.openVotesMany:0 · voting.openSurveysMany:0 · voting.voiceSurveysMany:2");
    expect(voiceAvailabilityLabel([], t, cached, after)).toBe("voting.openVotesMany:0 · voting.openSurveysMany:0 · voting.voiceSurveysOne:1");
    expect(vpPriorities([], cached, after)).toEqual([{ id: "n", title: "No close", kind: "survey" }]);
  });
});

describe("a survey answered in Voice leaves Home's cached copy (gate r1s1 on #8260)", () => {
  it("drops the shared engagement snapshot after a Voice write", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const voice = readFileSync("src/views/VoiceView.jsx", "utf8");
    const campaigns = readFileSync("src/views/CampaignsView.jsx", "utf8");
    expect(app).toContain('memberLoaderRef.current?.invalidateResources(["rpc:get_member_engagement_snapshot"]);');
    expect(app.match(/onEngagementChanged=\{invalidateEngagementSnapshot\}/g)).toHaveLength(2);
    expect(voice).toContain("onSnapshotChanged={onEngagementChanged}");
    expect(campaigns).toContain("onSnapshotChanged={onEngagementChanged}");
  });
});

// Home ranking of engagement-snapshot surveys is cut: this edition's member loader
// never fills organizationSurveys, and its Home card finds open surveys among the plan items.

describe("vpPriorities", () => {
  it("adds the viewer's open organization surveys once each", () => {
    const listed = [{ id: "b1", kind: "ballot", title: "Contract vote" }];
    const surveys = [{ id: "org-survey-1", title: "Fall staffing check-in" }, { id: "b1", title: "duplicate" }];
    expect(vpPriorities(listed, surveys)).toEqual([...listed, { id: "org-survey-1", title: "Fall staffing check-in", kind: "survey" }]);
    expect(vpPriorities(undefined, surveys.slice(0, 1))).toEqual([{ id: "org-survey-1", title: "Fall staffing check-in", kind: "survey" }]);
    expect(vpPriorities(listed, undefined)).toEqual(listed);
  });
});
