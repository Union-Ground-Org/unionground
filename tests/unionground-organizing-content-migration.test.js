// @vitest-environment node
// Offline pins for three Union Ground database corrections of 2026-10-15:
// rights lessons and Guide rows that hold before recognition (D4), staff peer
// contact for Organizers (D5), and a coordination snapshot without mission
// leaderboards (D5). tests/unionground-organizing-content-db.test.js proves
// the installed result on the disposable stack.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const rights = loadMigrationSql("20261015130000_unionground_rights_guidance_before_recognition.sql");
const rightsCode = stripComments(rights);
const peer = stripComments(loadMigrationSql("20261015140000_unionground_peer_contact_organizer.sql"));
const coordination = stripComments(loadMigrationSql("20261015150000_unionground_coordination_without_leaderboards.sql"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function updateFor(id) {
  const start = rightsCode.indexOf("update public.member_rights_lessons\nset");
  const blocks = rightsCode.slice(start).split("update public.member_rights_lessons\n").filter(Boolean);
  const block = blocks.find((candidate) => candidate.includes(`where id = '${id}';`));
  expect(block, id).toBeTruthy();
  return block.slice(0, block.indexOf(`where id = '${id}';`));
}

function quotedSteps(block, column) {
  const start = block.indexOf(`${column} = pg_catalog.jsonb_build_array(`);
  expect(start, column).toBeGreaterThan(-1);
  const body = block.slice(start, block.indexOf("),", start) + 1);
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

describe("rights lessons and Guide rows before recognition (D4)", () => {
  it("rewrites the weingarten lesson to the pre-recognition guidance in both languages and keeps its id", () => {
    const block = updateFor("weingarten");
    expect(quotedSteps(block, "steps")).toEqual([
      "Ask whether the meeting could lead to discipline.",
      "Ask for a coworker to be present. The employer may say no, but asking is still worth it.",
      "Stay calm. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.",
      "Right after, write down the time, place, people, and documents, and tell a committee member or organizer.",
    ]);
    expect(quotedSteps(block, "steps_es")).toEqual([
      "Pregunta si la reunión podría llevar a una medida disciplinaria.",
      "Pide que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.",
      "Mantén la calma. No adivines ni especules, no firmes nada con lo que no estés de acuerdo y pide una copia de todo lo que te entreguen o te pidan firmar.",
      "Justo después, anota la hora, el lugar, las personas y los documentos, y cuéntaselo a un miembro del comité o a un organizador.",
    ]);
    expect(block).toContain("title = 'Surprise disciplinary meeting'");
    expect(block).toContain("title_es = 'Reunión disciplinaria sorpresa'");
    expect(block).toContain("script = 'Could this meeting lead to discipline? If it could, I would like a coworker to be present. I will not sign anything I disagree with, and I would like a copy of anything you give me or ask me to sign.'");
    expect(block).toContain("script_es = '¿Esta reunión podría llevar a una medida disciplinaria? Si es así, quisiera que un compañero o compañera de trabajo esté presente. No voy a firmar nada con lo que no esté de acuerdo, y quisiera una copia de todo lo que me entreguen o me pidan firmar.'");
    expect(block).not.toMatch(/\bset id\b|, id =/);
  });

  it("rewrites every other seeded lesson without a union promise and keeps each language in step", () => {
    for (const id of ["loudermill", "harassment", "pip", "safety", "weingarten"]) {
      const block = updateFor(id);
      expect(block, id).not.toMatch(/union representation|union representative|union assistance|steward|representación sindical|representante sindical|asistencia sindical|delegad[oa]/i);
      expect(quotedSteps(block, "steps_es"), id).toHaveLength(quotedSteps(block, "steps").length);
    }
  });

  it("rewrites the nine Guide sample rows by slug, with Weingarten scoped to represented workplaces", () => {
    const rows = [...rightsCode.matchAll(/\('([a-z0-9-]+)', '(faq|rights)',\s+'((?:[^']|'')*)', '((?:[^']|'')*)',\s+'((?:[^']|'')*)',/g)]
      .map(([, slug, kind, title, ref, body]) => ({ slug, kind, title, ref, body: body.replace(/''/g, "'") }));
    expect(rows.map((row) => row.slug).sort()).toEqual([
      "contract-article-12-discipline", "contract-article-16-health-and-safety", "contract-article-24-telework",
      "contract-article-3-union-rights-and-representation", "contract-article-5-grievance-procedure", "contract-article-7-hours-of-work",
      "faq-dues-and-fair-share", "faq-file-a-grievance", "faq-weingarten-rights",
    ]);
    for (const row of rows) {
      expect(`${row.title} ${row.ref} ${row.body}`, row.slug).not.toMatch(/union representation|steward|file a grievance|grievable|step [12]\b|tamarack|local 509|seiu|\b509\b|fair[- ]share|massability|\bdds\b/i);
    }
    const weingarten = rows.find((row) => row.slug === "faq-weingarten-rights").body;
    expect(weingarten).toContain("They generally apply once a union represents the workplace.");
    expect(weingarten).toContain("ask for a coworker to be present as a witness");
    expect(weingarten).toContain("act together about working conditions under Section 7 of the National Labor Relations Act");
    expect(rightsCode).toContain("where article.slug = rewrite.slug\n  and article.is_sample;");
  });

  it("fails the migration if any seeded row still promises an existing union's protections", () => {
    expect(rightsCode).toContain("raise exception 'a rights lesson still promises an existing union''s protections'");
    expect(rightsCode).toContain("raise exception 'a seeded Guide row still assumes an existing union, contract or grievance procedure'");
    expect(rights).not.toMatch(/union members?\b|members? of (?:a|the) union/i);
  });
});

describe("staff peer contact for Organizers (D5)", () => {
  it("adds organizer beside steward in both role lists and keeps every other check", () => {
    // The function is quoted with $staff$, as in 20261007012625.
    const start = peer.indexOf("create or replace function private.member_peer_staff_eligible(p_user_id uuid, p_chapter_id text)");
    expect(start).toBeGreaterThan(-1);
    const body = peer.slice(start, peer.indexOf("$staff$;", start) + "$staff$;".length);
    expect(body.match(/role in \('steward','organizer','coordinator','advisor','admin','vp'\)/g)).toHaveLength(2);
    expect(body).not.toContain("role in ('steward','coordinator'");
    const entry = contract.functions.find((candidate) => candidate.sig === "private.member_peer_staff_eligible(p_user_id uuid, p_chapter_id text)");
    for (const needle of entry.bodyContains) expect(body).toContain(needle);
    expect(peer).toContain("revoke all on function private.member_peer_staff_eligible(uuid,text) from public, anon, authenticated, service_role;");
    const definers = migrationFiles().filter((file) => /create (?:or replace )?function private\.member_peer_staff_eligible\(/.test(stripComments(file.sql)));
    expect(definers.at(-1).name).toBe("20261015140000_unionground_peer_contact_organizer.sql");
  });
});

describe("coordination snapshot without mission leaderboards (D5)", () => {
  it("installs a snapshot with no leaderboard, points or ranking alias, and keeps the rest of the contract", () => {
    const body = fnBody(coordination, "public.get_organization_coordination_snapshot");
    for (const absent of ["leaderboards", "privacy_alias", "points", "participantCount", "organization_coordination_user_participants"]) {
      expect(body).not.toContain(absent);
    }
    const entry = contract.functions.find((candidate) => candidate.sig === "public.get_organization_coordination_snapshot()");
    expect(JSON.stringify(entry.bodyContains)).not.toMatch(/privacy_alias|participantCount|status_rank/);
    expect(coordination).toContain("revoke all on function public.get_organization_coordination_snapshot()\n  from public, anon, authenticated, service_role;");
    expect(coordination).toContain("grant execute on function public.get_organization_coordination_snapshot()\n  to authenticated;");
    // The platform re-emit keeps the same constraints on the installed function.
    const definers = migrationFiles().filter((file) => /create (?:or replace )?function public\.get_organization_coordination_snapshot\(/.test(stripComments(file.sql)));
    expect(definers.map(({ name }) => name)).toContain("20261018024652_coordination_snapshot_resolved_visibility.sql");
    expect(definers.at(-1).name).toBe("20261028080000_platform_organization_boundary.sql");
    const installed = fnBody(stripComments(definers.at(-1).sql), "public.get_organization_coordination_snapshot");
    for (const absent of ["leaderboards", "privacy_alias", "points", "participantCount", "organization_coordination_user_participants"]) {
      expect(installed).not.toContain(absent);
    }
    for (const needle of entry.bodyContains) expect(installed).toContain(needle);
  });

  it("matches a client that neither reads nor exposes leaderboards", () => {
    const authorization = readFileSync(new URL("../src/features/coordination/authorization.js", import.meta.url), "utf8");
    expect(authorization).not.toMatch(/leaderboards/);
  });
});
