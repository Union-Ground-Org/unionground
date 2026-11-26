// #9307 Part B / ledger 559: fictional discriminating rows, disposable proofs
// only. No product helper is replaced and no visibility result is simulated.
import { randomUUID } from "node:crypto";
import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";

export const AUTOMATION_READERS = [
  ["mi1_get_automation_definitions", "p_page integer, p_page_size integer, p_search text, p_status text"],
  ["mi1_get_automation_routing_rules", ""],
  ["mi1_get_automation_workspace", ""],
];
export const DEFINITION_FIELDS = ["id", "name", "schemaVersion", "triggerKind", "thresholdDays", "taskPriority", "actionKind", "conditions", "actionConfig", "cadence", "status", "version", "nextRunAt", "lastRunAt", "createdAt", "updatedAt", "reviewStatus", "reviewVersion", "submittedBySelf", "submittedAt", "reviewedAt", "reviewNote", "canEdit", "canSubmit", "canReview", "canActivate", "canPreview", "recipeKey", "scheduledAuthority"];
export const ROUTING_FIELDS = ["id", "name", "eventKind", "routeTo", "enabled", "isDefault", "sortOrder", "priorities", "chapterId", "updatedAt"];

export async function seedAutomationSharing(db, { org, chapter, staff, label }) {
  const target = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  if (db.connectionParameters.host !== target.hostname || Number(db.connectionParameters.port) !== Number(target.port))
    throw new Error("Automation sharing fixture target differs from the disposable proof target");
  const previous = (await db.query("select current_setting('request.jwt.claims',true) v")).rows[0].v;
  const approver = (await db.query(`select g.user_id from public.organization_role_grants g
    join public.member_profiles p on p.id=g.user_id
    join public.chapters ch on ch.id=p.chapter_id and ch.organization_id=g.organization_id
    join public.organization_memberships m on m.user_id=g.user_id and m.organization_id=g.organization_id and m.status='active'
    join public.chapters target on target.id=$2 and target.organization_id=g.organization_id
    where g.organization_id=$1 and g.role in ('admin','vp')
      and private.actor_has_chapter_staff_role(g.user_id,target.id)
    order by g.user_id limit 1`, [org, chapter])).rows[0]?.user_id;
  if (!approver) throw new Error("Automation sharing fixture needs an eligible chapter-staff organization approver");
  const result = {};
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: approver, role: "authenticated", aal: "aal2" })]);
    for (const [key, conditions, actionKind, actionConfig, reviewed] of [
      ["global", {}, "assign_task", { assigneeId: staff }, true],
      ["chapter", { chapterId: chapter }, "notify_in_app", { recipientId: staff }, true],
      ["draft", { chapterId: chapter, priority: "low" }, "notify_in_app", { recipientId: staff }, false],
    ]) {
      const spec = { schemaVersion: 2, name: `C334 shared ${label} ${key}`, triggerKind: "overdue_task", thresholdDays: 1,
        taskPriority: "medium", cadence: "daily", conditions, actionKind, actionConfig };
      // The real validator proves the UUID names active staff of the declared
      // scope. The draft is owned by that staff person, never the reading peer.
      await db.query("select private.automation_v2_validate($1,$2::jsonb)", [org, JSON.stringify(spec)]);
      const id = randomUUID();
      await db.query(`insert into public.organization_automation_definitions
        (id,organization_id,name,trigger_kind,threshold_days,task_priority,cadence,action_kind,schema_version,conditions,action_config,
          created_by,updated_by,review_status,review_version)
        values($1,$2,$3,'overdue_task',1,'medium','daily',$4,2,$5::jsonb,$6::jsonb,$7,$7,$8,$9)`,
      [id, org, spec.name, actionKind, JSON.stringify(conditions), JSON.stringify(actionConfig), reviewed ? approver : staff,
        reviewed ? "approved" : "draft", reviewed ? 1 : null]);
      result[key] = id;
    }
    result.rule = randomUUID();
    await db.query(`insert into public.organization_automation_routing_rules
      (id,organization_id,chapter_id,name,event_kind,route_to,match_priorities,sort_order)
      values($1,$2,$3,$4,'overdue_task','chapter_stewards',array['high'],17)`, [result.rule, org, chapter, `C334 routing ${label}`]);
    return result;
  } finally {
    await db.query("select set_config('request.jwt.claims',$1,true)", [previous ?? ""]);
  }
}
