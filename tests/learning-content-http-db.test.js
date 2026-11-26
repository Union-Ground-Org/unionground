// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.SUPABASE_DB_URL ? it : it.skip;

databaseIt("returns HTTP 409 for stale policy, draft and publication revisions without retrying", async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = assertDisposableStorageStatus(
    JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8")), connectionString,
  );
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const caller = createClient(status.API_URL, status.ANON_KEY, options);
  const db = new pg.Client({ connectionString });
  const org = randomUUID();
  const chapter = `learning-http-${org}`;
  let userId;
  await db.connect();
  try {
    await db.query("set lock_timeout='5s'; set statement_timeout='15s'");
    const email = `${chapter}@example.invalid`, password = `Synthetic!${randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const session = await caller.auth.signInWithPassword({ email, password });
    if (session.error) throw session.error;
    // Committed fixtures are required: HTTP requests use separate connections.
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, userId]);
    // This synthetic organization permits its password session, as SAMPLE does.
    // The separate DB suite exercises authorization; this proof targets HTTP retries.
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [org, userId]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9950)", [chapter, org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    const rpc = async (name, args, expectedStatus = 200) => {
      const response = await fetch(`${status.API_URL}/rest/v1/rpc/${name}`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { apikey: status.ANON_KEY, authorization: `Bearer ${session.data.session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(expectedStatus);
      if (expectedStatus === 409) expect(body).toMatchObject({ code: "PT409", message: "revision conflict" });
      return body;
    };
    const scope = { p_chapter_id: chapter, p_scope: "chapter" };
    const policy = { ...scope, p_quotes_enabled: false, p_lessons_enabled: false, p_selected_ids: null, p_expected_revision: 0 };
    const savedPolicy = await rpc("save_learning_policy", policy);
    await rpc("save_learning_policy", { ...policy, p_quotes_enabled: true }, 409);
    const workspace = await rpc("get_learning_workspace", scope);
    expect(workspace.policy).toMatchObject({ quotes_enabled: false, lessons_enabled: false, revision: savedPolicy.revision });

    const item = { kind: "quote", locale: "en", locale_state: "reviewed", title: "HTTP conflict proof", body: "Listen carefully.", rights_note: "Original test writing.", review_note: "Reviewed for this test." };
    // A revision on an insertion is also a permanent conflict.
    await rpc("save_learning_content", { ...scope, p_item: item, p_expected_revision: 1 }, 409);
    const draft = await rpc("save_learning_content", { ...scope, p_item: item, p_expected_revision: null });
    const edited = await rpc("save_learning_content", { ...scope, p_item: { ...item, id: draft.id, title: "Current draft" }, p_expected_revision: draft.revision });
    await rpc("save_learning_content", { ...scope, p_item: { ...item, id: draft.id }, p_expected_revision: draft.revision }, 409);
    const transition = { p_chapter_id: chapter, p_id: draft.id, p_action: "publish", p_expected_revision: draft.revision };
    await rpc("transition_learning_content", transition, 409);
    const published = await rpc("transition_learning_content", { ...transition, p_expected_revision: edited.revision });
    expect(published).toMatchObject({ status: "published", title: "Current draft", revision: edited.revision + 1 });
    const history = await rpc("get_learning_history", { p_chapter_id: chapter, p_id: draft.id });
    expect(history.items.map(row => row.action)).toEqual(["publish", "save_draft", "save_draft"]);
    // Rejected policy requests neither overwrite the winner nor add audit rows.
    expect((await db.query("select count(*)::int n from private.learning_history where scope_key=$1 and action='policy'", [`chapter:${chapter}`])).rows[0].n).toBe(1);
  } finally {
    // These are this test's random fixtures on a guarded disposable stack only.
    const failures = [];
    const clean = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await clean(() => db.query("delete from private.learning_history where scope_key=$1", [`chapter:${chapter}`]));
    await clean(() => db.query("update public.member_profiles set chapter_id=null where id=$1 and chapter_id=$2", [userId, chapter]));
    await clean(() => db.query("delete from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [userId, chapter]));
    await clean(() => db.query("delete from public.chapters where id=$1", [chapter]));
    await clean(() => db.query("delete from public.organization_role_grants where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.organization_memberships where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.dues_member_subjects where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.org_security_policy where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.organizations where id=$1", [org]));
    if (userId) await clean(async () => { const result = await admin.auth.admin.deleteUser(userId); if (result.error) throw result.error; });
    await clean(() => db.end());
    // eslint-disable-next-line no-unsafe-finally -- cleanup failures must fail the proof even after its assertions ran
    if (failures.length) throw new AggregateError(failures, "Learning HTTP proof cleanup failed");
  }
}, 90000);
