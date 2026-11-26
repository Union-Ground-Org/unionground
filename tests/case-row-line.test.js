// REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015):
// case list rows and search hits name a case by reference, type and step, in
// the reader's language, and never show its topic or articles.
import { describe, expect, it } from "vitest";
import { CASE_TYPES, caseRowLine } from "../src/lib/caseRowLine.js";
import { buildSearchIndex, searchEntries, serverCaseEntries } from "../src/lib/searchIndex.js";
import { t } from "../src/lib/i18n.js";

const tEn = (key, vars) => t("en", key, vars);
const tEs = (key, vars) => t("es", key, vars);

describe("caseRowLine", () => {
  it("says the type and step in English and Spanish", () => {
    expect(caseRowLine({ caseType: "Discipline", step: "Step 2" }, tEn)).toBe("Discipline · Step 2");
    expect(caseRowLine({ caseType: "Discipline", step: "Step 2" }, tEs)).toBe("Disciplina · Step 2");
    expect(caseRowLine({ caseType: "Pay", step: "" }, tEs)).toBe("Salario");
  });

  it("keeps an untranslated type as stored and names a typeless case plainly", () => {
    expect(caseRowLine({ caseType: "Grievance", step: "Intake" }, tEs)).toBe("Grievance · Intake");
    expect(caseRowLine({ caseType: " ", step: null }, tEn)).toBe("Issue");
    expect(caseRowLine({}, tEs)).toBe("Asunto");
  });

  it("shows the topic only when the server marks it shown (#7043)", () => {
    const row = { caseType: "Discipline", step: "Step 2", title: "Overtime withheld" };
    expect(caseRowLine({ ...row, topicShown: true }, tEn)).toBe("Overtime withheld");
    expect(caseRowLine({ ...row, topicShown: true }, tEs)).toBe("Overtime withheld");
    expect(caseRowLine({ ...row, topicShown: false }, tEs)).toBe("Disciplina · Step 2");
    expect(caseRowLine(row, tEn)).toBe("Discipline · Step 2");
    expect(caseRowLine({ ...row, topicShown: "true" }, tEn)).toBe("Discipline · Step 2");
    expect(caseRowLine({ ...row, title: "  ", topicShown: true }, tEs)).toBe("Disciplina · Step 2");
  });

  it("translates every type the intake form offers", () => {
    for (const type of CASE_TYPES) {
      expect(tEn(`cases.type${type}`)).not.toMatch(/^cases\./);
      expect(tEs(`cases.type${type}`)).not.toMatch(/^cases\./);
    }
  });
});

describe("neutral case search entries", () => {
  const topic = "quillfeather overtime withheld";
  const ownCase = { id: "c1", reference: "GR-1", title: topic, type: "Pay", step: "Step 1", articles: "Article 9 quillfeather", deadline: "", updates: [] };

  it("shows a local case hit by reference, type and step, while the owner's own topic still finds it", () => {
    const [hit] = searchEntries(buildSearchIndex({ cases: [ownCase] }, tEs), "quillfeather").flatMap((group) => group.items);
    // This edition's local index names the reference and type; grievance steps are left out.
    expect(hit).toMatchObject({ type: "case", title: "GR-1 · Salario", snippet: "" });
    expect(JSON.stringify({ title: hit.title, snippet: hit.snippet, meta: hit.meta })).not.toContain("quillfeather");
  });

  it("localizes a server hit when given a translator and keeps the server's line otherwise", () => {
    const row = { case_id: "c1", reference: "GR-1", title: "Pay · Step 1", case_type: "Pay", step: "Step 1", articles: null, headline: null, headline_source: "title" };
    // The localized line names no grievance step (left out of this edition);
    // without a translator the server's own line is kept as sent.
    expect(serverCaseEntries([row], { t: tEs })[0]).toMatchObject({ title: "GR-1 · Salario", snippet: "", headlineSource: "title" });
    expect(serverCaseEntries([row])[0].title).toBe("GR-1 · Pay · Step 1");
  });

  it("names a server hit by its topic only where the server marks it shown (#7043)", () => {
    const shown = { case_id: "c1", reference: "GR-1", title: "Overtime withheld", case_type: "Pay", step: "Step 1", headline: null, headline_source: "title", topic_shown: true };
    expect(serverCaseEntries([shown], { t: tEs })[0].title).toBe("GR-1 · Overtime withheld");
    expect(serverCaseEntries([shown])[0].title).toBe("GR-1 · Overtime withheld");
    const neutral = { ...shown, title: "Pay · Step 1", topic_shown: false };
    expect(serverCaseEntries([neutral], { t: tEs })[0].title).toBe("GR-1 · Salario");
  });
});
