// BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: tablet
// and phone have no Chapters rail, so My chapter lists a multi-chapter
// member's own chapters with the same one-click switch.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterMembershipSwitch } from "../src/components/ChapterMembershipSwitch.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { normalizeLiveChapters } from "../src/lib/chapterRail.js";

afterEach(cleanup);

const twoChapters = normalizeLiveChapters({
  chapterId: "hb-local",
  chapterName: "Harrow Bay Local",
  chapterMemberships: [{ chapterId: "hb-hhs", name: "HHS Chapter", selected: false }],
});

function show(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><ChapterMembershipSwitch {...props} /></LanguageProvider>);
}

describe("My chapter membership switch", () => {
  it("adds nothing for a member of one chapter", () => {
    const { container } = show({ chapters: twoChapters.slice(0, 1), selectedId: "hb-local", onSelect: vi.fn() });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every membership, marks the selected one, and selects another in one click", () => {
    const onSelect = vi.fn();
    show({ chapters: twoChapters, selectedId: "hb-local", onSelect });
    expect(screen.getByRole("heading", { name: "Your campaigns" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Harrow Bay Local" })).toHaveAttribute("aria-pressed", "true");
    const hhs = screen.getByRole("button", { name: "Open HHS Chapter" });
    expect(hhs).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hhs);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "hb-hhs", name: "HHS Chapter" }));
  });

  it("disables every choice while a switch is settling, and speaks Spanish", () => {
    const onSelect = vi.fn();
    show({ chapters: twoChapters, selectedId: "hb-local", onSelect, busy: true }, "es");
    expect(screen.getByRole("heading", { name: "Tus campañas" })).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("aria-disabled", "true");
    // Pending, not natively disabled (record 8435): a click is still refused.
    for (const button of screen.getAllByRole("button")) fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is placed on My chapter under the page header", () => {
    render(
      <LanguageProvider lang="en">
        <ProductHubView
          data={{ member: { id: "m-1", chapterId: "hb-local" }, product: { spaces: [], documents: [], threads: [], tasks: [] }, conversations: [], broadcasts: [] }}
          chapterSwitch={<ChapterMembershipSwitch chapters={twoChapters} selectedId="hb-local" onSelect={vi.fn()} />}
          onAssistant={vi.fn()}
          preview
        />
      </LanguageProvider>,
    );
    const heading = screen.getByRole("heading", { name: "Your campaigns" });
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
