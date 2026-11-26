// Sunday release sweep, signed-in finding 1.
//
// The admin Job health list named three background jobs that serve held
// switches ("Single sign-on identity link sweep", "Learning period end",
// "Weekly issue digest"). A held switch is one the admin settings list leaves
// out (docs/contracts/staged-feature-releases.md), and a job that serves only
// a held switch leaves the Job health list with it (JOB_ACTS_BESIDE in
// src/lib/heldSettingCompanions.js). Every product job has a row there, so a
// new job cannot be listed by omission; a released switch brings its job back.
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRODUCT_JOBS } from "../src/features/operations/jobRegistry.js";
import { JOB_ACTS_BESIDE, withoutJobsBesideHeldSwitches } from "../src/lib/heldSettingCompanions.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";
import { OperationsHealthView } from "../src/views/OperationsHealthView.jsx";
import { AdminView } from "../src/views/AdminView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { migrationFiles, stripComments } from "./helpers/migration.js";
import { RELEASE_CALENDAR_HELD_KEYS } from "./helpers/release-calendar-holds.js";

const HELD_JOBS = {
  "issue-intelligence-weekly-digest": ["features.intelligence.weekly_digest"],
  "learning-period-end-tick": ["features.guidance_onboarding.learning_period"],
};

const chain = migrationFiles().map(({ sql }) => stripComments(sql)).join("\n");

describe("every product job says which switches it serves", () => {
  it("has exactly one row per job in the registry", () => {
    expect(Object.keys(JOB_ACTS_BESIDE).sort()).toEqual(PRODUCT_JOBS.map((job) => job.jobName).sort());
  });

  it("ties the two shipped jobs to their switches, and no other job to any", () => {
    const tied = Object.fromEntries(Object.entries(JOB_ACTS_BESIDE).filter(([, keys]) => keys.length > 0));
    expect(tied).toEqual(HELD_JOBS);
  });

  it("names only boolean switches the migration chain defines", () => {
    for (const key of Object.values(JOB_ACTS_BESIDE).flat()) {
      expect(key).toMatch(/^features\.[a-z_]+\.[a-z0-9_]+$/);
      expect(chain, key).toMatch(new RegExp(`'${key.replaceAll(".", "\\.")}'\\s*,\\s*'boolean'`));
    }
  });

  it("covers the release calendar's held switches that a product job serves", () => {
    // The single sign-on and digest switches are held with no date today; the
    // learning period switch is held by its own migration.
    expect(RELEASE_CALENDAR_HELD_KEYS).toEqual(expect.arrayContaining(["features.intelligence.weekly_digest", "features.security.sso"]));
    expect(chain).toMatch(/features\.guidance_onboarding\.learning_period/);
  });
});

describe("withoutJobsBesideHeldSwitches", () => {
  const jobs = [
    { jobName: "notifications-dispatch-tick" },
    { jobName: "learning-period-end-tick" },
    { jobName: "issue-intelligence-weekly-digest" },
  ];
  const names = (list) => list.map((job) => job.jobName);

  it("leaves out a job whose switch the settings list left out", () => {
    const listed = new Set(["features.guidance_onboarding.learning_period"]);
    expect(names(withoutJobsBesideHeldSwitches(jobs, { listedSettingKeys: listed }))).toEqual(["notifications-dispatch-tick", "learning-period-end-tick"]);
  });

  it("brings a job back once its switch is listed (released)", () => {
    const listed = ["features.guidance_onboarding.learning_period", "features.intelligence.weekly_digest"];
    expect(names(withoutJobsBesideHeldSwitches(jobs, { listedSettingKeys: listed }))).toEqual(names(jobs));
  });

  it("lists none of those jobs while the settings list is unread", () => {
    expect(names(withoutJobsBesideHeldSwitches(jobs, { listedSettingKeys: null }))).toEqual(["notifications-dispatch-tick"]);
    expect(names(withoutJobsBesideHeldSwitches(jobs))).toEqual(["notifications-dispatch-tick"]);
  });

  it("shows a platform operator every job", () => {
    expect(withoutJobsBesideHeldSwitches(jobs, { listedSettingKeys: null, platformOperator: true })).toBe(jobs);
  });

  it("keeps a job it does not know and passes a non-list through", () => {
    expect(names(withoutJobsBesideHeldSwitches([{ jobName: "unknown-job" }], {}))).toEqual(["unknown-job"]);
    expect(withoutJobsBesideHeldSwitches(null, {})).toBeNull();
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = [{ selected: true, organizationId: ORG, chapterId: "chapter-a", organizationRoles: ["admin"], chapterRoles: [] }];
const run = (jobName, lastStatus) => ({
  jobName,
  organizationId: ORG,
  lastRunId: `${jobName}:2026-11-15T13:00`,
  lastStatus,
  lastStartedAt: "2026-11-15T13:00:00.000Z",
  lastFinishedAt: "2026-11-15T13:01:00.000Z",
  failureCode: lastStatus === "failed" ? "timeout" : null,
  acknowledged: false,
  remediation: null,
});

function renderDesk(heldScope) {
  const rpc = vi.fn(async (name) => {
    if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
    if (name === "list_organization_job_health") return { data: [run("notifications-dispatch-tick", "completed"), run("learning-period-end-tick", "failed")] };
    return { data: [] };
  });
  const session = buildMi1FeatureActor({ userId: "admin-a", organizationId: ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" });
  render(<LanguageProvider lang="en"><OperationsHealthView session={session} client={{ rpc }} heldScope={heldScope} /></LanguageProvider>);
}

describe("the Job health desk", () => {
  it("names no held feature to an organization admin, even when its job is failing", async () => {
    renderDesk({ listedSettingKeys: new Set(["features.security.mfa_required"]), platformOperator: false });
    const panel = await screen.findByRole("heading", { name: "Background job health" }).then((heading) => heading.closest("article"));
    await within(panel).findByText(/Notification dispatch/);
    expect(within(panel).queryByText(/Single sign-on/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Learning period end/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Weekly issue digest/)).not.toBeInTheDocument();
  });

});

// The admin desk hands its settings list to the desk it embeds: a switch the
// list leaves out is held, so its job is left out too.
describe("the Admin desk's Job health page", () => {
  async function renderAdmin({ listedSwitch, governance = null }) {
    const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    desk.organization = { ...desk.organization, scope: "organization" };
    desk.configuration = { ...(desk.configuration ?? {}), settings: listedSwitch ? [{ key: listedSwitch, kind: "boolean", value: true }] : [] };
    desk.compassAiGovernance = governance;
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      getOrganizationCatalogVerification: vi.fn(() => new Promise(() => {})),
      listLeadershipClaims: vi.fn(() => new Promise(() => {})),
    };
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_organization_job_health") return { data: [run("notifications-dispatch-tick", "completed"), run("learning-period-end-tick", "failed")] };
      return { data: [] };
    });
    const session = buildMi1FeatureActor({ userId: "admin-a", organizationId: ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" });
    render(
      <LanguageProvider lang="en">
        <AdminView
          api={api}
          onNotice={vi.fn()}
          data={{ member: { id: "admin-a", initials: "AA", chapterName: "Cedar Ridge Care Services", organizationId: ORG, organizationRoles: ["admin"], chapterRoles: [] } }}
          memberOperationsActor={{ userId: "admin-a", selectedOrganizationId: ORG, selectedHat: "admin", membershipStatus: "active", organizationRoles: ["admin"], mfaSatisfied: true }}
          memberOperationsClient={{ rpc: vi.fn(() => new Promise(() => {})) }}
          operationsHealth={<OperationsHealthView session={session} client={{ rpc }} embedded />}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(document.getElementById("admin-job-health")).not.toBeNull());
    const panel = within(document.getElementById("admin-job-health"));
    await panel.findByText(/Notification dispatch/);
    return panel;
  }

  it("leaves the job of a switch the settings list left out off the page", async () => {
    const panel = await renderAdmin({ listedSwitch: "features.tasks.enabled" });
    expect(panel.queryByText(/Learning period end/)).not.toBeInTheDocument();
  });

});
