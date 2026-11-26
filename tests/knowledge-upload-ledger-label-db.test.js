// @vitest-environment node
//
// BUG-UG-LEDGER-SAYS-KNOWLEDGE-FILE-UPLOADED-BEFORE-ANY-BYTES-ARRIVE-20261112 (#8545)
//
// prepare_steward_library_upload writes the ledger row knowledge_file_uploaded
// (reviewStatus pending_scan) when it creates the file row and hands back a
// storage handle, before any bytes are sent or the scanner runs, and nothing
// later records the bytes or the scan. This prepares an upload that never
// completes, reads the organization ledger the way the ledger page does, and
// checks that the page names the row an upload started, never an upload.
// Everything runs in one transaction that is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { PREPARED_KNOWLEDGE_UPLOAD_LABEL, isPreparedKnowledgeUpload } from "../src/features/operations/auditEventLabel.js";
import { t } from "../src/lib/i18n.js";

const n = (suffix) => `50908545-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = { org: n(1), steward: n(101), session: n(901), prepareKey: n(501) };
const CHAPTER = "knowledge-ledger-proof-main";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a prepared steward library upload on a disposable database", () => {
  let db;

  async function asSteward(sql, values = []) {
    await db.query("savepoint as_steward");
    try {
      const claims = { sub: ID.steward, role: "authenticated", session_id: ID.session, aal: "aal2" };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("release savepoint as_steward");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_steward");
      await db.query("reset role");
      throw error;
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "knowledge-upload-ledger-label-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, 'knowledge-ledger-steward@example.invalid', now())", [ID.steward]);
    await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ID.session, ID.steward]);
    await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'Ledger label proof', 'totp', 'verified', now(), now())", [ID.steward]);
    await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, 'knowledge-ledger-proof', 'Fictional Tamarack Valley Local', $2)", [ID.org, ID.steward]);
    // The ledger reader resolves the organization from the steward's selected chapter.
    await db.query("insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, 'Tamarack Valley Main', $1, $2, false, 9985)", [CHAPTER, ID.org]);
    await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, ID.steward]);
    await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [ID.steward, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.steward, CHAPTER]);
    await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2), ($1, $2, 'admin', $2)", [ID.org, ID.steward]);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("records the prepare as one pending_scan row that the ledger page names an upload started", async () => {
    const [{ v: prepared }] = await asSteward(`
      select public.prepare_steward_library_upload(
        'never-sent.txt', 128, repeat('a', 64), 'Never sent', '', 'general', $1
      ) v
    `, [ID.prepareKey]);
    expect(prepared.fileId).toEqual(expect.any(String));
    expect(prepared.storageHandle).toEqual(expect.any(String));

    // No bytes were sent and no scan ran: no Storage object exists for the file.
    const objects = await db.query("select count(*)::int c from storage.objects where bucket_id = 'organization-knowledge' and name like $1", [`org/${ID.org}/${prepared.fileId}/%`]);
    expect(objects.rows[0].c).toBe(0);

    const [{ v: ledger }] = await asSteward("select public.list_organization_audit_ledger(50, null, null, null, null) v");
    const rows = (Array.isArray(ledger) ? ledger : []).filter((event) => event?.metadata?.fileId === prepared.fileId);
    expect(rows.map((event) => event.eventType)).toEqual(["knowledge_file_uploaded"]);
    expect(rows[0].metadata).toMatchObject({ reviewStatus: "pending_scan", action: "uploaded" });

    // The page renders this row with the started label; the rendering itself and
    // the Spanish label are proven by tests/mi1-audit-job-spine-ui.test.jsx.
    expect(isPreparedKnowledgeUpload(rows[0])).toBe(true);
    expect(t("en", PREPARED_KNOWLEDGE_UPLOAD_LABEL)).toBe("knowledge file upload started");
  });
});
