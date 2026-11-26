import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { migrationDigest } from "./account-case-graph-inventory.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));
const target = new URL(databaseUrl);


const workdir = process.env.CI_DB_WORKDIR;
const projectId = process.env.CI_DB_PROJECT_ID;
if (process.env.AUTOMATION_DISPOSABLE_CONFIRM !== "owned-local-automation" ||
    !/^unionground-lab-ci-[a-f0-9]{12}$/.test(projectId || "") ||
    !workdir || !realpathSync(workdir).startsWith("/tmp/unionground-lab-ci-")) {
  throw new Error("Owned disposable stack identity and explicit automation proof confirmation required");
}
const config = readFileSync(workdir+"/supabase/config.toml","utf8");
const inspect = spawnSync("docker",["inspect","--format","{{json .}}","supabase_db_"+projectId],{encoding:"utf8"});
if (inspect.status !== 0) throw new Error("Owned database container unavailable");
const container = JSON.parse(inspect.stdout);
if (!config.split("\n").includes('project_id = "'+projectId+'"') ||
    container.Config.Labels["com.supabase.cli.project"] !== projectId ||
    target.hostname !== "127.0.0.1" ||
    !container.NetworkSettings.Ports["5432/tcp"]?.every(p=>p.HostPort===target.port) ||
    migrationDigest("supabase/migrations") !== migrationDigest(workdir+"/supabase/migrations")) {
  throw new Error("Disposable container, port, or exact migration source mismatch");
}

const ids = {
  admin: "50900000-0000-4000-8000-000000000108",
  outsider: "50900000-0000-4000-8000-000000000109",
  foreignOrg: "50900000-0000-4000-8000-000000000110",
  bootstrapKey: "50900000-0000-4000-8000-000000000111",
  sourceA: "50900000-0000-4000-8000-000000000112",
  sourceB: "50900000-0000-4000-8000-000000000113",
  sourceC: "50900000-0000-4000-8000-000000000114",
  foreignDefinition: "50900000-0000-4000-8000-000000000115",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null, aal = "aal2") {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal, session_id: userId } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "connected-automation-concurrent-runs-proof",
});
let resetRequired = false;

try {
  await client.connect();
  const launchState = (await client.query(`
    select
      (select count(*)::int from public.organizations) as organizations,
      (select count(*)::int from public.organization_automation_definitions) as definitions,
      (select count(*)::int from auth.users) as users
  `)).rows[0];
  assert(launchState.organizations === 0, "local reset must preserve the zero-organization launch state");
  assert(launchState.definitions === 0, "local reset must not seed automation definitions");
  assert(launchState.users === 0, "local reset must not seed real or fictional Auth identities");
  resetRequired = true; // Never reset a target that failed the zero-data preflight.
  await client.query("begin");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'cr108-admin@example.invalid'),
      ($2, 'cr108-outsider@example.invalid')
  `, [ids.admin, ids.outsider]);

  await asRole(client, "service_role");
  const bootstrap = (await client.query(`
    select public.bootstrap_first_organization(
      'CR-108 local proof', 'cr108-local-proof', $1,
      'cr108', 'CR-108 local chapter', 'cr108', $2
    ) as value
  `, [ids.admin, ids.bootstrapKey])).rows[0].value;
  const organizationId = bootstrap.organizationId;
  assert(organizationId && bootstrap.chapterId === "cr108", "service bootstrap must create the explicit local proof tenant");

  await client.query("reset role");
  // The current MFA boundary requires a live session, not an AAL claim alone.
  await client.query(`
    insert into auth.sessions (id, user_id, aal, created_at)
    values ($1, $1, 'aal2', now()), ($2, $2, 'aal2', now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $1, 'totp', now(), now()), ($2, $2, 'totp', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values
      (extensions.gen_random_uuid(), $1, 'cr108-proof', 'totp', 'verified', now(), now()),
      (extensions.gen_random_uuid(), $2, 'cr108-proof', 'totp', 'verified', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into public.chapter_workstreams (chapter_id, name, created_by)
    values ('cr108', 'General', $1)
  `, [ids.admin]);

  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, 'cr108-foreign', 'CR-108 foreign proof', 'active', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, $1, true, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.chapters (id, name, is_default, order_index, organization_id, slug)
    values ('cr108-foreign', 'CR-108 foreign chapter', true, 1, $1, 'cr108-foreign')
  `, [ids.foreignOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id)
    values ($1, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'admin', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
    values ($1, 'cr108-foreign', 'active', now())
  `, [ids.outsider]);
  await client.query("update public.member_profiles set chapter_id = 'cr108-foreign' where id = $1", [ids.outsider]);
  await client.query(`
    insert into public.organization_automation_definitions (
      id, organization_id, name, trigger_kind, threshold_days, cadence,
      task_priority, status, version, created_by, updated_by
    ) values ($1, $2, 'Foreign automation', 'overdue_task', 0, 'daily',
      'medium', 'active', 1, $3, $3)
  `, [ids.foreignDefinition, ids.foreignOrg, ids.outsider]);


  await asRole(client,"authenticated",ids.admin);
  await client.query("reset role");
  await client.query(`insert into public.chapter_tasks(id,title,due_date) values
    ($1,'Concurrent source A',current_date-1),($2,'Concurrent source B',current_date-1)`,[ids.sourceA,ids.sourceB]);
  await asRole(client,"authenticated",ids.admin);
  const definition=(await client.query("select public.mi1_save_automation_definition_v2($1) value",[{
    schemaVersion:2,name:"Actual concurrent execute proof",triggerKind:"overdue_task",thresholdDays:0,
    taskPriority:"medium",cadence:"daily",conditions:{},actionKind:"create_standard_task",actionConfig:{}
  }])).rows[0].value;
  // V3 governance binds activation to an exact-version approval, as in the
  // sibling v2 proof: submit and self-review before activating, or activation
  // raises PT409 "definition changed, unapproved, or unavailable".
  await client.query("select public.mi1_submit_automation_definition($1,$2)",[definition.id,definition.version]);
  await client.query("select public.mi1_review_automation_definition($1,$2,'approve',null)",[definition.id,definition.version]);
  await client.query("select public.set_organization_automation_definition_status($1,'active',$2)",[definition.id,definition.version]);
  await client.query("select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION')");
  const previews=[];
  for(let i=0;i<2;i++) previews.push((await client.query("select public.preview_organization_automation_run($1) value",[definition.id])).rows[0].value);
  await client.query("commit"); // Only this verified disposable stack receives committed fixtures.
  const outcomes = await Promise.all(previews.map(async(preview,index)=>{
    const writer=new Client({connectionString:databaseUrl,application_name:"connected-run-racer-"+index});
    try {
      await writer.connect();
      await writer.query("begin");
      await writer.query("set local statement_timeout='20s'");
      await asRole(writer,"authenticated",ids.admin);
      const result=(await writer.query("select public.execute_organization_automation_run($1,$2) value",[preview.id,preview.confirmationPhrase])).rows[0].value;
      await writer.query("commit");
      return result;
    } finally { await writer.query("rollback").catch(()=>{}); await writer.end(); }
  }));
  assert(outcomes.filter(x=>x.status==="succeeded" && x.effectsCreated===2).length===1,"one actual RPC creates both effects");
  assert(outcomes.filter(x=>x.status==="no_op" && x.effectsCreated===0).length===1,"the competing actual RPC rechecks committed deduplication");
  const state=(await client.query(`select
    (select count(*)::int from public.organization_automation_effects where definition_id=$1 and status='created') effects,
    (select count(*)::int from public.organization_automation_runs where definition_id=$1 and status='in_progress') pending`,[definition.id])).rows[0];
  assert(state.effects===2 && state.pending===0,"concurrent RPCs leave exactly two effects and no stranded run");
  console.log("PASS: two simultaneous public execute RPCs serialize; exactly one succeeds and one becomes a deduplicated no-op, with no deadlock or duplicate effect.");
} finally {
  await client.query("rollback").catch(()=>{});
  await client.end();
  // Fixtures were committed solely to exercise independent real transactions.
  // Reset only the proven owned disposable stack; never accept a remote URL.
  if (resetRequired) {
  // A reset replays every migration (476 at the time of writing, about eight
  // minutes on a loaded workstation). The old three-minute bound killed it
  // part-way and left a half-migrated stack behind.
  const reset=spawnSync("supabase",["--workdir",workdir,"db","reset","--local","--no-seed"],{
    encoding:"utf8",timeout:30*60*1000,maxBuffer:32*1024*1024,
    env:Object.fromEntries(["PATH","HOME","LANG","TMPDIR"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
  });
  if(reset.status!==0) {
    process.exitCode=1;
    console.error("Owned disposable cleanup failed; retain stack for inspection; raw reset output withheld");
  } else console.log("PASS: committed concurrency fixtures removed by exact owned-stack migration reset; no hosted or shared database touched.");
  }
}
