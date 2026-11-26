import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles } from "./helpers/migration.js";

const migration = readFileSync("supabase/migrations/20260830170000_administrative_evidence_workflows.sql", "utf8");
// REQ-UG-POMS-FUNCTION-REMOVAL-20261003: the owner removed the POMS part of
// the evidence workspace; Field Notes and Action Lab stay.
const removal = readFileSync("supabase/migrations/20261003070000_poms_function_removal.sql", "utf8");
const api = readFileSync("src/lib/memberApi.js", "utf8");
const panel = readFileSync("src/components/AdministrativeEvidencePanel.jsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));

function latestBody(name) {
  const latest = migrationFiles()
    .filter(({ sql }) => sql.toLowerCase().includes(`function ${name}(`))
    .at(-1);
  return { file: latest.name ?? latest.file, body: fnBody(latest.sql, name) };
}

describe("administrative evidence workflows", () => {
  it("keeps the Admin evidence desk set-wise at SAMPLE scale", () => {
    const { body: deskFunction } = latestBody("public.get_administrative_evidence_desk");

    expect(deskFunction).not.toContain("private.casework_staff_can_access(cs.id)");
    expect(deskFunction).toContain("cs.organization_id=caller_org");

    const contractEntry = contract.functions.find(
      ({ sig }) => sig === "public.get_administrative_evidence_desk(p_page integer, p_query text)",
    );
    expect(contractEntry?.bodyContains).toContain("cs.organization_id=caller_org");
    expect(contractEntry?.bodyForbids).toContain("private.casework_staff_can_access(cs.id)");
  });

  it("keeps every remaining record organization-scoped and every write behind a staff RPC", () => {
    for (const table of [
      "organization_field_note_sources", "organization_field_note_blocks", "organization_field_note_packets", "organization_object_action_runs",
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`create policy mfa_assurance on public.${table}`);
    }
    expect(migration).toContain("private.current_member_organization()");
    expect(migration).toContain("private.has_organization_role");
    expect(migration).toContain("foreign key (organization_id, source_id) references public.organization_field_note_sources(organization_id, id)");
    expect(migration).toContain("organization_object_action_runs_action check");
    expect(migration).not.toMatch(/to_jsonb\((?:s|b|p|organization_field_note_blocks|organization_field_note_packets)\)/);
    expect(migration).not.toMatch(/insert into public\.organizations|insert into auth\.users/i);
  });

  // Since 20261003070000 this proves the Field Notes and Action Lab half; the POMS half
  // was removed by owner decision and is proved gone in the next case.
  it("ships POMS, Field Notes, and Action Lab readers and mutations end to end", () => {
    for (const rpc of ["get_administrative_evidence_desk", "add_field_note_evidence", "draft_field_note_packet", "execute_administrative_object_action"]) {
      expect(migration).toContain(`function public.${rpc}`);
      expect(api).toContain(`"${rpc}"`);
    }
    expect(panel).toContain("Field Notes");
    expect(panel).toContain("Action Lab");
    expect(panel).not.toMatch(/poms|ingest/i);
    expect(api).toContain('rpc("get_administrative_evidence_desk", { p_page: page })');
    expect(contract.functions).toContainEqual(expect.objectContaining({
      sig: "private.require_administrative_evidence_staff()",
      secdef: true,
      exec: "",
    }));
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.require_administrative_evidence_staff()",
    );
    expect(contract.functions.find(({ sig }) => sig === "public.draft_field_note_packet(p_issue_key text, p_title text)")?.bodyContains)
      .toContain("b.packet_state='included'");
    expect(migration).toContain("packet exceeds 50000 characters");
    expect(migration).toContain("Source type: ' || s.source_type");
    expect(migration).toContain("Provenance: ' || s.provenance");
    expect(migration).toContain("packet is already review ready");

    const { body: desk } = latestBody("public.get_administrative_evidence_desk");
    expect(desk).toContain("invalid evidence page");
    expect(desk).toContain("evidence search is too long");
    expect(desk).toContain("limit 25 offset page_offset");
    expect(desk).toContain("'previousState', r.previous_state");
    expect(desk).toContain("'actorLabel', coalesce");
    expect(desk).toContain("'Deleted user'");
    expect(desk).toContain("task.deleted_at is null");
    expect(desk).toContain("membership.status='active'");
    expect(desk).toContain("caller_profile.chapter_id=task.chapter_id");
    for (const targetTable of ["organization_field_note_blocks", "organization_field_note_packets"]) {
      expect(desk).toMatch(new RegExp(`'actions', greatest\\([\\s\\S]*count\\(\\*\\) from public\\.${targetTable}`));
    }
    for (const action of ["case_record_review", "task_record_review", "member_record_review"]) expect(desk).toContain(action);

    const { body: action } = latestBody("public.execute_administrative_object_action");
    expect(action).toMatch(/^\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/m);
    expect(action).toContain("evidence is already in the requested packet state");
    expect(action).toContain("'Member ' || pg_catalog.substr(profile.id::text,1,8)");
    expect(action).toContain("private.casework_staff_can_access(cs.id)");
    expect(action).toContain("unsupported object action");
  });

  it("removes the POMS tables, RPCs, history rows and library category in one forward migration", () => {
    expect(removal.trimStart().startsWith("--")).toBe(true);
    expect(removal).toMatch(/^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';$/m);
    expect(removal.trimEnd().endsWith("commit;")).toBe(true);
    const code = removal.replace(/^\s*--.*$/gm, "");
    for (const statement of [
      "drop table public.organization_poms_evidence;",
      "drop table public.organization_poms_ingest_chunks;",
      "drop table public.organization_poms_sources;",
      "delete from public.organization_object_action_runs where target_kind = 'poms_source';",
      "update public.chapter_documents set document_type = 'other' where document_type = 'poms';",
      "check (document_type in ('contract', 'policy', 'minutes', 'training', 'template', 'other'))",
      "check (target_kind in ('field_note_block', 'field_note_packet', 'member_case', 'chapter_task', 'member_profile'))",
    ]) expect(code).toContain(statement);
    // Precise: only POMS rows are deleted; every other delete targets the
    // withdrawn POMS registry rows.
    const deletes = [...code.matchAll(/^delete from ([\w.]+)/gm)].map((match) => match[1]);
    expect(deletes).toEqual([
      "private.demo_seed_page_evidence", "private.demo_seed_page_contract", "public.organization_object_action_runs",
      "private.account_lifecycle_manifest", "private.account_lifecycle_transitive_fk_manifest", "private.account_lifecycle_trigger_review",
    ]);
    for (const routine of ["public.get_administrative_evidence_desk", "public.execute_administrative_object_action",
      "private.demo_seed_sync_administrative_evidence", "private.demo_seed_remove_administrative_evidence",
      "private.demo_seed_apply_administrative_evidence", "private.demo_seed_refresh_administrative_page_evidence",
      "public.update_chapter_document_content"]) {
      expect(fnBody(removal, routine), routine).not.toMatch(/poms/i);
    }
    expect(fnBody(removal, "public.update_chapter_document_content")).toContain("perform private.lock_message_lifecycle();");
    expect(code).toContain("account lifecycle trigger review is incomplete after POMS removal");
    expect(code).toContain("a routine still names POMS after its removal");
  });

  it("composes reversible two-page Field Notes and Action Lab evidence into both authorized SAMPLE lanes", () => {
    for (const id of ["CR-076", "CR-109"]) expect(migration).toContain(`'${id}'`);
    for (const surface of ["administrativeFieldNotes", "administrativeFieldNotePackets", "administrativeObjectActions"]) {
      expect(migration).toContain(`('${surface}', 25, 50`);
    }
    expect(removal).toContain("where surface in ('administrativePomsSources', 'administrativePomsEvidence');");
    const sync = fnBody(removal, "private.demo_seed_sync_administrative_evidence");
    expect(sync).toContain("new.function_id='CR-076'");
    expect(sync).toContain("old.function_id='CR-076'");
    const seed = fnBody(removal, "private.demo_seed_apply_administrative_evidence");
    expect(seed).toContain("for ordinal in 1..50 loop");
    expect(seed).toContain("presg demo run is not applied");
    expect(seed).toContain("union demo run is not applied");
    expect(seed).toContain("private.demo_seed_remove_administrative_evidence");
    expect(seed).toContain("administrative evidence seed actor is not an active Admin");
    expect(seed).toContain("Source title: ' || source.title");
    expect(seed).toContain("block.packet_state='included'");
    expect(seed).toContain("'field_note_block',block.id,block.issue_key || ' · ' || source.title");
    expect(seed).toContain("Routine evidence review");
    expect(seed).not.toMatch(/insert into public\.(organizations|chapters|member_profiles)\b/i);
  });

  it("uses existing semantic component classes without raw component colors", () => {
    expect(panel).toContain("xus-input");
    expect(panel).toContain("xus-btn--go");
    expect(styles).toMatch(/\.xus-admin-evidence[\s\S]*overflow-wrap:\s*anywhere/);
    expect(panel).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|hsla?\(|text-(?:gray|slate|zinc)-|bg-(?:gray|slate|zinc)-/i);
  });
});
