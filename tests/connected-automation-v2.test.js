import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql=readFileSync(resolve("supabase/migrations/20260910045839_connected_automation_v2.sql"),"utf8");
const proof=readFileSync(resolve("scripts/verify-connected-automation-v2-local.mjs"),"utf8");

test("connected automation extends all four canonical domains without provider activation",()=>{
  for(const table of ["chapter_tasks","member_cases","casework_deadlines","casework_checklists","casework_checklist_items","member_appointments","member_events"])
    assert.match(sql,new RegExp(`public\\.${table}\\b`));
  assert.match(sql,/schema_version in \(1,2\)/);
  assert.match(sql,/source_id type text using source_id::text/);
  assert.doesNotMatch(sql,/cron\.schedule\s*\(/);
  assert.doesNotMatch(sql,/insert into public\.organization_automation_settings/i);
});

test("v2 keeps explicit RPC ACLs, typed data, tenant scope, locks and conflict-safe undo",()=>{
  for(const rpc of ["save_automation_definition_v2","get_automation_definitions","get_automation_definition","get_automation_runs","get_automation_run","get_automation_scope_options","get_automation_source_context"]){
    assert.match(sql,new RegExp(`revoke all on function[^;]*public\\.mi1_${rpc}\\(`));
    assert.match(sql,new RegExp(`grant execute on function[^;]*public\\.mi1_${rpc}\\(`));
  }
  assert.match(sql,/private\.cr108_require_operator\(\)/);
  assert.match(sql,/private\.automation_v2_source_visible/);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/d\.version=r\.definition_version/);
  assert.match(sql,/taskDigest/);
  assert.match(sql,/activityCount/);
  assert.match(sql,/e\.mutation_xid=pg_current_xact_id\(\)/);
  assert.match(sql,/current_setting\('app\.automation_task_receipt',true\)/);
  assert.match(sql,/reason_code='irreversible'/);
  assert.match(sql,/'general'\) returning id into nid/);
});

test("retained executable database proof exercises actions and negative paths rather than SQL text alone",()=>{
  for(const behavior of ["14 distinct trigger queries execute","partial failure receipt","real second connection","human changes prevent rollback","only the deliberate human positive control queued external notification delivery","stale_version","foreign_recipient","v2_mfa"])
    assert.ok(proof.includes(behavior),`missing executable proof case: ${behavior}`);
  assert.match(proof,/await client\.query\("rollback"\)/);
  assert.match(proof,/assertDisposableProofUrl\(/);
});

test("database proof dates its fixtures on the Eastern day the automation windows read",()=>{
  // #9180: the task window reads private.eastern_day() (20261117121800), so a
  // fixture date stepped from the UTC session day failed every evening.
  assert.doesNotMatch(proof,/current_date\s*[-+]\s*(\$\d|\d)/);
  assert.ok(proof.includes("const EASTERN_DAY = \"(pg_catalog.now() at time zone 'America/New_York')::date\";"));
  for(const pinned of ["Etc/GMT-14","Etc/GMT+12","task window follows the Eastern day in sessions on both sides of the split"])
    assert.ok(proof.includes(pinned),`missing session-day split case: ${pinned}`);
});

test("control-room definitions use the same source redaction projection as detail and list",()=>{
  const controlRoom=sql.split("create or replace function public.get_organization_automation_control_room()")[1];
  assert.ok(controlRoom,"control-room replacement is present");
  const projection=controlRoom.split("into definitions_json")[1].split(") projected;")[0];
  assert.match(projection,/private\.automation_v2_definition_read\(d\)/);
  assert.doesNotMatch(projection,/'conditions',\s*d\.conditions/);
  assert.match(projection,/'dependencyReady',\s*private\.automation_v2_operator\(d\.updated_by,d\.organization_id\)/);
  assert.ok(proof.includes("control room redacts unavailable source without broadening saved scope"));
  assert.ok(proof.includes("client-retained control room redacts the deleted task source"));
  assert.ok(proof.includes("client-retained control room redacts another operator's inaccessible case"));
});
