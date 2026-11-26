// @vitest-environment node
// SEC-UG-OPEN-SIGNUP-TENANT-BOUNDARY-20260925
//
// Offline pins for 20260930040100_self_serve_organization_shell_column.sql and
// 20260930040200_self_serve_organization_shell.sql. The live
// behaviour is proved by tests/open-signup-organization-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foreignKeyRelevance, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { beforeSameRefusals, SAME_REFUSALS_MIGRATION } from "./helpers/refusals-same-for-other-organizations.js";

const SHELL = "_self_serve_organization_shell.sql";
const COLUMN = "_self_serve_organization_shell_column.sql";
const TENANT_CHECK = "member_recovery_and_chapter_grant_tenant_check";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("required signup proof inventory", () => {
  it("keeps the original 29 cases and every later case required", () => {
    const names = ["open-signup-organization-db.test.js", "open-signup-organization-additional-db.test.js"];
    const numbers = names.map((name) => {
      expect(PROOF_FILES).toContain(`tests/${name}`);
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      return [...source.matchAll(/^live\('(\d+)\./gm)].map((match) => Number(match[1])).sort((a, b) => a - b);
    });
    expect(numbers[0]).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    expect(numbers[1]).toEqual(Array.from({ length: 16 }, (_, i) => i + 30));
  });
});

describe("self-serve organization shell migration (static)", () => {
  const name = findMigrationName(SHELL);
  const sql = loadMigrationSql(SHELL);
  const code = stripComments(sql);
  const functions = parseFunctions(sql, name);

  it("applies after the tenant-check migration and the Phase 4a placement migration, in one transaction", () => {
    expect(name).toBe("20260930040200_self_serve_organization_shell.sql");
    expect(findMigrationName(COLUMN)).toBe("20260930040100_self_serve_organization_shell_column.sql");
    expect(name > findMigrationName(TENANT_CHECK)).toBe(true);
    expect(name > findMigrationName("catalog_organization_self_placement")).toBe(true);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("set local statement_timeout = '60s';");
  });

  it("adds the organization columns alone in a short transaction that applies first", () => {
    const column = stripComments(loadMigrationSql(COLUMN));
    const statements = column.split(";").map((part) => part.trim()).filter(Boolean);
    expect(statements).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '60s'",
      "alter table public.organizations\n  add column self_serve_created_at timestamptz,\n  add column verified_at timestamptz,\n  add constraint organizations_verification_state\n    check (verified_at is null or self_serve_created_at is not null)",
      "commit",
    ]);
    expect(code).not.toMatch(/alter table public\.organizations/);
  });

  it("cannot change the foreign-key catalogue, so the case-graph capture stays untouched", () => {
    expect(foreignKeyRelevance(loadMigrationSql(COLUMN))).toBeNull();
    expect(foreignKeyRelevance(sql)).toBeNull();
    expect(foreignKeyRelevance(loadMigrationSql(TENANT_CHECK))).toBeNull();
  });

  it("takes the case-graph lock before anything else in create_my_organization", () => {
    const create = functions.find((fn) => fn.name === "public.create_my_organization");
    expect(create).toBeTruthy();
    expect(helperFirst(create.source)).toBe(true);
    expect(create.source).toMatch(/^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/);
  });

  it("never lets a unique-violation code or error text reach a caller", () => {
    for (const fn of functions) {
      const body = stripComments(fn.source);
      expect(body, fn.name).not.toMatch(/23505|sqlerrm|sqlstate/i);
    }
  });

  it("leaves bootstrap_first_organization and three of the tenant-check routines alone", () => {
    const names = functions.map((fn) => fn.name);
    for (const untouched of [
      "public.bootstrap_first_organization",
      "private.handle_new_member",
      "public.begin_member_signin_recovery",
      "public.begin_member_password_reissue",
    ]) {
      expect(names, untouched).not.toContain(untouched);
    }
    // The intake-cap delivery deliberately replaces this routine while keeping
    // bootstrap and member/invitation provisioning untouched; #9164 restates it
    // with only its phone-number check changed.
    const later = migrationFiles().filter((file) => file.name > name && !file.name.endsWith('_public_signup_intake_caps_final.sql')
      && !file.name.endsWith('_organization_name_phone_rule_dates_and_years.sql'));
    for (const file of later) {
      expect(stripComments(file.sql)).not.toMatch(/function\s+public\.create_my_organization\s*\(/i);
    }
  });

  it("takes one free-text name and applies the Phase 4a name rules plus an invisible-character refusal", () => {
    const create = stripComments(functions.find((fn) => fn.name === "public.create_my_organization").source);
    expect(code).toMatch(/create function public\.create_my_organization\(\s*p_name text,\s*p_idempotency_key uuid\s*\)/);
    expect(create).not.toContain("p_first_chapter_name");
    expect(create).toContain("pg_catalog.btrim(pg_catalog.regexp_replace(");
    for (const rule of ["not between 2 and 120", "~ '[[:cntrl:]]'", "!~ '[[:alnum:]]'", "strpos(clean_name, '@')", "strpos(clean_name, '://')", "~ '[[:digit:]]{7,}'"]) {
      expect(create, rule).toContain(rule);
    }
    // The digit-run strip class is the Phase 4a class exactly.
    const placement = loadMigrationSql("catalog_organization_self_placement");
    const stripClass = /regexp_replace\(parent_name, ('\[[^']+\]')/.exec(placement)[1];
    expect(create).toContain(`regexp_replace(clean_name, ${stripClass}`);
    expect(create).toMatch(/clean_name ~ '\[\\u00AD[^']*\\u200B-\\u200F\\u202A-\\u202E[^']*\\uFEFF\]'/);
    expect(create).toContain("values (new_chapter, clean_name, null, true, 1, org_id, new_chapter)");
  });

  it("gates every listed table with the one boundary trigger", () => {
    const tables = [
      "public.chapter_union_org_bindings",
      "public.chapter_handshakes",
      "public.organization_coordination_records",
      "public.organization_coordination_organization_participants",
      "public.organization_network_permission_grants",
      "public.organization_network_directory_profiles",
      "public.public_site_records",
      "private.dues_stripe_oauth_states",
      "public.dues_provider_connections",
      "public.member_invitations",
      "private.chapter_connection_profiles",
      "private.chapter_connection_hides",
    ];
    const triggers = [...code.matchAll(/create trigger b20_unverified_organization_boundary\s+before ([a-z ]+?) on ([\w.]+)\s+for each row execute function private\.enforce_unverified_organization_boundary\(\);/g)];
    expect(triggers.map((match) => match[2]).sort()).toEqual([...tables].sort());
    const boundary = functions.find((fn) => fn.name === "private.enforce_unverified_organization_boundary");
    for (const table of tables) expect(boundary.source, table).toContain(`'${table}'`);
    const contracted = contract.triggers.filter((entry) => entry.name === "b20_unverified_organization_boundary");
    const announcementTables = ["platform_announcement_publishers", "platform_organization_follows", "platform_announcements",
      "platform_announcement_delivery_jobs", "organization_platform_announcements", "platform_announcement_preferences", "platform_announcement_audit"];
    const announcements = loadMigrationSql("20261029141540_");
    for (const table of announcementTables) {
      expect(announcements).toContain(`when 'private.${table}' then`);
      expect(announcements).toContain(`before insert or update on private.${table} for each row execute function private.enforce_unverified_organization_boundary()`);
    }
    // The learning period engine (#6940) adds its two organization-owned tables.
    const learningTables = ["organization_learning_periods", "learning_action_journal"];
    const learning = loadMigrationSql("20261103163000_");
    expect(learning).toContain("when 'private.organization_learning_periods', 'private.learning_action_journal' then");
    for (const table of learningTables) {
      expect(learning).toContain(`create trigger b20_unverified_organization_boundary before insert or update on private.${table}\nfor each row execute function private.enforce_unverified_organization_boundary();`);
    }
    expect(contracted.map((entry) => `${entry.schema}.${entry.table}`).sort())
      .toEqual([...tables, ...announcementTables.map((table) => `private.${table}`), ...learningTables.map((table) => `private.${table}`)].sort());
  });

  it("re-emits the three chapter connection functions from their latest bodies with one inserted guard each", () => {
    const later = migrationFiles().filter((file) => file.name > name);
    const cases = [
      ["public.list_chapter_connection_profiles", "chapter_connection_review_repairs",
        "      and private.organization_clears_signup_boundary(org)\n", "and p.chapter_id <> viewer_chapter"],
      ["public.set_chapter_connection_hidden", "chapter_connection_review_repairs",
        / {2}-- An unverified self-created organization cannot hide another chapter\.[\s\S]*?\n {2}end if;\n/, "raise exception 'hidden flag required'"],
      ["public.request_chapter_connection_handshake", "unified_connection_handshakes",
        / {2}-- An unverified self-created organization cannot hand-shake:[\s\S]*?\n {2}end if;\n/, "raise exception 'target chapter unavailable'"],
    ];
    for (const [fn, source, inserted, before] of cases) {
      const ours = functions.filter((entry) => entry.name === fn);
      expect(ours, fn).toHaveLength(1);
      const theirs = parseFunctions(loadMigrationSql(source), source).filter((entry) => entry.name === fn).at(-1);
      expect(ours[0].source.replace(inserted, ""), fn).toBe(theirs.source);
      const body = stripComments(ours[0].source);
      const guard = body.indexOf("private.organization_clears_signup_boundary(org)");
      expect(guard, fn).toBeGreaterThan(body.indexOf(before));
      if (fn !== "public.list_chapter_connection_profiles") {
        expect(guard, fn).toBeLessThan(body.indexOf("private.chapter_connection_profiles"));
      }
      for (const file of later) {
        if (file.name === SAME_REFUSALS_MIGRATION && fn === "public.list_chapter_connection_profiles") {
          // #8365 re-emits the platform boundary body and changes only the
          // snapshot token's epoch.
          const predecessor = parseFunctions(loadMigrationSql("20261028080000_platform_organization_boundary"))
            .find((entry) => entry.name === fn);
          const successor = parseFunctions(file.sql, file.name).find((entry) => entry.name === fn);
          expect(beforeSameRefusals(fn, successor.source)).toBe(predecessor.source);
          continue;
        }
        if (file.name === '20261028080000_platform_organization_boundary.sql' && fn === 'public.list_chapter_connection_profiles') {
          // The platform boundary re-emits the fictional-exclusion body and
          // adds only the organization-kind join predicate.
          const predecessor = parseFunctions(loadMigrationSql('20261023050348_bot_organization_directory_visibility'))
            .find((entry) => entry.name === fn);
          const successor = parseFunctions(file.sql, file.name).find((entry) => entry.name === fn);
          expect(successor.source.replace(" and o.kind = 'union'", "")).toBe(predecessor.source);
          continue;
        }
        if (file.name === "20261023050348_bot_organization_directory_visibility.sql"
            && fn !== "public.set_chapter_connection_hidden") {
          // This reviewed re-emission adds only fictional-target exclusions;
          // the existing signup boundary and every other statement must survive.
          const replacements = parseFunctions(file.sql, file.name).filter((entry) => entry.name === fn);
          expect(replacements, fn).toHaveLength(1);
          let preserved = replacements[0].source;
          const additions = fn === "public.list_chapter_connection_profiles" ? [
            "      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))\n",
          ] : [
            "    and (c.organization_id = org or private.organization_visible_in_directory(c.organization_id))\n",
            "    and private.catalog_registry_identity_visible(u.id)\n",
          ];
          for (const addition of additions) {
            expect(preserved, fn).toContain(addition);
            preserved = preserved.replace(addition, "");
          }
          expect(stripComments(preserved).trim(), fn).toBe(stripComments(ours[0].source).trim());
          continue;
        }
        if (file.name === "20261109060229_unit_stewards_join_chapter_collaboration.sql"
            && fn === "public.request_chapter_connection_handshake") {
          // Unit stewards join chapter collaboration (#7665): this reviewed
          // re-emission swaps only the chapter role helper for the staff-grant one.
          const predecessor = parseFunctions(loadMigrationSql("20261023050348_bot_organization_directory_visibility"))
            .find((entry) => entry.name === fn);
          const successor = parseFunctions(file.sql, file.name).find((entry) => entry.name === fn);
          expect(successor.source.replaceAll("private.member_has_chapter_staff_grant(", "private.member_has_chapter_role("))
            .toBe(predecessor.source);
          continue;
        }
        expect(stripComments(file.sql), `${file.name} ${fn}`).not.toMatch(new RegExp(`function\\s+${fn.replace(".", "\\.")}\\s*\\(`, "i"));
      }
    }
  });

  it("answers an unverified caller's handshake request before any registry binding is read", () => {
    const request = functions.find((fn) => fn.name === "public.request_chapter_handshake");
    expect(request).toBeTruthy();
    expect(request.source).toMatch(/^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/);
    const body = stripComments(request.source);
    const early = body.indexOf("not private.organization_clears_signup_boundary(caller_organization)");
    const lookup = body.indexOf("from public.chapter_union_org_bindings b");
    expect(early).toBeGreaterThan(body.indexOf("raise exception 'invalid request'"));
    expect(early).toBeLessThan(lookup);
    const refusal = "raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';";
    expect(body.slice(early, lookup)).toContain(refusal);
    expect(body.slice(lookup)).toContain(refusal);
    expect(body.slice(0, early)).not.toMatch(/chapter_union_org_bindings|union_orgs/);
  });

  it("ships signup closed: nothing is created or charged until the owner opens the period", () => {
    expect(code).toMatch(/create table private\.open_signup_period \(\s*singleton boolean primary key default true check \(singleton\),\s*opens_at timestamptz,/);
    expect(code).toContain("revoke all on private.open_signup_period from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/insert into private\.open_signup_period/);
    expect(code).not.toMatch(/grant [^;]* on (table )?private\.open_signup_period/);
    expect(code).toContain("revoke all on function private.open_signup_is_open()\n  from public, anon, authenticated, service_role;");
    const create = stripComments(functions.find((fn) => fn.name === "public.create_my_organization").source);
    const closed = create.indexOf("if not private.open_signup_is_open() then");
    expect(closed).toBeGreaterThan(create.indexOf("raise exception 'idempotency key reused'"));
    expect(closed).toBeLessThan(create.indexOf("organization membership exists"));
    expect(closed).toBeLessThan(create.indexOf("consume_open_signup_limit_internal("));
    expect(create.slice(closed)).toMatch(/^if not private\.open_signup_is_open\(\) then\s+return pg_catalog\.jsonb_build_object\('status', 'closed'\);/);
    const consume = stripComments(functions.find((fn) => fn.name === "public.consume_open_signup_limit").source);
    expect(consume.indexOf("private.open_signup_is_open()")).toBeLessThan(consume.indexOf("consume_open_signup_limit_internal("));
    expect(consume).toContain("raise exception 'signup closed' using errcode = '55000';");
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({ table: "private.open_signup_period", role, privileges: "" });
    }
  });

  it("keeps the service-role RPCs out of reach of authenticated and anon", () => {
    for (const sig of ["public.consume_open_signup_limit(text, text)", "public.open_signup_email_available(text)"]) {
      expect(code).toContain(`revoke all on function ${sig}\n  from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(code).toContain("grant execute on function public.create_my_organization(text, uuid) to authenticated;");
    expect(code).not.toMatch(/grant [^;]* to anon/);
    for (const entry of contract.functions.filter((fn) => /open_signup|create_my_organization|organization_clears_signup_boundary|enforce_unverified_organization_boundary/.test(fn.sig))) {
      expect(entry.exec, entry.sig).not.toContain("anon");
    }
  });
});
