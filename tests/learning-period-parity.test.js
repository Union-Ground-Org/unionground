// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-ENGINE-20261103 (#6940): every write path on
// a table a learning_action_kinds row covers journals itself, and no client
// role keeps a direct write grant there. Passes with the engine's own kinds;
// fails on a fixture writer with no kinds row behind it.
import { describe, expect, it } from "vitest";
import { CASCADE_WRITES, OUTSIDE_UNDO_WRITERS, PENDING_DIRECT_GRANTS, learningDispatchIssues, learningKinds, learningParityIssues, repositoryLearningParityIssues } from "../scripts/lib/learning-period-parity.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const kinds = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('proof_item_edit', 'tasks', 'reverse', 'public.proof_items', false, 'private.learning_undo_proof_item', array['title', 'status'], 'Edits, it''s a fixture.'),
  ('proof_item_send', 'messages', 'permanent', 'public.proof_items', true, null, array[]::text[], 'Sent; it stays sent.');`;
const writer = (name, body) => `create function public.${name}(p_id text) returns void language plpgsql security definer set search_path = '' as $function$
begin
${body}
end;
$function$;`;

describe("learning period parity", () => {
  it("passes for the repository: the engine's own kinds cover no table yet", () => {
    expect(repositoryLearningParityIssues()).toEqual([]);
  });

  it("keeps system invitation expiry outside practice history while detecting an unregistered writer (#9273)", () => {
    const invitationKind = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
      ('invitation_send', 'membership', 'permanent', 'public.member_invitations', true, null, array[]::text[], 'Invitation sent.');`;
    const expiry = fnBody(loadMigrationSql("invitation_expiry_system_maintenance"), "private.expire_member_invitation_email");
    expect(learningParityIssues([invitationKind, expiry])).toEqual([]);
    const unregistered = expiry.replace("private.expire_member_invitation_email(", "private.unregistered_invitation_expiry(");
    expect(learningParityIssues([invitationKind, unregistered])).toEqual([
      "private.unregistered_invitation_expiry writes public.member_invitations without journalling a registered learning action",
    ]);
  });

  it("reads kinds rows, quoted text and arrays included", () => {
    expect(learningKinds([kinds])).toEqual([
      { actionKind: "proof_item_edit", targetTable: "public.proof_items", disposition: "reverse", handler: "private.learning_undo_proof_item" },
      { actionKind: "proof_item_send", targetTable: "public.proof_items", disposition: "permanent", handler: null },
    ]);
  });

  it("fails on a write RPC that does not journal, or journals a kind for another table", () => {
    const silent = writer("rename_proof_item", "  update public.proof_items set title = 'x' where id = p_id;");
    const wrongKind = writer("delete_proof_item", "  delete from public.proof_items where id = p_id;\n  perform private.learning_journal_append('other_kind', 'public.proof_items', p_id);");
    expect(learningParityIssues([kinds, silent, wrongKind])).toEqual([
      "public.delete_proof_item writes public.proof_items without journalling a registered learning action",
      "public.rename_proof_item writes public.proof_items without journalling a registered learning action",
    ]);
  });

  it("passes a writer that journals a registered kind, and ignores handlers and tables no kind covers", () => {
    const journalled = writer("rename_proof_item", "  update public.proof_items set title = 'x' where id = p_id;\n  perform private.learning_journal_append('proof_item_edit', 'public.proof_items', p_id, null, 'f', null, '{}'::jsonb);");
    const handler = `create function private.learning_undo_proof_item(p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin update public.proof_items set title = 'y'; return null; end;
$function$;`;
    const uncovered = writer("touch_other", "  update public.other_items set title = 'x';");
    expect(learningParityIssues([kinds, journalled, handler, uncovered])).toEqual([]);
  });

  it("uses the latest definition of a function", () => {
    const before = writer("rename_proof_item", "  update public.proof_items set title = 'x' where id = p_id;");
    const after = writer("rename_proof_item", "  perform 1;").replace("create function", "create or replace function");
    expect(learningParityIssues([kinds, before, after])).toEqual([]);
  });

  it("checks every overload: a later overload with other argument types hides no writer", () => {
    const silent = writer("proof_writer", "  update public.proof_items set title = 'x' where id = p_id;");
    const other = writer("proof_writer", "  perform 1;").replace("(p_id text)", "(p_id uuid, p_note text default 'a, b')");
    expect(learningParityIssues([kinds, silent, other])).toEqual([
      "public.proof_writer writes public.proof_items without journalling a registered learning action",
    ]);
    // The same input types under other names and an OUT argument are one function.
    const renamed = writer("proof_writer", "  perform 1;").replace("(p_id text)", "(p_other text, out p_done boolean)");
    expect(learningParityIssues([kinds, silent, renamed])).toEqual([]);
  });

  it("drops a function a later migration dropped, by name and argument count, in file order", () => {
    const silent = writer("rename_proof_item", "  update public.proof_items set title = 'x' where id = p_id;");
    expect(learningParityIssues([kinds, silent, "drop function if exists public.rename_proof_item(text);"])).toEqual([]);
    expect(learningParityIssues([kinds, silent, "drop function public.rename_proof_item;"])).toEqual([]);
    // Another overload's drop, a commented drop, and a drop followed by a new definition keep the writer.
    const issue = ["public.rename_proof_item writes public.proof_items without journalling a registered learning action"];
    expect(learningParityIssues([kinds, silent, "drop function public.rename_proof_item(text, text);"])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, "-- drop function public.rename_proof_item(text);"])).toEqual(issue);
    expect(learningParityIssues([kinds, `drop function public.rename_proof_item(text);\n${silent}`])).toEqual(issue);
  });

  it("does not take a drop inside a block comment or a quoted string for a real one (#7033 r1s4)", () => {
    const silent = writer("probe_writer", "  update public.proof_items set title = 'x' where id = p_id;").replace("(p_id text)", "(p_id uuid)");
    const issue = ["public.probe_writer writes public.proof_items without journalling a registered learning action"];
    expect(learningParityIssues([kinds, silent])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, "/* drop function public.probe_writer(uuid); */"])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, "/* outer /* nested */ drop function public.probe_writer(uuid); */"])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, "select 'drop function public.probe_writer(uuid);';"])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, "select E'it\\'s drop function public.probe_writer(uuid);';"])).toEqual(issue);
    // The executed drop after the text still counts.
    expect(learningParityIssues([kinds, silent, "select 'x'; drop function public.probe_writer(uuid);"])).toEqual([]);
  });

  it("drops only the overload whose argument types match (#7000 r1s8)", () => {
    const silent = writer("proof_writer", "  update public.proof_items set title = 'x' where id = p_id;");
    const inert = writer("proof_writer", "  perform 1;").replace("(p_id text)", "(p_id uuid)");
    const issue = ["public.proof_writer writes public.proof_items without journalling a registered learning action"];
    expect(learningParityIssues([kinds, silent, inert, "drop function public.proof_writer(uuid);"])).toEqual(issue);
    expect(learningParityIssues([kinds, silent, inert, "drop function public.proof_writer(p_id text);"])).toEqual([]);
    const stamped = writer("proof_writer", "  update public.proof_items set title = 'x' where id = p_id;").replace("(p_id text)", "(p_at timestamptz)");
    expect(learningParityIssues([kinds, stamped, "drop function public.proof_writer(timestamp with time zone);"])).toEqual([]);
  });

  it("reads type spellings as one overload, in creates as in drops (#6944)", () => {
    const silent = writer("proof_writer", "  update public.proof_items set title = 'x' where id = p_id;").replace("(p_id text)", "(p_id text, p_at timestamptz)");
    const respelled = writer("proof_writer", "  perform 1;").replace("create function", "create or replace function").replace("(p_id text)", "(p_id text, p_at timestamp with time zone default null::timestamp with time zone)");
    expect(learningParityIssues([kinds, silent, respelled])).toEqual([]);
    const dropped = "drop function public.proof_writer(text, timestamp with time zone);";
    expect(learningParityIssues([kinds, `${silent}\n${dropped}`])).toEqual([]);
    // A drop before a later create removes only the earlier one.
    expect(learningParityIssues([kinds, `${dropped}\n${silent}`])).toEqual([
      "public.proof_writer writes public.proof_items without journalling a registered learning action",
    ]);
  });

  it("finds a handler the latest dispatcher has no branch for (#6944)", () => {
    const dispatch = (branches) => `create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin
  case p_handler
${branches.map((name) => `    when '${name}' then return ${name}(p_mode, p_entry);`).join("\n")}
  end case;
end;
$function$;`;
    expect(learningDispatchIssues([kinds, dispatch(["private.learning_undo_proof_item"])])).toEqual([]);
    // A later slice re-emitting the dispatcher without an earlier branch.
    expect(learningDispatchIssues([kinds, dispatch(["private.learning_undo_proof_item"]), dispatch([])])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
  });

  it("follows a dispatcher moved aside and handed off to, and nothing else", () => {
    const dispatch = (branches, tail) => `create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin
  case p_handler
${branches.map((name) => `    when '${name}' then return ${name}(p_mode, p_entry);`).join("\n")}
    else ${tail}
  end case;
end;
$function$;`;
    const aside = "alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_proof;";
    const earlier = dispatch(["private.learning_undo_proof_item"], "raise exception 'unavailable';");
    const handOff = dispatch([], "return private.learning_dispatch_before_proof(p_handler, p_mode, p_entry);");
    expect(learningDispatchIssues([kinds, earlier, `${aside}\n${handOff}`])).toEqual([]);
    // Without the hand-off the moved branch is lost; a commented move moves nothing.
    expect(learningDispatchIssues([kinds, earlier, `${aside}\n${dispatch([], "raise exception 'unavailable';")}`])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
    expect(learningDispatchIssues([kinds, earlier, `-- ${aside}\n${handOff}`])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
  });

  it("counts the casework journal as journalling every kind its handler reverses (20261104123000)", () => {
    const casework = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('casework_reminders_change', 'cases', 'reverse', 'public.casework_reminders', false, 'private.learning_undo_casework', array[]::text[], 'Fixture.');`;
    const journalled = writer("save_reminder", "  insert into public.casework_reminders(title) values ('x');\n  perform private.learning_casework_journal('casework_reminder_create', null, true);");
    const silent = writer("save_reminder_silently", "  insert into public.casework_reminders(title) values ('x');");
    expect(learningParityIssues([casework, journalled, silent])).toEqual([
      "public.save_reminder_silently writes public.casework_reminders without journalling a registered learning action",
    ]);
  });

  it("does not count a journal call that is commented out", () => {
    const commented = writer("rename_proof_item", [
      "  update public.proof_items set title = 'x' where id = p_id;",
      "  -- perform private.learning_journal_append('proof_item_edit', 'public.proof_items', p_id);",
      "  /* perform private.learning_journal_append('proof_item_edit', 'public.proof_items', p_id); */",
    ].join("\n"));
    expect(learningParityIssues([kinds, commented])).toEqual([
      "public.rename_proof_item writes public.proof_items without journalling a registered learning action",
    ]);
  });

  it("fails on a direct client write grant left on a covered table", () => {
    expect(learningParityIssues([kinds], [
      { table: "public.proof_items", role: "authenticated", privileges: "SELECT,UPDATE" },
      { table: "public.proof_items", role: "service_role", privileges: "INSERT" },
      { table: "public.other_items", role: "authenticated", privileges: "INSERT" },
      { table: "public.proof_items", role: "authenticated", privilege: "UPDATE", columns: "title,status" },
      { table: "public.proof_items", role: "authenticated", privilege: "SELECT", columns: "title" },
      { table: "public.proof_items", role: "authenticated", privilege: "INSERT", columns: "" },
    ])).toEqual([
      "authenticated keeps a direct SELECT,UPDATE grant on public.proof_items",
      "authenticated keeps a direct UPDATE (title,status) grant on public.proof_items",
    ]);
  });

  // #6943 (20261104120000): case assignment and restriction are facets of the case row.
  it("credits a facet kind to its row's table, and never covers the row's table by itself", () => {
    const facetKinds = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('case_restriction', 'case_access', 'reverse', 'private.learning_case_restriction', false, 'private.learning_undo_case_restriction', array['is_restricted'], 'Facet.');`;
    const caseKinds = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('case_edit', 'cases', 'reverse', 'public.member_cases', false, 'private.learning_undo_case', array['title'], 'Row.');`;
    const restrict = writer("restrict_case", "  update public.member_cases set is_restricted = true where id = p_id;\n  perform private.learning_journal_append('case_restriction', 'private.learning_case_restriction', p_id, null, 'f', null, '{}'::jsonb);");
    const silent = writer("touch_case", "  update public.member_cases set title = 'x' where id = p_id;");
    // The facet alone leaves public.member_cases uncovered.
    expect(learningParityIssues([facetKinds, restrict, silent])).toEqual([]);
    // Once the row's table is covered, the facet writer counts as journalled and the silent one does not.
    expect(learningParityIssues([facetKinds, caseKinds, restrict, silent])).toEqual([
      "public.touch_case writes public.member_cases without journalling a registered learning action",
    ]);
  });

  it("fails when the latest undo dispatch drops a reversing kind's handler", () => {
    const dispatch = (branches) => `create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin
  case p_handler
${branches.map((name) => `    when '${name}' then return ${name}(p_mode, p_entry);`).join("\n")}
    else raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
  end case;
end;
$function$;`;
    expect(learningDispatchIssues([kinds, dispatch(["private.learning_undo_proof_item"])])).toEqual([]);
    expect(learningDispatchIssues([kinds, dispatch(["private.learning_undo_proof_item"]), dispatch(["private.learning_undo_other"])])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
  });

  it("follows a hand-off to the dispatcher a slice found installed (20261104111500 design)", () => {
    const handOff = (suffix, branches) => `alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_${suffix};
create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin
  case p_handler
${branches.map((name) => `    when '${name}' then return ${name}(p_mode, p_entry);`).join("\n")}
    else return private.learning_dispatch_${suffix}(p_handler, p_mode, p_entry);
  end case;
end;
$function$;`;
    const fixed = (branches) => `create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb language plpgsql as $function$
begin
  case p_handler
${branches.map((name) => `    when '${name}' then return ${name}(p_mode, p_entry);`).join("\n")}
  end case;
end;
$function$;`;
    // Two hand-offs in a row keep the first fixed list reachable.
    expect(learningDispatchIssues([kinds, fixed(["private.learning_undo_proof_item"]), handOff("before_messages", ["private.learning_undo_message"]),
      handOff("before_case_access", ["private.learning_undo_case_access"])])).toEqual([]);
    // A later fixed list that leaves the hand-off out drops what it delegated to.
    expect(learningDispatchIssues([kinds, fixed(["private.learning_undo_proof_item"]), handOff("before_messages", ["private.learning_undo_message"]),
      fixed(["private.learning_undo_message"])])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
    // A hand-off in a comment or a string moves nothing.
    expect(learningDispatchIssues([kinds, fixed(["private.learning_undo_proof_item"]),
      "-- alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_gone;",
      fixed(["private.learning_undo_other"])])).toEqual([
      "private.learning_dispatch has no branch for private.learning_undo_proof_item",
    ]);
  });

  // #6946: a cascade write is excused only for the table it names, and the
  // one pending direct grant only as the authenticated column UPDATE it is.
  it("excuses a cascade only on its own table and the pending grant only as an authenticated UPDATE", () => {
    const covered = (table) => `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('proof_${table.split(".")[1]}_edit', 'settings', 'reverse', '${table}', false, 'private.learning_undo_proof', array['title'], 'Fixture.');`;
    const [cascade] = Object.keys(CASCADE_WRITES).filter((key) => key.endsWith(" public.member_profiles"));
    const [fn] = cascade.split(" ");
    const cascading = `create or replace function ${fn}(p_id text) returns void language plpgsql security definer set search_path = '' as $function$
begin
  update public.member_profiles set chapter_id = null where id = p_id::uuid;
  update public.member_profile_details set phone = null where user_id = p_id::uuid;
end;
$function$;`;
    expect(learningParityIssues([covered("public.member_profiles"), covered("public.member_profile_details"), cascading])).toEqual([
      `${fn} writes public.member_profile_details without journalling a registered learning action`,
    ]);
    expect(Object.keys(PENDING_DIRECT_GRANTS)).toEqual(["public.member_profiles"]);
    expect(learningParityIssues([covered("public.member_profiles")], [
      { table: "public.member_profiles", role: "authenticated", privilege: "UPDATE", columns: "language" },
      { table: "public.member_profiles", role: "authenticated", privilege: "INSERT", columns: "language" },
      { table: "public.member_profiles", role: "anon", privilege: "UPDATE", columns: "language" },
    ])).toEqual([
      "anon keeps a direct UPDATE (language) grant on public.member_profiles",
      "authenticated keeps a direct INSERT (language) grant on public.member_profiles",
    ]);
    for (const reason of [...Object.values(OUTSIDE_UNDO_WRITERS), ...Object.values(CASCADE_WRITES)]) expect(reason.length).toBeGreaterThan(20);
  });

  it("counts a delivery table's trigger for the operations it fires on, and nothing more", () => {
    const sent = `insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('proof_sent', 'messages', 'permanent', 'public.proof_sends', true, null, array[]::text[], 'Sent.');`;
    const trigger = "create trigger z90_learning_journal_sent after insert on public.proof_sends\nfor each row execute function private.learning_journal_sent();";
    const inserter = writer("send_proof", "  insert into public.proof_sends(id) values (p_id);");
    const updater = writer("touch_proof", "  update public.proof_sends set id = p_id;");
    const tables = { "public.proof_sends": { ops: ["insert"], grants: { "UPDATE (read_at)": "A receipt." } } };
    expect(learningParityIssues([sent, trigger, inserter, updater], [
      { table: "public.proof_sends", role: "authenticated", privilege: "INSERT", columns: "id" },
      { table: "public.proof_sends", role: "authenticated", privilege: "UPDATE", columns: "read_at" },
      { table: "public.proof_sends", role: "authenticated", privileges: "SELECT,DELETE" },
    ], { triggerTables: tables, sideWrites: {} })).toEqual([
      "authenticated keeps a direct SELECT,DELETE grant on public.proof_sends",
      "public.touch_proof writes public.proof_sends without journalling a registered learning action",
    ]);
    // Listed without its trigger: every writer is uncovered and the gap is named.
    expect(learningParityIssues([sent, inserter], [], { triggerTables: tables, sideWrites: {} })).toEqual([
      "public.proof_sends is listed as journalled by private.learning_journal_sent on insert but its trigger covers nothing",
      "public.send_proof writes public.proof_sends without journalling a registered learning action",
    ]);
    // A named side write with its reason passes.
    expect(learningParityIssues([sent, trigger, updater], [], { triggerTables: tables, sideWrites: { "public.touch_proof|public.proof_sends": "Bookkeeping." } })).toEqual([]);
  });

  it("treats two spellings of one argument type as one function", () => {
    const silent = writer("proof_when", "  update public.proof_items set title = 'x' where id = p_id;").replace("(p_id text)", "(p_id text, p_at timestamptz)");
    const journalled = writer("proof_when", "  update public.proof_items set title = 'x' where id = p_id;\n  perform private.learning_journal_append('proof_item_edit', 'public.proof_items', p_id, null, 'f', null, '{}'::jsonb);")
      .replace("(p_id text)", "(p_id text, p_at timestamp with time zone)").replace("create function", "create or replace function");
    expect(learningParityIssues([kinds, silent, journalled])).toEqual([]);
  });
});
