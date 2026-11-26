import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfficerQaView } from "../src/views/OfficerQaView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildQaActor } from "../src/lib/mi1QaWiring.js";

describe("Q&A queue page title", () => {
  it.each([["en", "Q&A queue", "No open questions in your scope."], ["es", "Cola de preguntas", "No hay preguntas abiertas en tu alcance."]])("owns one h1 only when standalone in %s", async (lang, title, empty) => {
    const api = { officerQueue: vi.fn(async () => ({ ok: true, value: [] })) };
    const actor = buildQaActor({ userId: "tamarack-steward", organizationId: "tamarack", chapterId: "tamarack-chapter", organizationRoles: ["steward"], mfaSatisfied: true, selectedHat: "steward" });
    const node = embedded => <LanguageProvider lang={lang}><OfficerQaView lang={lang} actor={actor} api={api} embedded={embedded} /></LanguageProvider>;
    const view = render(node(false));
    await screen.findByText(empty);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
    view.rerender(node(true));
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});
