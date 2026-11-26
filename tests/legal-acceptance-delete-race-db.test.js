// @vitest-environment node
//
// REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 — live proof that a
// clickwrap acceptance can never outlive the account it belongs to.
//
// private.legal_acceptances has no auth.users foreign key; an account's rows
// are removed by the after-delete trigger on public.member_profiles. A trigger
// does not serialize an insert with a deletion, so the second source review of
// PR #4320 reproduced a writer that read the profile, let a deletion and its
// cleanup commit, and then inserted a row for the deleted account. The writers
// now hold a KEY SHARE lock on the profile through the insert. Both commit
// orders are proved here on the complete local schema: when the acceptance
// commits first the deletion waits and then removes it, and when the deletion
// commits first the writer refuses. Nothing here touches a hosted database.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectLocal } from "./helpers/local-lifecycle-contention.mjs";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";

const url = process.env.SUPABASE_DB_URL;
const live = url ? describe : describe.skip;
const VERSIONS = JSON.stringify(currentLegalVersions());

async function tenant(c) {
  const org = randomUUID();
  const chapter = `proof-${org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
  return { org, chapter };
}

async function member(c, t) {
  const id = randomUUID();
  const session = randomUUID();
  await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
  await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, t.chapter]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
  return { id, session };
}

async function actAs(c, m) {
  await c.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: m.id, role: "authenticated", aal: "aal2", session_id: m.session })]);
}

// One bounded settle, then one read of the backend's wait state. No polling.
async function waitType(owner, pid) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return (await owner.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type;
}

async function acceptances(owner, userId) {
  return (await owner.query("select count(*)::int n from private.legal_acceptances where user_id=$1", [userId])).rows[0].n;
}

async function cleanup(owner, t, userId) {
  await owner.query("delete from auth.users where id=$1", [userId]).catch(() => {});
  await owner.query("delete from public.chapters where id=$1", [t.chapter]).catch(() => {});
  await owner.query("delete from public.organizations where id=$1", [t.org]).catch(() => {});
}

live("versioned terms acceptance against a concurrent account deletion", () => {
  it("an acceptance that commits first is removed by the deletion that waited for it", async () => {
    const owner = await connectLocal(url, "acceptance-race-owner");
    const writer = await connectLocal(url, "acceptance-race-writer");
    const deleter = await connectLocal(url, "acceptance-race-deleter");
    const t = await tenant(owner);
    const m = await member(owner, t);
    try {
      await actAs(writer, m);
      await writer.query("begin");
      const recorded = (await writer.query("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [VERSIONS])).rows[0].r;
      expect(recorded).toMatchObject({ recorded: true, chapterId: t.chapter });
      const deleterPid = (await deleter.query("select pg_backend_pid() pid")).rows[0].pid;
      const deletion = deleter.query("delete from auth.users where id=$1", [m.id]);
      // The writer still holds the profile; the deletion must queue behind it.
      expect(await waitType(owner, deleterPid)).toBe("Lock");
      await writer.query("commit");
      await deletion;
      expect((await owner.query("select count(*)::int n from public.member_profiles where id=$1", [m.id])).rows[0].n).toBe(0);
      expect(await acceptances(owner, m.id)).toBe(0);
    } finally {
      await writer.query("rollback").catch(() => {});
      await cleanup(owner, t, m.id);
      await Promise.allSettled([owner.end(), writer.end(), deleter.end()]);
    }
  }, 20000);

  it("a deletion that commits first makes the waiting writer refuse and record nothing", async () => {
    const owner = await connectLocal(url, "acceptance-race-owner");
    const writer = await connectLocal(url, "acceptance-race-writer");
    const deleter = await connectLocal(url, "acceptance-race-deleter");
    const t = await tenant(owner);
    const m = await member(owner, t);
    try {
      await actAs(writer, m);
      await deleter.query("begin");
      await deleter.query("delete from auth.users where id=$1", [m.id]);
      const writerPid = (await writer.query("select pg_backend_pid() pid")).rows[0].pid;
      const attempt = writer.query("select public.record_legal_acceptance($1::jsonb, 'TX', true) r", [VERSIONS])
        .then(() => null, (error) => error);
      // The writer must wait, not read the doomed version.
      expect(await waitType(owner, writerPid)).toBe("Lock");
      await deleter.query("commit");
      const refused = await attempt;
      // The writer queues at the case-graph gate the deletion holds; once it
      // enters, the account and its Auth session are gone, so it is refused
      // before it reads any profile.
      expect(refused).toMatchObject({ code: "42501", message: "authentication required" });
      expect(await acceptances(owner, m.id)).toBe(0);
    } finally {
      await deleter.query("rollback").catch(() => {});
      await cleanup(owner, t, m.id);
      await Promise.allSettled([owner.end(), writer.end(), deleter.end()]);
    }
  }, 20000);
});
