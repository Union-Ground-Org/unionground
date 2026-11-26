// BUG-UG-ANALYTICS-CHARTS-NAME-MEMBERS-BELOW-PRIVACY-FLOOR-20261111
// (#8206). Owner correction, 8:28 AM ET Nov 12, 2026: a group of 25 or fewer
// members sees its named members with scores and labels. The Health tree and
// Explorer keep naming every member of a small organization, and the
// analytics text says so instead of promising that small groups stay hidden.
// A member who hid their Pulse score (#6774) is still named, without a score or
// the usual support label, and the text says so. A chapter's own aggregate
// score keeps its floor.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_COHORT_FLOOR,
  composeAnalyticsWorkspace,
  createPreviewAnalyticsViewer,
} from "../src/features/analytics/index.js";
import { AnalyticsExplorerPanel, OrganizationHealthPanel } from "../src/features/analytics/ui/AnalyticsParityPanels.jsx";
import { analyticsStrings as en } from "../src/lib/i18n/locales/en/analytics.js";
import { analyticsStrings as es } from "../src/lib/i18n/locales/es/analytics.js";

const ORG = "preview-analytics-org";
const PEOPLE = [
  ["Teo Ramos", 41, "watch"],
  ["Port Kinsey", 58, "support"],
  ["Lena Ortiz", 77, "steady"],
];

// An organization of three members in one chapter: far below the floor.
function smallOrganization() {
  return composeAnalyticsWorkspace({
    viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    workspace: {
      organizationId: ORG,
      generatedAt: "2026-11-12T12:00:00Z",
      privacyThreshold: ANALYTICS_COHORT_FLOOR,
      members: PEOPLE.map(([name, overallScore, attention], index) => ({
        organizationId: ORG,
        id: `member-${index}:chapter-small`,
        name,
        chapterId: "chapter-small",
        chapterName: "Harbor Chapter",
        overallScore,
        attention,
      })).concat({
        organizationId: ORG,
        id: "member-hidden:chapter-small",
        name: "Blair Hidden",
        chapterId: "chapter-small",
        chapterName: "Harbor Chapter",
        overallScore: 90,
        attention: "watch",
        scoreHidden: true,
      }),
      chapterHealth: [{
        organizationId: ORG,
        chapterId: "chapter-small",
        chapterName: "Harbor Chapter",
        memberCount: PEOPLE.length + 1,
        protected: true,
        score: null,
      }],
      datasets: [],
      layouts: [],
    },
  });
}

describe("organization analytics for a group of 25 or fewer members (#8206)", () => {
  it("keeps every named member, score and label in a three-member organization", () => {
    const workspace = smallOrganization();
    expect(workspace.state).toBe("ready");
    expect(workspace.members.map((member) => [member.name, member.overallScore, member.attention])).toEqual([...PEOPLE, ["Blair Hidden", null, null]]);
  });

  it("names each member with a score and a label in the Explorer", () => {
    render(<AnalyticsExplorerPanel workspace={smallOrganization()} />);
    const [, body] = screen.getAllByRole("rowgroup");
    const rows = within(body).getAllByRole("row");
    expect(rows).toHaveLength(PEOPLE.length + 1);
    expect(within(rows[0]).getByRole("button", { name: "Teo Ramos" })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("41");
    expect(rows[0]).toHaveTextContent("Watch");
    expect(rows[1]).toHaveTextContent("Support");
    // A hidden score stays hidden: the member is named, with no score or label.
    expect(within(rows[3]).getByRole("button", { name: "Blair Hidden" })).toBeInTheDocument();
    expect(within(rows[3]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Blair Hidden", "Harbor Chapter", "—", "—"]);
    expect(screen.getByText("Members are named in every group, including groups of 25 or fewer. Scores and support labels show unless a member has hidden their score.")).toBeInTheDocument();
  });

  it("names the members in the Health tree while the chapter's own score keeps its floor", () => {
    render(<OrganizationHealthPanel workspace={smallOrganization()} />);
    for (const [name] of [...PEOPLE, ["Blair Hidden"]]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText("This chapter's own score shows once it has at least 25 members. Its members are named below.")).toBeInTheDocument();
  });

  it("says the same in Spanish in the Explorer", () => {
    render(<AnalyticsExplorerPanel workspace={smallOrganization()} lang="es" />);
    expect(screen.getByText("Cada miembro aparece con nombre en todos los grupos, también en los de 25 o menos. La puntuación y la etiqueta de apoyo aparecen salvo si la persona decidió ocultar la puntuación.")).toBeInTheDocument();
  });

});
