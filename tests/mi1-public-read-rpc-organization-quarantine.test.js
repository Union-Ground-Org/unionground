// @vitest-environment node
//
// SYS-UG-PUBLIC-LANDING-RPC-OMITS-ORGANIZATION-QUARANTINE-20260921
//
// public.public_site_records.organization_id says what a NULL means:
// "a quarantined pre-MI1/orphan public card [that] never authorizes a public
// RSVP" (20260822020000). Three of the four anonymous read RPCs enforced that;
// get_public_site_content, the landing reader, predates MI1 and did not, so an
// orphan card kept a landing slot while every deep link into it 404ed.
//
// This pin is deliberately written against the LAST emitter of each RPC, found
// by scanning the whole migration chain rather than by naming a file. A pin on
// one generation of a definition goes green forever the moment a later
// create-or-replace moves the live body somewhere else — which is exactly how
// the landing reader's own asymmetry survived the MI1 sweep unnoticed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

// The four SECURITY DEFINER reads granted to anon, and the quarantine conjunct
// each one's body must carry. The microsite reader loads its chapter parent
// into a `record` variable instead of aliasing the table, so its predicate is
// spelled against that variable; the other three filter the table alias `r`.
const PUBLIC_READ_RPCS = [
  { name: "get_public_site_content", predicate: "r.organization_id is not null" },
  { name: "get_public_directory", predicate: "r.organization_id is not null" },
  { name: "get_public_event_detail", predicate: "r.organization_id is not null" },
  { name: "get_public_chapter_microsite", predicate: "record.organization_id is not null" },
];

// The newest migration that (re)defines `name`, with its comments stripped, so
// a quarantine conjunct can never be satisfied by a comment quoting one.
function lastDefinition(name) {
  const declares = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i");
  const emitters = migrationFiles()
    .map((entry) => ({ name: entry.name, code: stripComments(entry.sql) }))
    .filter((entry) => declares.test(entry.code));
  if (!emitters.length) throw new Error(`no migration declares public.${name}`);
  const last = emitters.at(-1);
  return { migration: last.name, body: fnBody(last.code, `public.${name}`) };
}

describe("MI1 organization quarantine across the anonymous public read RPCs", () => {
  it("excludes ownerless cards in the live definition of every public read RPC", () => {
    for (const { name, predicate } of PUBLIC_READ_RPCS) {
      const { migration, body } = lastDefinition(name);
      expect(body, `${name} must still be a definer read`).toContain("security definer");
      expect(body, `${name} (last emitted by ${migration}) must exclude quarantined ownerless cards`)
        .toContain(predicate);
    }
  });

  it("applies the quarantine to each landing subquery, not just one of the three", () => {
    const { body } = lastDefinition("get_public_site_content");
    // chapters, wins, meetings — one scan of public_site_records each.
    const subqueries = body.split("from public.public_site_records r").slice(1);
    expect(subqueries).toHaveLength(3);
    for (const [index, subquery] of subqueries.entries()) {
      expect(subquery, `landing subquery ${index + 1} must exclude quarantined ownerless cards`)
        .toContain("r.organization_id is not null");
      expect(subquery, `landing subquery ${index + 1} must stay bounded`).toContain("limit 12");
    }
    for (const kind of ["chapter", "win", "meeting"]) {
      expect(subqueries.some((subquery) => subquery.includes(`r.kind = '${kind}'`)), `${kind} subquery`).toBe(true);
    }
    // The re-emission must not drop the bound the landing already had: only
    // meetings that have not finished yet are listed.
    expect(body).toContain("coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()");
  });

  it("pins the quarantine in the database contract for all four RPCs", () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    for (const { name, predicate } of PUBLIC_READ_RPCS) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`public.${name}(`));
      expect(entry, `${name} must have a contract entry`).toBeTruthy();
      expect(entry.exec, `${name} is an anonymous read`).toContain("anon");
      expect(entry.bodyContains, `${name} must pin the quarantine conjunct`).toContain(predicate);
    }
  });
});
