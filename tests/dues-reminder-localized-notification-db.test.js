// @vitest-environment node
//
// I18N-UG-DISPATCH-DUES-REMINDER-ATTEMPT-WRITES-HARD-CODED-ENGLISH-DUES-20260921
// public.dispatch_dues_reminder_attempt used to write two English literals into
// member_notifications, so a member whose profile language is 'es' read
// "Account update" in the app while the matching email was Spanish. This proof
// queues an in-app reminder for a Spanish and an English member, leases and
// dispatches both as the service role, and reads the rows that reached each
// member. Everything runs in one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const SPANISH = {
  title: "Novedad en tu cuenta",
  body: "Una novedad de tu cuenta requiere tu atención. Abre Cuotas para revisarla.",
};
const ENGLISH = {
  title: "Account update",
  body: "An account update needs your attention. Open Dues to review it.",
};

live("dues reminder notifications render in the member's language", () => {
  let client;
  const ids = {
    org: randomUUID(), admin: randomUUID(), session: randomUUID(),
    es: randomUUID(), en: randomUUID(), batch: randomUUID(),
  };
  ids.chapter = `dues-reminder-i18n-${ids.org}`;
  const notifications = {};

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "dues-reminder-localized-notification-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const user of [ids.admin, ids.es, ids.en]) {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [user, `${user}@example.invalid`]);
      await client.query("delete from public.member_notifications where user_id=$1 and kind='general' and title='Welcome to your private organizing workspace'", [user]);
    }
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids.org, ids.chapter, ids.admin]);
    await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [ids.chapter, ids.org]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.org, ids.admin]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids.admin, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [ids.chapter, ids.admin]);
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [ids.org, ids.admin]);
    await client.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [ids.session, ids.admin]);
    await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), ids.admin]);
    await client.query("update public.member_profiles set language = 'es' where id = $1", [ids.es]);
    await client.query("update public.member_profiles set language = 'en' where id = $1", [ids.en]);
    await client.query(
      `insert into public.dues_assessment_batches (id, organization_id, title, scope_kind, amount_cents, due_on, eligibility_fingerprint, idempotency_key, created_by)
       values ($1, $2, 'Dues', 'organization', 2500, current_date - 10, repeat('a', 64), $3, $4)`,
      [ids.batch, ids.org, `batch-${ids.batch}`, ids.admin],
    );
    const obligations = {};
    for (const member of ["es", "en"]) {
      const subject = randomUUID();
      obligations[member] = randomUUID();
      await client.query("insert into public.dues_member_subjects (id, organization_id, user_id) values ($1, $2, $3)", [subject, ids.org, ids[member]]);
      await client.query(
        `insert into public.dues_obligations (id, organization_id, batch_id, member_subject_id, issued_cents, due_on)
         values ($1, $2, $3, $4, 2500, current_date - 10)`,
        [obligations[member], ids.org, ids.batch, subject],
      );
    }

    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.admin, role: "authenticated", aal: "aal2", session_id: ids.session })]);
    await client.query("set local role authenticated");
    const attempts = {};
    for (const member of ["es", "en"]) {
      attempts[member] = (await client.query(
        "select public.queue_dues_reminder($1, 'in_app', $2, 'admin') as value",
        [obligations[member], `dues-reminder-i18n-${randomUUID()}`],
      )).rows[0].value.id;
    }
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
    const claims = (await client.query("select * from public.claim_dues_reminder_attempts(25)")).rows;
    for (const member of ["es", "en"]) {
      const claim = claims.find((row) => row.id === attempts[member]);
      const dispatched = (await client.query(
        "select public.dispatch_dues_reminder_attempt($1, $2, $3, 'sent', null) as value",
        [claim.id, claim.attempt_count, claim.lease_epoch],
      )).rows[0].value;
      notifications[member] = dispatched;
    }
    await client.query("reset role");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  async function notificationFor(member) {
    const { rows } = await client.query(
      "select id, title, body, kind from public.member_notifications where user_id = $1",
      [ids[member]],
    );
    return rows;
  }

  it("keeps both copies in the shared notification catalogue", async () => {
    const { rows } = await client.query(
      "select lang, title, body from private.notification_copy where key = 'dues.reminder' order by lang",
    );
    expect(rows).toEqual([{ lang: "en", ...ENGLISH }, { lang: "es", ...SPANISH }]);
  });

  it("writes the Spanish reminder for a member whose profile language is es", async () => {
    expect(notifications.es.state).toBe("sent");
    const rows = await notificationFor("es");
    expect(rows).toEqual([{ id: notifications.es.notificationId, ...SPANISH, kind: "dues" }]);
    expect(rows[0].title).not.toBe("Account update");
  });

  it("keeps the English reminder unchanged for an English member", async () => {
    expect(notifications.en.state).toBe("sent");
    expect(await notificationFor("en")).toEqual([{ id: notifications.en.notificationId, ...ENGLISH, kind: "dues" }]);
  });
});
