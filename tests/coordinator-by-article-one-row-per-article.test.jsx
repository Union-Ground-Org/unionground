// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// finding B-50. Coordinator › By article cited listed the same articles in
// several rows ("Articles 9 and 18 · 225", "Article 18, Article 16 · 2",
// "Article 9.2; Article 7 · 1" …) because get_coordinator_kpis groups cases by
// the article text as typed. The page now shows one row per article, with a
// case citing two articles counted under each. Fictional rows only.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { articleCitations, groupCasesByArticle } from "../src/lib/caseArticles.js";

// The rows the website audit read on the demo, as the server returns them.
const AUDIT_ROWS = [
  { articles: "Articles 9 and 18", count: 225 },
  { articles: "Article 16, Article 12", count: 2 },
  { articles: "Article 18, Article 16", count: 2 },
  { articles: "Article 9, Article 7", count: 2 },
  { articles: "Article 9.2; Article 7", count: 1 },
  { articles: "Article 12, Article 14", count: 1 },
];

const simple = (rows) => rows.map((row) => [row.number ?? row.text, row.count]);

describe("one row per article (#9533 B-50)", () => {
  it("regroups the audit's rows so each article appears once, a case counted under each article it cites", () => {
    expect(simple(groupCasesByArticle(AUDIT_ROWS))).toEqual([
      [9, 228], [18, 227], [16, 4], [7, 3], [12, 3], [14, 1],
    ]);
  });

  it("reads the ways an article is typed, and counts an article once per case", () => {
    const numbers = (text) => articleCitations(text).map((citation) => citation.number);
    expect(numbers("Articles 9 and 18")).toEqual([9, 18]);
    expect(numbers("Art. 21 §3")).toEqual([21]);
    expect(numbers("art 5, 6 & 7")).toEqual([5, 6, 7]);
    expect(numbers("Artículos 4 y 11")).toEqual([4, 11]);
    expect(numbers("Article 9; Article 9.2")).toEqual([9]);
    expect(numbers("Article 12a / 13")).toEqual([12, 13]);
    expect(articleCitations("")).toEqual([]);
    expect(articleCitations(null)).toEqual([]);
  });

  // Sol's read of 58c5a7af: a number after a separator was taken as an
  // article when it is not one, and a section mark ended a list early.
  it.each([
    ["Article 9, 3rd step", [9]],
    ["Article 9 and 2024 agreement", [9]],
    ["Article 9 and 500 dollars", [9]],
    ["Articles 21 §3 and 22", [21, 22]],
    ["Article 10 of the 2024 agreement", [10]],
    ["Section 4 of Article 12", [12]],
    ["article 9 and 9.3", [9]],
    ["Artículos 4 y 12a", [4, 12]],
    ["Article 9, Seniority", [9]],
    ["Articles 9, 18 and 2024 agreement", [9, 18]],
    ["Article 3rd", []],
    // Narrow read of 52d43b88: closing punctuation after the last item.
    ["Articles 9 and 18.", [9, 18]],
    ["Articles 9 and 18. See the 2024 agreement", [9, 18]],
    ["(Articles 4, 7 and 9)", [4, 7, 9]],
    ["Article 9 and 18.5", [9, 18]],
  ])("reads only what it can read with certainty: %s", (text, expected) => {
    const citations = articleCitations(text);
    expect(citations.filter((citation) => citation.number != null).map((citation) => citation.number)).toEqual(expected);
  });

  it.each([["9, 18"], ["Seniority"], ["ARTICLE IX"], ["Article 3rd"]])("keeps %s as one text row", (text) => {
    expect(articleCitations(text)).toEqual([{ key: `text:${text.toLowerCase()}`, number: null, text }]);
  });

  it("skips counts that are not numbers", () => {
    expect(simple(groupCasesByArticle([
      { articles: "Article 1", count: true },
      { articles: "Article 2", count: [2] },
      { articles: "Article 3", count: "4" },
      { articles: "Article 5", count: 2 },
    ]))).toEqual([[5, 2]]);
  });

  it("keeps text with no article number as its own row, matched regardless of case and spacing", () => {
    expect(simple(groupCasesByArticle([
      { articles: "Seniority  clause", count: 2 },
      { articles: "seniority clause", count: 1 },
      { articles: "Article 3", count: 1 },
      { articles: "Article 4", count: 0 },
    ]))).toEqual([["Seniority clause", 3], [3, 1]]);
  });
});

function renderArticles(lang, rows, path = "/m/coordinator/articles") {
  window.history.replaceState({}, "", path);
  const api = {
    loadDesk: vi.fn(async () => ({
      kpis: { openCases: 0, dueThisWeek: 0, inArbitration: 0, resolved: 0, resolutionRate: 0, byStep: [], byArticle: rows },
      cases: [],
    })),
    loadCases: vi.fn(async () => ({ cases: [], nextCursor: null })),
    recordAccess: vi.fn().mockResolvedValue({ ok: true }),
  };
  return render(
    <LanguageProvider lang={lang}>
      <CoordinatorView
        data={{ member: { id: "coordinator-fictional", initials: "CF" } }}
        accessActor={{ userId: "coordinator-fictional", selectedOrganizationId: "org-fictional", roles: ["coordinator"], membershipStatus: "active" }}
        api={api}
        onNotice={() => {}}
      />
    </LanguageProvider>,
  );
}

afterEach(() => {
  window.history.replaceState({}, "", "/m/coordinator");
  clearDeviceParityState();
});

// The ruling of 11:11 PM ET: the breakdown line labelled articles cited
// counted text rows such as "Seniority". It counts numbered articles only.
describe("the Resolution rate breakdown counts articles, not text rows (#9533 B-50)", () => {
  const TEXT_ONLY = [{ articles: "Seniority", count: 3 }];
  const ONE = [{ articles: "Seniority", count: 3 }, { articles: "Art. 7", count: 1 }, { articles: "Article 7", count: 2 }];
  const SEVERAL = [...AUDIT_ROWS, { articles: "Seniority", count: 3 }];
  it.each([
    ["en", "0 articles cited", "Resolution rate", TEXT_ONLY],
    ["en", "1 article cited", "Resolution rate", ONE],
    ["en", "6 articles cited", "Resolution rate", SEVERAL],
    ["es", "0 artículos citados", "Tasa de resolución", TEXT_ONLY],
    ["es", "1 artículo citado", "Tasa de resolución", ONE],
    ["es", "6 artículos citados", "Tasa de resolución", SEVERAL],
  ])("%s: the breakdown says %s", async (lang, line, kpi, rows) => {
    renderArticles(lang, rows, "/m/coordinator");
    const button = await screen.findByRole("button", { name: new RegExp(kpi, "u") });
    fireEvent.click(button);
    const facts = await waitFor(() => {
      const element = document.querySelector("#coordinator-kpi-breakdown .gq-resolution__facts");
      expect(element).not.toBeNull();
      return element;
    });
    const spans = [...facts.querySelectorAll("span")].map((span) => span.textContent);
    expect(spans).toContain(line);
  });
});

