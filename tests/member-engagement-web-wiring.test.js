import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const app = read("src/App.jsx");
const member = read("src/features/engagement/MemberEngagement.jsx");
const staff = read("src/features/engagement/StaffEngagement.jsx");
const api = read("src/features/engagement/api.js");
const voice = read("src/views/VoiceView.jsx");
const campaigns = read("src/views/CampaignsView.jsx");
const messages = read("src/views/MessagesView.jsx");
const vercel = JSON.parse(read("vercel.json"));

describe("member engagement web wiring", () => {
  it("mounts database-backed member and staff workspaces outside the fixture harness", () => {
    expect(voice).toContain("<MemberEngagement client={engagementClient}");
    expect(campaigns).toContain("<StaffEngagement client={engagementClient}");
    expect(app).toContain("engagementClient={fixtureDemo ? null : sessionDataClient}");
    expect(voice).toContain("previewFixture && <DemoVoiceMember");
    expect(campaigns).toContain('sampleStudio && <WorkspaceSection name="campaigns-studio"><DemoVoiceStudio');
  });

  it("provides sectioned survey save/submit, quarterly gate, contextual prompts, and live results", () => {
    // The member chrome moved into the catalogue
    // (UX-UG-MEMBER-ENGAGEMENT-CHROME-ENGLISH-ONLY-20260920), so the two
    // English literals this used to read out of the source are pinned the way
    // the staff markers below are: the key in the source, the pair in the
    // catalogue.
    for (const [key, en, es] of [
      ["engagement.member.saveAndContinue", "Save and continue", "Guardar y continuar"],
      ["engagement.member.checkInToVote", "Check in to vote", "Regístrate para votar"],
    ]) {
      expect(member).toContain(`t("${key}")`);
      expect(catalogue.en[key]).toBe(en);
      expect(catalogue.es[key]).toBe(es);
    }
    expect(member).toContain("submitSurveySession");
    expect(member).toContain("quarterlyGate");
    expect(member).toContain("respondPulse");
    expect(member).toContain("subscribeToLivePolls");
  });

  it("provides staff authoring, distribution, review, reports, projector, roster, and channel controls", () => {
    for (const marker of [
      "prepareDistribution", "queueReminders", "updateSurveyReview",
      "loadSurveyReport", "setLivePollRoster",
      "setChannelControls",
    ]) expect(staff).toContain(marker);
    for (const [key, en, es] of [
      ["engagement.newSurvey", "New survey", "Nueva encuesta"],
      ["engagement.exportJson", "Export JSON", "Exportar JSON"],
      ["engagement.projector", "Projector view", "Vista para proyector"],
    ]) {
      expect(staff).toContain(`t("${key}")`);
      expect(catalogue.en[key]).toBe(en);
      expect(catalogue.es[key]).toBe(es);
    }
  });

  it("routes poll drafting and message briefings through the governed Compass endpoint", () => {
    expect(api).toContain('mode: "poll_draft"');
    expect(api).toContain('mode: "message_briefing"');
    expect(messages).toContain('t("inbox.compassBriefIdle")');
    expect(catalogue.en["inbox.compassBriefIdle"]).toBe("Brief this thread");
    expect(catalogue.es["inbox.compassBriefIdle"]).toBe("Crear briefing de este hilo");
    expect(messages).toContain("requestMessageBriefing");
  });

  it("schedules the optional provider worker on its real API route", () => {
    expect(vercel.crons).toContainEqual({ path: "/api/engagement-delivery", schedule: "*/15 * * * *" });
    expect(vercel.functions["api/engagement-delivery.js"]).toEqual({ maxDuration: 300 });
  });

  it("reads live poll result vote counts from the server votes key", () => {
    const completion = read("supabase/migrations/20260828034122_member_engagement_completion.sql");
    expect(completion).toContain("'optionId', option.id, 'label', option.label, 'votes', coalesce(counts.votes, 0)");
    expect(member).toContain("{result.votes}");
    expect(staff).toContain("{result.votes}");
    expect(member).not.toContain("result.count");
    expect(staff).not.toContain("result.count");
  });
});
