// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";

const directories = [];
const originalBody = " begin perform 1; end; ";
const declaration = (body = originalBody) => `create function public.fixture_target() returns void language plpgsql as $body$${body}$body$;\n`;
const inertDrops = [
  ["block comment", "/* Historical rollback example.\ndrop function public.fixture_target();\n*/\nselect 1;"],
  ["nested block comment", "/* Outer /* nested */\ndrop function public.fixture_target();\n*/\nselect 1;"],
  ["line comment", "-- drop function public.fixture_target();\nselect 1;"],
  ["quoted text", "select 'Example\ndrop function public.fixture_target();\n';"],
  ["doubled string quotes", "select 'An example: ''quoted''\ndrop function public.fixture_target();\n';"],
  ["escaped string", "select E'escaped \\' quote\ndrop function public.fixture_target();\n';"],
  ["quoted identifier", "select 1 as \"Example\ndrop function public.fixture_target();\n\";"],
  ["doubled identifier quotes", "select 1 as \"Example \"\"identifier\"\"\ndrop function public.fixture_target();\n\";"],
  ["dollar-quoted text", "select $example$\ndrop function public.fixture_target();\n$example$;"],
  ["untagged dollar quote", "select $$\ndrop function public.fixture_target();\n$$;"],
  ["non-ASCII dollar tag", "select $ejemplo_ñ$\ndrop function public.fixture_target();\n$ejemplo_ñ$;"],
];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inventory(...files) {
  const directory = mkdtempSync(join(tmpdir(), "function-inventory-parser-"));
  directories.push(directory);
  files.forEach((sql, index) => writeFileSync(join(directory, `${index + 1}.sql`), sql));
  return readMigrationFunctions(directory);
}

describe("function inventory DROP parsing", () => {
  it.each(inertDrops)("keeps an installed function when its DROP appears in a %s", (_name, sql) => {
    const functions = inventory(declaration(), sql);

    expect(functions.map(fn => fn.name)).toEqual(["public.fixture_target"]);
    expect(functions[0].source).toBe(originalBody);
    expect(functions[0].sourceSha256).toBe(createHash("sha256").update(originalBody).digest("hex"));
    expect(functions[0].offset).toBe(0);
  });

  it.each(inertDrops)("still detects a real DROP after a %s", (_name, sql) => {
    expect(inventory(declaration(), sql + "\ndrop function public.fixture_target();\n")).toHaveLength(0);
  });

  it.each(["\n", "\r", "\r\n"])("detects a real DROP after a line comment ending in %j", (newline) => {
    const sql = `-- Historical rollback follows${newline}drop function public.fixture_target();${newline}`;
    expect(inventory(declaration(), sql)).toHaveLength(0);
  });

  it("does not treat dollar tags inside unquoted identifiers as quotes", () => {
    expect(inventory(declaration(), "select 1 as fixture$tag$;\nselect 1 as ejemplo_ñ$tag$;\ndrop function public.fixture_target();\n")).toHaveLength(0);
  });

  it.each(["/* unclosed", "select 'unclosed", "select $example$unclosed"])("refuses unterminated SQL instead of trusting a partial scan: %s", (sql) => {
    expect(() => inventory(declaration(), sql)).toThrow(/Unterminated SQL/);
  });

  it("does not execute a DROP mentioned inside another function body", () => {
    const body = " select $example$\ndrop function public.fixture_target();\n$example$; ";
    const functions = inventory(declaration(), `create function public.example_text() returns text language sql as $outer$${body}$outer$;`);

    expect(functions.map(fn => fn.name)).toEqual(["public.fixture_target", "public.example_text"]);
    expect(functions.find(fn => fn.name === "public.example_text").source).toBe(body);
    expect(functions.historical.map(fn => fn.name)).toEqual(["public.fixture_target", "public.example_text"]);
  });

  it.each([
    "do $$begin\n drop function public.fixture_target();\nend;$$;",
    "/* heading */ do language plpgsql $block$begin\n drop /* retirement */ function public.fixture_target();\nend;$block$;",
    "do 'begin drop function public.fixture_target(); end;';",
    "do E'begin drop function public.fixture_target(); end;';",
    'select 1; do language "plpgsql" $$begin drop function public.fixture_target(); end;$$;',
    "do $jobs$begin\nexecute $ddl$\ndrop function public.fixture_target();\n$ddl$;\nend;$jobs$;",
    "do $jobs$begin\nexecute format($ddl$drop function public.fixture_target();$ddl$);\nend;$jobs$;",
  ])("refuses executable DO function drops instead of reporting a stale inventory: %s", (sql) => {
    expect(() => inventory(declaration(), sql)).toThrow(/Unsupported.*DO.*(?:DROP|function DDL)/i);
  });

  it("keeps DO examples in comments and strings inert", () => {
    const sql = "do $$begin\n-- drop function public.fixture_target();\nperform 'drop function public.fixture_target();';\nend;$$;";
    expect(inventory(declaration(), sql)).toHaveLength(1);
  });

  it.each([
    "declare ddl text := $ddl$\ndrop function public.fixture_target();\n$ddl$; begin execute ddl;",
    "declare ddl text := 'drop function public.fixture_target()'; begin execute ddl;",
    "declare ddl text := 'drop /* retirement */ function public.fixture_target()'; begin execute ddl;",
    "declare ddl text; begin ddl := 'drop function public.fixture_target()'; execute ddl;",
    "declare ddl text; begin select 'drop function public.fixture_target()' into ddl; execute ddl;",
    "declare ddl text := 'drop function public.fixture_target()'; alias text; begin alias := ddl; execute alias;",
    "declare format text := 'drop function public.fixture_target()'; begin execute format;",
    "declare e text := 'drop function public.fixture_target()'; begin execute e;",
    "declare u text := 'drop function public.fixture_target()'; begin execute u;",
    "declare pg_catalog text := 'drop function public.fixture_target()'; begin execute pg_catalog;",
    "declare ddl text := 'drop function public.fixture_target()'; begin execute '' || ddl;",
    "declare ddl text := $ddl$\ncreate function public.fixture_created() returns void language sql as $body$select 1$body$;\n$ddl$; begin execute ddl;",
  ])("refuses indirect executable function DDL instead of silently trusting it: %s", (body) => {
    expect(() => inventory(declaration(), `do $jobs$${body} end;$jobs$;`)).toThrow(/Unsupported.*DO\/EXECUTE.*function DDL/);
  });

  it.each([
    "begin execute 'select $1' using 'O''Reilly';",
    "begin execute 'select $1' using 'drop function public.fixture_target()';",
    "begin execute 'select $1' into strict n using concat('x', 'y');",
    "declare r record; begin for r in execute 'select 1' loop end loop;",
  ])("keeps EXECUTE data arguments inert: %s", (body) => {
    expect(inventory(declaration(), `do $jobs$${body} end;$jobs$;`)).toHaveLength(1);
  });

  it.each([
    ["assigned concatenation", "declare ddl text := 'drop ' || 'function public.fixture_target()'; begin execute ddl;"],
    ["direct concatenation", "begin execute 'drop ' || 'function public.fixture_target()';"],
    ["concat call", "begin execute concat('drop ', 'function public.fixture_target()');"],
    ["split keyword fragments", "begin execute concat('dr', 'op ', 'fun', 'ction public.fixture_target()');"],
    ["format substitution", "begin execute format('%s function public.fixture_target()', 'drop');"],
    ["two format substitutions", "begin execute format('%s %s public.fixture_target()', 'drop', 'function');"],
    ["partial format keyword", "begin execute format('dr%s function public.fixture_target()', 'op');"],
    ["partial format function keyword", "begin execute format('dr%s fun%s public.fixture_target()', 'op', 'ction');"],
    ["format second statement", "begin execute format('select 1; dr%s function public.fixture_target()', 'op');"],
    ["newline-adjacent strings", "begin execute 'drop '\n'function public.fixture_target()';"],
    ["split CREATE", "begin execute 'create ' || 'function public.fixture_created() returns void language sql as $$select 1$$';"],
    ["format suffix", "begin execute format('') || $ddl$\ndrop function public.fixture_target();\n$ddl$;"],
    ["USING copied into variable", "declare ddl text; begin execute 'select $1::text' into ddl using 'drop function public.fixture_target()'; execute ddl;"],
    ["nested command string copied into variable", "declare ddl text; begin execute 'select ''drop function public.fixture_target()''' into ddl; execute ddl;"],
    ["nested comment-separated DDL copied into variable", "declare ddl text; begin execute 'select ''drop /* retirement */ function public.fixture_target()''' into ddl; execute ddl;"],
    ["format data copied into variable", "declare ddl text; begin execute format('select %L', 'drop function public.fixture_target()') into ddl; execute ddl;"],
    ["split keyword with the first literal outside the join", "begin execute 'drop funct' || 'ion public.fixture_target()';"],
    ["format %I keyword", "begin execute format('drop %I public.fixture_target()', 'function');"],
    ["format positional %I keyword", "begin execute format('drop %1$I public.fixture_target()', 'function');"],
    ["format %s on a fixed command", "begin execute format('revoke all on function %s from public', 'public.fixture_target()');"],
    ["non-DDL variable", "declare query text := 'select 1'; begin execute query;"],
    ["format call result variable", "declare query text := format('select %L', 1); begin execute query;"],
    ["comment before the command", "begin execute /* ddl */ 'select 1';"],
    ["concatenated format template", "begin execute format('drop funct' || 'ion public.fixture_target()');"],
    ["adjacent format template literals", "begin execute format('drop funct'\n'ion public.fixture_target()');"],
    ["format %L DO body", "begin execute format('do %L', 'begin execute ''drop function public.fixture_target()''; end;');"],
    ["format %L function body", "begin execute format('create function public.fixture_created() returns void language sql as %L', 'select 1');"],
    ["format %L second statement", "begin execute format('select 1; do %L', 'begin perform 1; end;');"],
    ["format %L closing a template quote", "begin execute format('select ''%L''', ';drop function public.fixture_target();--');"],
    ["format %L data", "begin execute format('select %L', 'O''Reilly');"],
    ["format %L into", "begin execute pg_catalog.format('select %L', concat('x', 'y')) into strict n;"],
    ["GRANT label before an assembled command", "begin if exists (select 1 as grant) then execute 'drop funct' || 'ion public.fixture_target()'; end if;"],
    ["REVOKE label before an assembled command", "begin perform 1 as revoke; execute 'drop funct' || 'ion public.fixture_target()';"],
    ["a variable named on$cmd", "declare on$cmd text := 'drop funct' || 'ion public.fixture_target()'; begin execute on$cmd;"],
    ["a variable named oné", "declare oné text := 'drop funct' || 'ion public.fixture_target()'; begin execute oné;"],
    ["a variable named on", "declare on text := 'drop funct' || 'ion public.fixture_target()'; begin execute on;"],
    ["an identifier after a non-ASCII space", "declare \u2003on text := 'drop funct' || 'ion public.fixture_target()'; begin execute \u2003on;"],
    ["an identifier after a no-break space", "declare \u00a0on text := 'drop funct' || 'ion public.fixture_target()'; begin execute \u00a0on;"],
    ["a variable named function before OPERATOR()", "declare function text := 'drop funct'; begin execute function operator(pg_catalog.||) 'ion public.fixture_target()';"],
    ["a variable named procedure before OPERATOR()", "declare procedure text := 'drop funct'; begin execute procedure operator(pg_catalog.||) 'ion public.fixture_target()';"],
    ["a variable named function before ||", "declare function text := 'drop funct'; begin execute function || 'ion public.fixture_target()';"],
    ["a variable named on before OPERATOR()", "declare on text := 'drop funct'; begin execute on operator(pg_catalog.||) 'ion public.fixture_target()';"],
    ["a variable named x before OPERATOR()", "declare x text := 'drop funct'; begin execute x operator(pg_catalog.||) 'ion public.fixture_target()';"],
    ["format DO template hiding a nested %%I", "begin execute format('do $b$ begin execute format(''drop %%I public.fixture_target()'', ''function''); end $b$');"],
    ["format DO template without placeholders", "begin execute format('do $b$ begin perform 1; end $b$');"],
    // #5710 6332873056/6334778667: comments after EXECUTE, and CREATE TRIGGER text
    // that is not the statement itself, still prove nothing.
    ["a comment before a variable named function", "declare function text := 'drop funct'; begin execute /* trigger */ function operator(pg_catalog.||) 'ion public.fixture_target()';"],
    ["a CREATE TRIGGER alias before a dynamic EXECUTE", "declare function text := 'drop funct'; begin if exists (select 1 as create, 2 as trigger) then execute function operator(pg_catalog.||) 'ion public.fixture_target()'; end if;"],
    ["CREATE TRIGGER words inside an IF condition", "declare function text := 'drop funct'; begin if exists (select create trigger from t) then execute function operator(pg_catalog.||) 'ion public.fixture_target()'; end if;"],
    ["a comment before a variable named on", "declare on text := 'drop funct'; begin execute -- grant\n on operator(pg_catalog.||) 'ion public.fixture_target()';"],
  ])("refuses unsupported executable function DDL from %s", (_name, body) => {
    expect(() => inventory(declaration(), `do $jobs$${body} end;$jobs$;`)).toThrow(/Unsupported.*(?:DO|EXECUTE).*function (?:DDL|DROP)/i);
  });

  it.each([
    "grant execute on function public.fixture_target() to authenticated;",
    "revoke execute on function public.fixture_target() from authenticated;",
    "create trigger t before insert on public.foo for each row execute function private.touch_updated_at();",
    "create trigger t before insert on public.foo for each row execute procedure private.touch_updated_at();",
    "create event trigger fixture_event on ddl_command_end execute function private.fixture_event_trigger();",
    "grant execute on all functions in schema private to service_role;",
    "alter default privileges in schema private revoke execute on functions from public;",
    // #5710 6332873056: comments after EXECUTE, spaced and quoted routine names.
    "grant execute /* routines */ on function public.fixture_target() to authenticated;",
    "revoke execute -- routines\n on function public.fixture_target() from authenticated;",
    "create trigger t before insert on public.foo for each row execute /* clause */ function private.touch_updated_at();",
    "create trigger t before insert on public.foo for each row execute function private . touch_updated_at();",
    "create trigger t before insert on public.foo for each row execute function private.\"touch-updated\"();",
    // #5710 6334778667: a statement-level trigger with FOR EACH omitted.
    "create trigger t after insert on public.foo execute function private.touch_updated_at();",
    "create or replace trigger t after insert on public.foo referencing new table as inserted execute function private.touch_updated_at();",
  ])("keeps non-dynamic EXECUTE syntax and an inert notice separate: %s", (statement) => {
    const body = `${statement} raise notice 'rollback: drop function public.fixture_target()';`;
    expect(inventory(declaration(), `do $$begin ${body} end;$$;`)).toHaveLength(1);
  });

  it.each([
    ["IF", "if exists (select 1) then", "end if;"],
    ["ELSIF", "if false then perform 1; elsif true then", "end if;"],
    ["WHILE", "while false loop", "end loop;"],
    ["FOR query", "for r in select 1 loop", "end loop;"],
    ["FOR range", "for n in 1..1 loop", "end loop;"],
    ["FOREACH", "foreach n in array array[1] loop", "end loop;"],
    ["exception", "perform 1; exception when others then", ""],
    ["nested headers", "if true then while false loop", "end loop; end if;"],
    ["CASE condition", "if case when true then true else false end then", "end if;"],
    ["comments and quoted keywords", "if 'THEN LOOP' <> '' /* THEN */ then", "end if;"],
  ])("keeps a static trigger EXECUTE after a %s control header", (_name, header, closing) => {
    const trigger = "create trigger t after insert on public.foo execute function private.touch_updated_at();";
    const sql = `do $jobs$begin ${header} ${trigger} ${closing} end;$jobs$;`;
    expect(inventory(declaration(), sql)).toHaveLength(1);
    // A later dynamic command is still a different statement, never part of
    // the trigger clause whose EXECUTE was just admitted.
    const unsafe = sql.replace(trigger, `${trigger} execute query;`);
    expect(() => inventory(declaration(), unsafe)).toThrow(/Unsupported.*DO\/EXECUTE/);
  });

  it.each([
    ["IF", "if exists (select create trigger from t) then", "end if;"],
    ["WHILE", "while exists (select create trigger from t) loop", "end loop;"],
    ["FOR", "for r in select create trigger from t loop", "end loop;"],
    ["CASE condition", "if case when true then exists (select create trigger from t) else false end then", "end if;"],
  ])("refuses a dynamic EXECUTE after a %s header containing trigger-word decoys", (_name, header, closing) => {
    const sql = `do $jobs$declare function text := 'drop funct'; begin ${header}
      execute function operator(pg_catalog.||) 'ion public.fixture_target()'; ${closing} end;$jobs$;`;
    expect(() => inventory(declaration(), sql)).toThrow(/Unsupported.*DO\/EXECUTE/);
  });

  // #5710 6332873056: a literal after LANGUAGE names the language, not the code.
  it("reads DO LANGUAGE 'plpgsql' before the code as one DO body", () => {
    expect(inventory(declaration(), "do language 'plpgsql' $$begin perform 1; end;$$;")).toHaveLength(1);
    expect(inventory(declaration(), "do $$begin perform 1; end;$$ language 'plpgsql';")).toHaveLength(1);
    expect(() => inventory(declaration(), "do language 'plpgsql' $$begin drop function public.fixture_target(); end;$$;"))
      .toThrow(/Unsupported executable DO function DROP/);
    expect(() => inventory(declaration(), "do language 'plpgsql' $$begin execute 'drop funct' || 'ion public.fixture_target()'; end;$$;"))
      .toThrow(/Unsupported.*(?:DO|EXECUTE).*function (?:DDL|DROP)/i);
    expect(() => inventory(declaration(), "do 'begin perform 1; end;' 'begin drop function public.fixture_target(); end;';"))
      .toThrow(/Unsupported split DO body/);
    // #5823 round 1: LANGUAGE is not reserved, so a language named
    // language is the argument and the literal after it is still the code.
    for (const sql of [
      "do language language $$begin drop function public.fixture_target(); end;$$;",
      "do language language 'begin drop function public.fixture_target(); end;';",
      "do language \"language\" $$begin drop function public.fixture_target(); end;$$;",
      "do language /* name */ language $$begin drop function public.fixture_target(); end;$$;",
    ]) expect(() => inventory(declaration(), sql), sql).toThrow(/Unsupported executable DO function DROP/);
  });

  it.each([
    "do U&'begin drop\\0020function public.fixture_target(); end;';",
    "do $$begin execute U&'drop\\0020function public.fixture_target()'; end;$$;",
  ])("refuses encoded executable literals instead of missing decoded function DDL: %s", (sql) => {
    expect(() => inventory(declaration(), sql)).toThrow(/Unsupported.*encoded.*DO\/EXECUTE/i);
  });

  it("inventories every pinned historical dynamic EXECUTE block and refuses the same block once edited", () => {
    const name = "20260724030000_mfa_assurance_boundary.sql";
    const sql = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
    expect(() => inventory(sql)).not.toThrow();
    const edited = sql.replace("execute format('drop policy if exists mfa_assurance on %s', r.tbl);",
      "execute format('drop policy if exists mfa_assurance  on %s', r.tbl);");
    expect(edited).not.toBe(sql);
    expect(() => inventory(edited)).toThrow(/Unsupported non-literal DO\/EXECUTE command/);
    const review = JSON.parse(readFileSync(new URL("../scripts/account-case-graph-dynamic-execute-review.json", import.meta.url), "utf8"));
    expect(review.blocks.length).toBeGreaterThan(0);
    expect(new Set(review.blocks.map(block => block.body_sha256)).size).toBe(review.blocks.length);
    for (const block of review.blocks) {
      expect(block.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() => readFileSync(new URL(`../supabase/migrations/${block.file}`, import.meta.url))).not.toThrow();
    }
  });

  it.each([
    "do '\nbegin\n  execute ''drop funct''\n'\n'\n''ion public.fixture_target()'';\nend\n';",
    "do $a$begin execute 'drop funct'$a$\n$b$ || 'ion public.fixture_target()'; end$b$;",
    "do 'begin drop funct'\n-- joined across a comment line\n'ion public.fixture_target(); end';",
    "do $a$begin drop funct$a$ /* a /* nested */ note */\n$b$ion public.fixture_target(); end$b$;",
  ])("refuses a DO body split into adjacent literals: %j", (sql) => {
    expect(() => inventory(declaration(), sql)).toThrow(/Unsupported (?:split DO body|non-literal DO\/EXECUTE)/);
  });

  it("does not install a commented definition and rollback", () => {
    const sql = `/* Example only\n${declaration()}drop function public.fixture_target();\n*/`;
    expect(inventory(sql)).toHaveLength(0);
    const existing = inventory(declaration(), sql);
    expect(existing).toHaveLength(1);
    expect(existing.historical).toHaveLength(1);
  });

  it("still finds definitions inside executable dollar-quoted DO and EXECUTE blocks", () => {
    const sql = `do $jobs$begin\nexecute $ddl$\n${declaration()}$ddl$;\nend;$jobs$;`;
    const functions = inventory(sql);
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({ name: "public.fixture_target", source: originalBody, offset: sql.indexOf("create") });
  });

  it("refuses unsupported quoted executable declarations instead of hiding an installed function", () => {
    expect(() => inventory(`do 'begin\n${declaration()}end;';`)).toThrow(/Unsupported quoted executable function declaration/);
  });

  it("does not count signature comments as a dropped argument", () => {
    const overload = "create function public.fixture_target(value integer) returns void language plpgsql as $$ begin return; end; $$;\n";
    const sql = "drop /* retirement */ function public.fixture_target(/* no arguments */);";
    expect(inventory(declaration() + overload, sql).map(fn => fn.arity)).toEqual([1]);
  });

  it("counts quoted type names as arguments", () => {
    const overload = "create function public.fixture_target(value integer) returns void language plpgsql as $$ begin return; end; $$;\n";
    expect(inventory(declaration() + overload, 'drop /* retirement */ function public.fixture_target("pg_catalog"."int4");').map(fn => fn.arity)).toEqual([0]);
  });

  it("still removes a real top-level DROP and restores a later re-creation", () => {
    const drop = "/* heading */\ndrop function if exists public.fixture_target();\n";
    const removed = inventory(declaration(), drop);
    expect(removed).toHaveLength(0);
    expect(removed.historical).toHaveLength(1);

    const revisedBody = " begin perform 2; end; ";
    const restored = inventory(declaration(), drop, declaration(revisedBody));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ name: "public.fixture_target", source: revisedBody, file: "3.sql", offset: 0 });
    expect(restored.historical).toHaveLength(2);
  });

  it("retains original offsets when comments precede a real DROP and re-creation in one file", () => {
    const prefix = "/* a long comment which is not executable */\ndrop function public.fixture_target();\n";
    const functions = inventory(declaration(), prefix + declaration());

    expect(functions).toHaveLength(1);
    expect(functions[0].file).toBe("2.sql");
    expect(functions[0].offset).toBe(prefix.length);
  });
});
