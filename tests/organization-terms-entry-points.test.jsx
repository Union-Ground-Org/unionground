import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider, organizationTranslator, useOrganizationTranslator } from "../src/lib/LanguageContext.jsx";
import { StaffAuthoringHint } from "../src/components/StaffAuthoringHint.jsx";
import { MemberQaForum } from "../src/features/qa/MemberQaForum.jsx";
import { ScimSetup } from "../src/features/integrations/ScimSetup.jsx";
import { renderGuideCopy } from "../src/features/onboardingGuideEngine/memberAdapter.js";
import { qaFailureText } from "../src/features/qa/copy.js";

function ExplicitLanguageProbe({ lang }) {
  const t = useOrganizationTranslator(lang);
  return <p>{t("orgIntel.nodeKind.chapter")}</p>;
}

const actor = { userId: "u", organizationId: "org", chapterId: "ch", membershipStatus: "active", organizationStatus: "active", organizationRoles: [], chapterRoles: [] };

describe("organization terms at direct catalogue entry points", () => {
  it.each(["en", "es"])("carries organization words into explicit-language components in %s", (lang) => {
    const overrides = { "term.chapter": "unit", "term.chapters": "units" };
    const { container, rerender } = render(<LanguageProvider lang={lang} labelOverrides={overrides}>
      <StaffAuthoringHint lang={lang} item="clauses" />
      <MemberQaForum lang={lang} actor={actor} questions={[]} />
      <ExplicitLanguageProbe lang={lang} />
    </LanguageProvider>);
    expect(container.textContent).not.toMatch(/\bchapter\b|capítulo/iu);
    expect(container.textContent).toMatch(/unit/);
    expect(screen.getByText("Unit")).toBeInTheDocument();
    rerender(<LanguageProvider lang={lang} labelOverrides={{ "term.chapter": "section" }}><ExplicitLanguageProbe lang={lang} /></LanguageProvider>);
    expect(screen.getByText("Section")).toBeInTheDocument();
  });

  it("keeps explicit-language components usable outside an organization provider", () => {
    render(<ExplicitLanguageProbe lang="es" />);
    expect(screen.getByText("Campaña")).toBeInTheDocument();
  });

  it("inherits the provider language when none was explicitly requested", () => {
    render(<LanguageProvider lang="es" labelOverrides={{ "term.chapter": "unidad" }}><ExplicitLanguageProbe /></LanguageProvider>);
    expect(screen.getByText("Unidad")).toBeInTheDocument();
  });

  it("renames SCIM's chapter setup without rewriting chapter names", async () => {
    const store = { getScimControl: vi.fn(async () => ({ ok: true, data: {
      enabled: true, canManage: true, defaultChapterId: null, tokens: [], groups: [], attention: [], users: {},
      chapters: [{ id: "ch", name: "Example Chapter" }],
    } })) };
    render(<LanguageProvider lang="en" labelOverrides={{ "term.chapter": "unit" }}><ScimSetup store={store} actor={actor} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Default unit" })).toBeInTheDocument();
    expect(screen.getByLabelText("Unit for new invitations")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save unit" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Example Chapter" })).toBeInTheDocument();
  });

  it("renames nested guide lines and Q&A refusals before inserting authored values", () => {
    const t = organizationTranslator("en", { "term.chapter": "unit" });
    expect(renderGuideCopy("en", { key: "guideEngine.announce.milestone", params: { n: 1, title: { key: "nav.myChapter" } } }, t)).toContain("My unit");
    expect(renderGuideCopy("en", { key: "admin.chapterLifecycle.memberContext", params: { chapter: "Example Chapter", roles: "Steward" } }, t)).toContain("Home unit: Example Chapter");
    expect(qaFailureText("en", { code: "chapter_required" }, t)).toContain("unit");
    expect(qaFailureText("en", { code: "membership_revoked" }, t)).toContain("unit");
  });
});
