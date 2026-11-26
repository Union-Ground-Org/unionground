import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RightsView } from "../src/views/RightsView.jsx";

const rights = fallbackData.kbArticles.find((item) => item.slug === "cards-and-recognition");

function renderRights(focus, { lang = "en", alt = false } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <RightsView
        alt={alt}
        data={fallbackData}
        desktop
        focus={focus}
        onSaveProgress={vi.fn()}
        onRequestSteward={vi.fn()}
      />
    </LanguageProvider>,
  );
}

describe("a Compass citation on its page", () => {
  it("shows the knowledge article on Know your rights in English and Spanish", () => {
    const focus = { view: "rights", compassSource: true, sourceId: "cards-and-recognition", slug: "cards-and-recognition" };
    const { unmount } = renderRights(focus);
    expect(screen.getByRole("heading", { name: rights.title })).toBeInTheDocument();
    expect(screen.getByText(rights.body)).toBeInTheDocument();
    unmount();
    renderRights(focus, { lang: "es", alt: true });
    expect(screen.getByRole("heading", { name: rights.title_es })).toBeInTheDocument();
    expect(screen.getByText(rights.body_es)).toBeInTheDocument();
  });

  it("leaves Know your rights unchanged when nothing was cited", () => {
    renderRights(null);
    expect(screen.queryByText(rights.body)).not.toBeInTheDocument();
  });

  // A contract-article citation (the clause catalog) is left out of Union Ground.
});
