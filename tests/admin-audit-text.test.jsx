// BUG-UG-WEB-ADMIN-AUDIT-RAW-CODES-AND-CUT-SENTENCE-20261002: the
// admin audit trail printed raw action codes (grant_chapter_membership) and
// "System granted Admin to" with the person missing. Every code the database
// allows must read as a sentence in English and Spanish, with the exact code
// still available on the row.
import { readdirSync, readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView, auditText } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// The latest migration that (re)defines member_admin_audit_action_check is
// the vocabulary the audit table accepts today.
function auditActionCodes() {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  let definition = null;
  for (const name of files) {
    const sql = readFileSync(`${dir}/${name}`, "utf8");
    const at = sql.lastIndexOf("add constraint member_admin_audit_action_check");
    if (at >= 0) definition = sql.slice(at, sql.indexOf(";", at));
  }
  return [...definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function translator(lang) {
  return (key, vars = {}) => {
    const template = catalogue[lang][key];
    if (template === undefined) throw new Error(`missing ${lang} key ${key}`);
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
  };
}

const DETAIL = {
  role: "admin",
  chapterId: "ma-dcf",
  title: "Member meeting",
  item: "Chapter mug",
  to: "fulfilled",
  factorsRemoved: 1,
  requireStaffMfa: true,
  enabled: true,
  hourlyLimit: 12,
  status: "verified",
  kind: "ballot",
  wrongAttempts: 5,
};

const codes = auditActionCodes();

describe("admin audit vocabulary", () => {
  it("reads the constraint's full vocabulary", () => {
    expect(codes).toContain("grant_role");
    expect(codes).toContain("grant_chapter_membership");
    expect(codes).toContain("revoke_chapter_membership");
    expect(codes.length).toBeGreaterThanOrEqual(28);
  });

  it.each(["en", "es"])("gives every allowed action code a %s sentence, never the code or a dangling word", (lang) => {
    const t = translator(lang);
    const generic = t("admin.actionOther", { actor: "Alex Rivera" });
    for (const action of codes) {
      for (const targetName of ["Jordan Bell", null]) {
        const text = auditText({ action, actorName: "Alex Rivera", targetName, detail: DETAIL }, t);
        expect(text, `${lang} ${action}`).not.toContain(action);
        expect(text, `${lang} ${action}`).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
        expect(text, `${lang} ${action}`).not.toMatch(/\{\w+\}/);
        expect(text, `${lang} ${action}`).not.toMatch(/\s(to|from|a|de|para)$/);
        // A code that falls to the generic sentence has no label of its own.
        expect(text, `${lang} ${action} has no sentence of its own`).not.toBe(generic);
      }
    }
  });

  it.each([
    ["en", "create_chapter", "Alex Rivera created a campaign", "Alex Rivera created campaign DCF Campaign"],
    ["en", "update_chapter", "Alex Rivera updated a campaign", "Alex Rivera updated campaign DCF Campaign"],
    ["es", "create_chapter", "Alex Rivera creó una campaña", "Alex Rivera creó la campaña DCF Campaign"],
    ["es", "update_chapter", "Alex Rivera actualizó una campaña", "Alex Rivera actualizó la campaña DCF Campaign"],
  ])("%s %s never repeats the word campaign when the campaign is unknown", (lang, action, unnamed, named) => {
    const chapterName = (id) => ({ "ma-dcf": "DCF Campaign" })[id];
    expect(auditText({ action, actorName: "Alex Rivera", targetName: null, detail: {} }, translator(lang), chapterName)).toBe(unnamed);
    expect(auditText({ action, actorName: "Alex Rivera", targetName: null, detail: { chapterId: "ma-dcf" } }, translator(lang), chapterName)).toBe(named);
  });

  it("names the chapter, in English and Spanish, for chapter membership changes", () => {
    const chapterName = (id) => ({ "ma-dcf": "North County Transit Workers" })[id];
    const row = (action) => ({ action, actorName: "Alex Rivera", targetName: "Jordan Bell", detail: { chapterId: "ma-dcf" } });
    expect(auditText(row("grant_chapter_membership"), translator("en"), chapterName)).toBe("Alex Rivera added Jordan Bell to North County Transit Workers");
    expect(auditText(row("revoke_chapter_membership"), translator("en"), chapterName)).toBe("Alex Rivera removed Jordan Bell from North County Transit Workers");
    expect(auditText(row("grant_chapter_membership"), translator("es"), chapterName)).toBe("Alex Rivera agregó a Jordan Bell a North County Transit Workers");
    expect(auditText(row("revoke_chapter_membership"), translator("es"), chapterName)).toBe("Alex Rivera quitó a Jordan Bell de North County Transit Workers");
  });

  it("completes a grant whose person was removed, and starts a sentence with a capital", () => {
    const grant = { action: "grant_role", actorName: "System", targetName: null, detail: { role: "admin" } };
    expect(auditText(grant, translator("en"))).toBe("System granted Admin to a removed account");
    expect(auditText(grant, translator("es"))).toBe("System otorgó Administrador a una cuenta eliminada");
    const claim = { action: "claim_reward", actorName: "System", targetName: null, detail: { item: "Chapter mug" } };
    expect(auditText(claim, translator("en"))).toBe("A removed account claimed the reward Chapter mug");
  });

  it("reads an unknown future code as a generic change", () => {
    const row = { action: "rotate_signing_key", actorName: "Alex Rivera", targetName: null, detail: {} };
    expect(auditText(row, translator("en"))).toBe("Alex Rivera made an admin change");
    expect(auditText(row, translator("es"))).toBe("Alex Rivera hizo un cambio administrativo");
  });
});

describe("admin audit trail rows", () => {
  function renderTrail(lang, audit) {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.audit = audit.map((row, index) => ({ id: `audit-${index}`, actorName: "System", createdLabel: "Sep 29", detail: {}, ...row }));
    render(<LanguageProvider lang={lang}>
      <AdminView
        data={{ member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] } }}
        api={{ loadDesk: vi.fn().mockResolvedValue(seed) }}
        onNotice={vi.fn()}
      />
    </LanguageProvider>);
  }

  it.each([
    ["en", "Recent admin activity", ["System granted Admin to a removed account", "System added Jordan Bell to North County Transit Workers", "System removed Jordan Bell from Lakeside Library Workers"], "Action code: grant_chapter_membership"],
    ["es", catalogue.es["admin.auditTitle"], ["System otorgó Administrador a una cuenta eliminada", "System agregó a Jordan Bell a North County Transit Workers", "System quitó a Jordan Bell de Lakeside Library Workers"], "Código de acción: grant_chapter_membership"],
  ])("renders %s sentences with the exact code kept on the row", async (lang, title, sentences, codeTitle) => {
    renderTrail(lang, [
      { action: "grant_role", targetName: null, detail: { role: "admin" } },
      { action: "grant_chapter_membership", targetName: "Jordan Bell", detail: { chapterId: "ma-dcf" } },
      { action: "revoke_chapter_membership", targetName: "Jordan Bell", detail: { chapterId: "ma-dmh" } },
    ]);
    const card = (await screen.findByRole("heading", { name: title })).closest("article");
    for (const sentence of sentences) expect(within(card).getByText(sentence)).toBeInTheDocument();
    for (const code of ["grant_role", "grant_chapter_membership", "revoke_chapter_membership"]) {
      expect(within(card).queryByText(code)).toBeNull();
    }
    const row = within(card).getByText(sentences[1]);
    expect(row).toHaveAttribute("data-audit-action", "grant_chapter_membership");
    expect(row).toHaveAttribute("title", codeTitle);
  });

  it("shows every allowed code as a sentence through the pager", async () => {
    renderTrail("en", codes.map((action) => ({ action, targetName: "Jordan Bell", detail: DETAIL })));
    const card = (await screen.findByRole("heading", { name: "Recent admin activity" })).closest("article");
    let more;
    while ((more = within(card).queryByRole("button", { name: /Show more/ }))) fireEvent.click(more);
    const rows = [...card.querySelectorAll(".xus-atext")];
    expect(rows.map((row) => row.getAttribute("data-audit-action"))).toEqual(codes);
    for (const row of rows) expect(row.textContent).not.toBe(row.getAttribute("data-audit-action"));
  });
});

// Branch coverage for the audit phrase's fallbacks: a row with no detail, no
// actor and no chapter still reads as a sentence, and each two-sided verb reads
// both ways.
describe("auditText fallbacks and two-sided verbs", () => {
  const t = translator("en");
  const row = (action, detail, extra = {}) => ({ action, detail, actorName: "Alex Rivera", targetName: "Dee Whitcombe", ...extra });

  it.each([
    ["reset_mfa", undefined],
    ["fulfill_reward", undefined],
    ["set_compass_ai_role_limit", { role: "not-a-role" }],
    ["event_checkin_lockout", undefined],
    ["grant_role", { role: "admin" }],
  ])("reads %s with nothing but the action", (action, detail) => {
    const text = auditText(row(action, detail, { actorName: "", targetName: "" }), t);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("reads each two-sided verb both ways", () => {
    const on = auditText(row("set_staff_mfa_policy", { requireStaffMfa: true }), t);
    const off = auditText(row("set_staff_mfa_policy", { requireStaffMfa: false }), t);
    expect(on).not.toBe(off);
    expect(auditText(row("set_compass_ai_enabled", { enabled: true }), t)).not.toBe(auditText(row("set_compass_ai_enabled", { enabled: false }), t));
    expect(auditText(row("set_chapter_display_title", { title: "Local 12" }), t)).not.toBe(auditText(row("set_chapter_display_title", {}), t));
  });

  it("names the chapter by id when the lookup has no name, and says the chapter is unknown when there is none", () => {
    expect(auditText(row("create_chapter", { chapterId: "ma-x" }), t, () => "")).toContain("ma-x");
    expect(auditText(row("create_chapter", {}), t)).toContain(catalogue.en["admin.auditUnknownChapter"]);
  });
});
