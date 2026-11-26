import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";

// The retired legacy RLS command remains disabled. Assurance alone invokes
// this owned-fixture proof; it never deletes pre-existing accounts or tenants.

// Accept the VITE_-prefixed names too. `.env.example` documents the browser
// pair as VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY, so a developer who
// filled that in and nothing else used to hit a hard throw here even though the
// values were present. The service-role key stays single-named on purpose — it
// must never acquire a VITE_ alias.
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let disposableTarget;
try { disposableTarget = new URL(url); } catch { /* fail closed below */ }
if (process.env.RLS_DISPOSABLE_CONFIRM !== "owned-ci-database"
    || disposableTarget?.protocol !== "http:"
    || disposableTarget.hostname !== "127.0.0.1"
    || Number(disposableTarget.port) < 55000
    || Number(disposableTarget.port) > 59999
    || !disposableTarget.port
    || disposableTarget.username || disposableTarget.password
    || disposableTarget.pathname !== "/" || disposableTarget.search || disposableTarget.hash) {
  throw new Error("RLS proofs require an explicitly confirmed owned disposable loopback API on ports 55000-59999");
}
if (!url || !key || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY), and SUPABASE_SERVICE_ROLE_KEY are required",
  );
}
const fixtureDatabaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
const databaseTarget = new URL(fixtureDatabaseUrl);
if (databaseTarget.hostname !== disposableTarget.hostname
    || Number(databaseTarget.port) !== Number(disposableTarget.port) + 1
    || databaseTarget.pathname !== "/postgres"
    || databaseTarget.search || databaseTarget.hash) {
  throw new Error("Disposable RLS API and database must belong to the same loopback stack");
}
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const createdUserIds = [];
const fixtureDatabase = new pg.Client({ connectionString: fixtureDatabaseUrl, ssl: false });
const fixtureOrganization = randomUUID();
const fixtureChapter = `rls-${fixtureOrganization}`;
let databaseConnected = false;
let organizationCreated = false;

async function createMember(label) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = `Local!${randomBytes(18).toString("base64url")}`;
  const email = `${label}-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const { data: provisioned, error: provisionError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: label, full_name: `${label} RLS`, initials: label.slice(0, 2).toUpperCase() },
  });
  if (provisionError || !provisioned.user) {
    throw provisionError || new Error(`${label} could not be provisioned by the local admin client`);
  }
  createdUserIds.push(provisioned.user.id);
  // Both subjects belong to the same active tenant: an injected permissive
  // owner policy must still be detected through the restrictive tenant policy.
  await fixtureDatabase.query("update public.member_profiles set chapter_id=$2 where id=$1", [provisioned.user.id, fixtureChapter]);
  await fixtureDatabase.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [fixtureOrganization, provisioned.user.id]);
  await fixtureDatabase.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [provisioned.user.id, fixtureChapter]);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.user) throw error || new Error(`${label} provisioned account could not sign in`);
  return { client, user: data.session.user };
}

async function reserveExactly(userId, count, label) {
  const reservationIds = [];
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const { data, error } = await admin.rpc("reserve_member_ai_request", { p_user_id: userId });
    if (error || typeof data !== "string") throw error || new Error(`${label} reservation ${attempt} failed`);
    reservationIds.push(data);
  }
  return reservationIds;
}

async function runProofs() {
  await fixtureDatabase.connect();
  databaseConnected = true;
  await fixtureDatabase.query("set statement_timeout='15s'");
  await fixtureDatabase.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [fixtureOrganization, fixtureChapter]);
  organizationCreated = true;
  await fixtureDatabase.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9999)", [fixtureChapter, fixtureOrganization]);
  const { count: existingReservations, error: existingError } = await admin.from("member_ai_requests").select("id", { count: "exact", head: true });
  if (existingError || existingReservations !== 0) throw new Error("RLS proofs require a fresh disposable reservation table");

  const a = await createMember("alpha");
  const b = await createMember("beta");

  const { error: directThreadError } = await a.client.from("member_guide_threads").insert({ user_id: a.user.id, title: "Direct partial write" });
  if (!directThreadError) throw new Error("Direct guide thread insert was allowed");

  const { count: beforeInvalid } = await a.client.from("member_guide_threads").select("id", { count: "exact", head: true });
  const { error: invalidExchangeError } = await a.client.rpc("save_member_guide_exchange", {
    p_thread_id: null,
    p_question: "This exchange must roll back",
    p_answer: "",
  });
  if (!invalidExchangeError) throw new Error("Invalid guide exchange was accepted");
  const { count: afterInvalid } = await a.client.from("member_guide_threads").select("id", { count: "exact", head: true });
  if (beforeInvalid !== afterInvalid) throw new Error("Invalid guide exchange left a partial thread");

  const firstQuestion = "Where do I review my open case?";
  const { data: threadId, error: saveError } = await a.client.rpc("save_member_guide_exchange", {
    p_thread_id: null,
    p_question: firstQuestion,
    p_answer: "Open Cases and select the case you want to review.",
  });
  if (saveError || typeof threadId !== "string") throw saveError || new Error("Atomic guide exchange did not return a thread id");

  const { error: secondSaveError } = await a.client.rpc("save_member_guide_exchange", {
    p_thread_id: threadId,
    p_question: "What should I review next?",
    p_answer: "Review the deadline and private case notes, then contact a steward if the matter is urgent.",
  });
  if (secondSaveError) throw secondSaveError;

  const { data: ownedThread, error: ownedThreadError } = await a.client.from("member_guide_threads").select("title").eq("id", threadId).single();
  if (ownedThreadError) throw ownedThreadError;
  if (ownedThread.title !== firstQuestion) throw new Error("Guide thread title changed after a later exchange");

  const { data: ownedMessages, error: ownedMessagesError } = await a.client.from("member_guide_messages").select("role,body").eq("thread_id", threadId).order("created_at");
  if (ownedMessagesError) throw ownedMessagesError;
  if (ownedMessages.length !== 4) throw new Error("Atomic guide exchange did not persist both message pairs");

  const { data: leaked, error: leakedError } = await b.client.from("member_guide_threads").select("id").eq("id", threadId);
  if (leakedError) throw leakedError;
  if (leaked.length !== 0) throw new Error("Cross-user guide thread read was allowed");

  const { error: foreignSaveError } = await b.client.rpc("save_member_guide_exchange", {
    p_thread_id: threadId,
    p_question: "Foreign question",
    p_answer: "Foreign answer",
  });
  if (!foreignSaveError) throw new Error("Cross-user guide exchange was allowed");

  const { data: context, error: contextError } = await a.client.rpc("get_member_guide_context");
  if (contextError) throw contextError;
  if (!Number.isInteger(context.openCases) || !Array.isArray(context.activePlanKinds) || context.activePlanKinds.length > 3 || !Array.isArray(context.rightsLessons) || context.rightsLessons.length > 12) {
    throw new Error("Server-owned guide context was not bounded");
  }

  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: anonContextError } = await anon.rpc("get_member_guide_context");
  if (!anonContextError || !anonContextError.message.includes("permission denied for function")) throw new Error("Anonymous guide context function grant was not denied");

  const { error: directReservationError } = await a.client.from("member_ai_requests").insert({ user_id: a.user.id });
  if (!directReservationError) throw new Error("Direct AI reservation insert was allowed");
  const { error: directReservationReadError } = await a.client.from("member_ai_requests").select("id");
  if (!directReservationReadError) throw new Error("Direct AI reservation read was allowed");
  const { error: directReservationRpcError } = await a.client.rpc("reserve_member_ai_request", { p_user_id: a.user.id });
  if (!directReservationRpcError) throw new Error("Authenticated member called the trusted reservation RPC");
  const { error: directReservationV2RpcError } = await a.client.rpc("reserve_member_ai_request_v2", { p_user_id: a.user.id });
  if (!directReservationV2RpcError) throw new Error("Authenticated member called the trusted v2 reservation RPC");

  const { data: releasable, error: releasableError } = await admin.rpc("reserve_member_ai_request", { p_user_id: a.user.id });
  if (releasableError || typeof releasable !== "string") throw releasableError || new Error("AI reservation id was not returned");
  const { error: memberReleaseError } = await a.client.rpc("release_member_ai_request", { p_request_id: releasable });
  if (!memberReleaseError) throw new Error("Authenticated member called the trusted refund RPC");
  const { data: trustedRelease, error: trustedReleaseError } = await admin.rpc("release_member_ai_request", { p_request_id: releasable });
  if (trustedReleaseError || trustedRelease !== true) throw trustedReleaseError || new Error("Trusted reservation refund failed");

  const { data: v2Granted, error: v2GrantedError } = await admin.rpc("reserve_member_ai_request_v2", { p_user_id: a.user.id });
  if (v2GrantedError || typeof v2Granted?.id !== "string" || v2Granted.cause !== null) {
    throw v2GrantedError || new Error("v2 reservation did not answer {id, cause: null} when under both caps");
  }
  const { data: v2Release, error: v2ReleaseError } = await admin.rpc("release_member_ai_request", { p_request_id: v2Granted.id });
  if (v2ReleaseError || v2Release !== true) throw v2ReleaseError || new Error("v2-granted reservation could not be refunded");

  const alphaReservations = await reserveExactly(a.user.id, 20, "alpha");
  const { data: userLimited, error: userLimitError } = await admin.rpc("reserve_member_ai_request", { p_user_id: a.user.id });
  if (userLimitError) throw userLimitError;
  if (userLimited !== null) throw new Error("AI request 21 was not rate-limited");
  const { error: cappedMemberReleaseError } = await a.client.rpc("release_member_ai_request", { p_request_id: alphaReservations[0] });
  if (!cappedMemberReleaseError) throw new Error("Capped member released a reservation to reset quota");
  const { data: stillLimited, error: stillLimitedError } = await admin.rpc("reserve_member_ai_request", { p_user_id: a.user.id });
  if (stillLimitedError || stillLimited !== null) throw stillLimitedError || new Error("Member quota reset after a denied client refund");
  const { data: userLimitedV2, error: userLimitV2Error } = await admin.rpc("reserve_member_ai_request_v2", { p_user_id: a.user.id });
  if (userLimitV2Error) throw userLimitV2Error;
  if (!userLimitedV2 || userLimitedV2.id !== null || userLimitedV2.cause !== "member") {
    throw new Error("v2 did not attribute the member cap atomically");
  }

  const globalFillers = [b];
  for (let index = 0; index < 8; index += 1) globalFillers.push(await createMember(`global${index}`));
  for (const [index, member] of globalFillers.entries()) await reserveExactly(member.user.id, 20, `global-${index}`);

  const globallyBlockedMember = await createMember("globalblocked");
  const { data: globallyLimited, error: globalLimitError } = await admin.rpc("reserve_member_ai_request", { p_user_id: globallyBlockedMember.user.id });
  if (globalLimitError) throw globalLimitError;
  if (globallyLimited !== null) throw new Error("Global 200/hour AI limit was not enforced");
  const { data: globallyLimitedV2, error: globalLimitV2Error } = await admin.rpc("reserve_member_ai_request_v2", { p_user_id: globallyBlockedMember.user.id });
  if (globalLimitV2Error) throw globalLimitV2Error;
  if (!globallyLimitedV2 || globallyLimitedV2.id !== null || globallyLimitedV2.cause !== "org") {
    throw new Error("v2 did not attribute the aggregate cap atomically");
  }

  return {
    status: "passed",
    checks: [
      "direct partial writes denied",
      "atomic exchange rollback and persistence",
      "stable guide thread titles",
      "cross-user read and write denied",
      "bounded authenticated server context",
      "member reservation reads and RPC calls denied (legacy and v2)",
      "trusted provider-failure refund",
      "v2 grant answers {id, cause: null} and refunds cleanly",
      "client refund cannot reset quota",
      "20/hour member limit (legacy null, v2 cause member)",
      "200/hour aggregate limit (legacy null, v2 cause org)",
    ],
  };
}

let report;
let proofFailure;
try {
  report = await runProofs();
} catch (error) {
  proofFailure = error;
}
let cleanupFailure = false;
try {
  if (createdUserIds.length) {
    const { error } = await admin.from("member_ai_requests").delete().in("user_id", createdUserIds);
    if (error) cleanupFailure = true;
    for (const userId of createdUserIds) {
      const { error: userError } = await admin.auth.admin.deleteUser(userId);
      if (userError) cleanupFailure = true;
    }
  }
} catch {
  cleanupFailure = true;
}
try {
  if (organizationCreated) {
    // Membership provisioned these empty ledger subjects. Account deletion
    // deliberately retains them; remove only this owned fixture's detached
    // subjects before deleting its temporary tenant.
    await fixtureDatabase.query("delete from public.dues_member_subjects where organization_id=$1 and user_id is null", [fixtureOrganization]);
    await fixtureDatabase.query("delete from public.chapters where id=$1 and organization_id=$2", [fixtureChapter, fixtureOrganization]);
    await fixtureDatabase.query("delete from public.organizations where id=$1", [fixtureOrganization]);
  }
} catch {
  cleanupFailure = true;
} finally {
  if (databaseConnected) await fixtureDatabase.end();
}
if (proofFailure) throw proofFailure;
if (cleanupFailure) throw new Error("Owned RLS fixture cleanup failed");
console.log(JSON.stringify(report));
