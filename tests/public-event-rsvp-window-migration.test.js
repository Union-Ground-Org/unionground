// @vitest-environment node
//
// BUG-UG-PUBLIC-EVENT-RSVP-RPC-ACCEPTS-SUBMISSIONS-ENDED-FAR-PAST-PUBLISHED-20260921
//
// submit_public_event_rsvp resolved a published meeting with no time predicate,
// so the service-only write boundary accepted RSVPs for meetings that ended
// months ago while the published event page offers no RSVP form at all. These
// pins read the LAST definition in apply order, not one chosen generation: the
// function has been redefined three times and wrapped once, and a pin on a
// superseded copy stays green forever while the live object moves on.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { withoutRowsPickedOnce } from "./helpers/bounded-cleanup.js";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const REPAIR = "20260925220000_public_event_rsvp_ended_meeting_gate";
const VISIBILITY = "20261023050348_bot_organization_directory_visibility";
const WRAPPER = "20260907151000_account_deletion_finalization_reconciliation";
// #8605 re-emits the routine only so its prune picks its rows once.
const PICK_ONCE = "20261113123500_bounded_cleanups_pick_rows_once";
const SIGNATURE = "public.submit_public_event_rsvp(";
const WINDOW = "coalesce(r.ends_at, r.starts_at) >= now()";
// The case-graph entry gate 20260907151000 prepends to every reviewed writer.
// A repair that re-emits the routine without it silently drops the function out
// of the shared lock order.
const CASE_GRAPH_GATE = "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// prosrc as Postgres stores it: exactly the text between the body's dollar
// quotes, which is what both hash ledgers in the migrations digest.
function storedSource(sql, at) {
  const opens = sql.indexOf("as $function$", at) + "as $function$".length;
  return sql.slice(opens, sql.indexOf("$function$;", opens));
}

// 20260907151000 rebuilds each reviewed writer as `begin <gate> <original> end;`.
function caseGraphWrapped(source) {
  return `\nbegin\n  ${CASE_GRAPH_GATE}\n${source.replace(/[\n\r\t ]+$/, "")}\nend;\n`;
}

// Every migration that DECLARES the routine, in apply order. A file that only
// re-grants it is not a definition and must not be mistaken for the tail.
function definitionsOf(name) {
  const declares = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${name.replace(/[.(]/g, "\\$&")}`, "i");
  return migrationFiles()
    .map((entry) => ({ name: entry.name, code: stripComments(entry.sql) }))
    .filter((entry) => declares.test(entry.code));
}

describe("public event RSVP time window (static)", () => {
  it("bounds the LAST definition of the RPC by the meeting's own end time", () => {
    const all = definitionsOf(SIGNATURE);
    expect(all.at(-1).name).toBe(`${PICK_ONCE}.sql`);
    expect(withoutRowsPickedOnce(fnBody(all.at(-1).code, SIGNATURE)))
      .toBe(withoutRowsPickedOnce(fnBody(all.at(-2).code, SIGNATURE)));
    expect(fnBody(all.at(-1).code, SIGNATURE)).toContain(WINDOW);
    const definitions = all.slice(0, -1);
    expect(definitions.at(-1).name).toBe("20261028080000_platform_organization_boundary.sql");
    expect(definitions.at(-2).name).toBe(`${VISIBILITY}.sql`);

    const body = fnBody(definitions.at(-1).code, SIGNATURE);
    expect(body.replace(/\n[ \t]*and private\.organization_is_union\(r\.organization_id\)/g, ""))
      .toBe(fnBody(definitions.at(-2).code, SIGNATURE));
    expect(body).toContain(WINDOW);
    // The bound belongs to the event lookup, so a past meeting resolves no
    // organization and is treated exactly like a missing one.
    expect(body).toMatch(
      /select r\.organization_id into event_org from public\.public_site_records r\s+where[^;]*coalesce\(r\.ends_at, r\.starts_at\) >= now\(\)\s+and private\.organization_visible_in_directory\(r\.organization_id\)\s+and private\.organization_is_union\(r\.organization_id\);/,
    );
    const previous = parseFunctions(stripComments(loadMigrationSql(REPAIR))).find(fn => fn.name === "public.submit_public_event_rsvp").source;
    const current = parseFunctions(definitions.at(-2).code).find(fn => fn.name === "public.submit_public_event_rsvp").source;
    const added = "\n      and private.organization_visible_in_directory(r.organization_id)";
    expect(current).toContain(added);
    expect(current.replace(added, "")).toBe(previous);
    // Only generations before the original repair lacked the bound.
    for (const earlier of definitions.filter(entry => entry.name < `${REPAIR}.sql`)) {
      expect(fnBody(earlier.code, SIGNATURE)).not.toContain(WINDOW);
    }
  });

  it("keeps the case-graph gate, the service-role boundary and the silent envelope", () => {
    const body = fnBody(stripComments(loadMigrationSql(VISIBILITY)), SIGNATURE);
    expect(body).toContain(CASE_GRAPH_GATE);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("'service role required'");
    // A refusal for an ended meeting must not become an existence oracle: the
    // only exception in the body is still the service-role one.
    expect(body.match(/raise exception/g)).toHaveLength(1);
    const code = stripComments(loadMigrationSql(REPAIR));
    expect(code).toContain(
      "grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)\n  to service_role",
    );
    expect(code).not.toMatch(/grant\s+execute[^;]+submit_public_event_rsvp[^;]+\b(anon|authenticated)\b/i);
    expect(code).toContain("comment on function public.submit_public_event_rsvp(");
  });

  it("supersedes the wrapped predecessor it names, and pins its own replacement", () => {
    const repair = loadMigrationSql(REPAIR);
    const wrapped = loadMigrationSql("20260826156000");
    const predecessorSource = caseGraphWrapped(
      storedSource(wrapped, wrapped.indexOf(`function ${SIGNATURE}`)),
    );
    expect(loadMigrationSql(WRAPPER)).toContain("'public.submit_public_event_rsvp(text,text,text,text,text,text,text,text)'");
    expect(repair).toContain(createHash("sha256").update(predecessorSource).digest("hex"));
    expect(repair).toContain(
      createHash("sha256").update(storedSource(repair, repair.indexOf(`function ${SIGNATURE}`))).digest("hex"),
    );
  });

  it("teaches the live database contract to expect the window", () => {
    const entry = contract.functions.find((fn) => fn.sig.startsWith(SIGNATURE));
    expect(entry.exec).toBe("service_role");
    expect(entry.bodyContains).toContain(WINDOW);
  });
});
