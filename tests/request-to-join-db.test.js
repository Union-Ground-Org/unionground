// @vitest-environment node
// REQ-UG-REQUEST-TO-JOIN-PAGE-20261017: live proof on the disposable
// stack that a request to join is stored behind the landing limits and the
// suppression check, one per address, invisible to tenants, readable and
// workable only by the service role with one audit row per call, and deleted
// by a confirmed stop. The offline pins are tests/request-to-join-migration.test.js.
import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const EMAIL = "join-request-proof@example.invalid";
const OTHER = "join-request-proof-other@example.invalid";
const ACTOR = "join-request-proof";

function hex(seed) {
  return createHash("sha256").update(`join-request-proof:${seed}`).digest("hex");
}

async function connect() {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "request-to-join-proof",
  });
  await client.connect();
  return client;
}

async function asRole(client, role) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
  if (role !== "postgres") await client.query(`set local role ${role}`);
}

const FIELDS = Object.freeze({
  organization: "Proof Workers Local 12", role: "officer", size: "500-1999", state: "MA",
  phone: "(617) 555-0100", note: "Three sites.", campaign: "flyer-ma",
});

async function submit(client, email, seed, patch = {}) {
  const f = { ...FIELDS, ...patch };
  const { rows } = await client.query(
    "select public.submit_join_request($1, $2, $3, $4, $5, $6, $7, $8, '', $9, $10) as result",
    [email, f.organization, f.role, f.size, f.state, f.phone, f.note, f.campaign, hex(`network:${seed}`), hex(`email:${email}:${seed}`)],
  );
  return rows[0].result;
}

async function list(client, status = null, actor = ACTOR, before = null, beforeId = null) {
  const { rows } = await client.query("select public.list_join_requests($1, $2, $3, $4) as result", [status, actor, before, beforeId]);
  return rows[0].result;
}

async function setStatus(client, id, status, actor = ACTOR) {
  const { rows } = await client.query("select public.set_join_request_status($1, $2, $3) as result", [id, status, actor]);
  return rows[0].result;
}

async function stored(client, email) {
  await asRole(client, "postgres");
  const { rows } = await client.query(
    "select source, interest, locale, status, organization_id, organization_name, role, size_band, state, phone, note, campaign_code from public.public_interest_submissions where email = $1 order by interest",
    [email],
  );
  await asRole(client, "service_role");
  return rows;
}

async function events(client) {
  await asRole(client, "postgres");
  const { rows } = await client.query(
    "select actor, action, status_filter, row_count, request_id, from_status, to_status from private.join_request_access_events order by id",
  );
  await asRole(client, "service_role");
  return rows;
}

async function withCase(run) {
  const client = await connect();
  try {
    await client.query("begin");
    await asRole(client, "postgres");
    await client.query("delete from public.public_interest_submissions where email in ($1, $2)", [EMAIL, OTHER]);
    await client.query("delete from private.join_request_access_events");
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

live("request to join (live)", () => {
  it("stores one request-to-join row per address with the organization fields and no tenant", async () => {
    await withCase(async (client) => {
      expect(await submit(client, EMAIL, "first")).toEqual({ accepted: true, stored: true });
      expect(await stored(client, EMAIL)).toEqual([{
        source: "request-to-join", interest: "request_to_join", locale: "en", status: "new", organization_id: null,
        organization_name: "Proof Workers Local 12", role: "officer", size_band: "500-1999", state: "MA",
        phone: "(617) 555-0100", note: "Three sites.", campaign_code: "flyer-ma",
      }]);
      // A second request from the same address changes nothing and reveals nothing.
      expect(await submit(client, EMAIL, "second", { organization: "Another Name", note: "" })).toEqual({ accepted: true, stored: false });
      expect((await stored(client, EMAIL))[0].organization_name).toBe("Proof Workers Local 12");
      // Optional fields may be empty; the campaign code is lowercased.
      expect(await submit(client, OTHER, "other", { phone: "", note: "", campaign: " FLYER-NH " })).toEqual({ accepted: true, stored: true });
      expect((await stored(client, OTHER))[0]).toMatchObject({ phone: null, note: null, campaign_code: "flyer-nh" });
    });
  });

  // CONTENT-UG-JOIN-FORM-SALES-TONE-20261018 (migration 20261021044810).
  it("stores a request with no size or state as nulls, and still refuses a size or state that is not listed", async () => {
    await withCase(async (client) => {
      expect(await submit(client, EMAIL, "no-size-state", { size: "", state: " " })).toEqual({ accepted: true, stored: true });
      expect((await stored(client, EMAIL))[0]).toMatchObject({ size_band: null, state: null, organization_name: "Proof Workers Local 12" });
      expect(await submit(client, OTHER, "null-size-state", { size: null, state: null })).toEqual({ accepted: true, stored: true });
      expect((await stored(client, OTHER))[0]).toMatchObject({ size_band: null, state: null });
      for (const patch of [{ size: "huge", state: "" }, { size: "", state: "ZZ" }]) {
        expect(await submit(client, "join-request-proof-third@example.invalid", `bad:${JSON.stringify(patch)}`, patch)).toEqual({ accepted: true, stored: false });
      }
      expect(await stored(client, "join-request-proof-third@example.invalid")).toEqual([]);
    });
  });

  it("stores nothing for a stopped address and answers exactly like a stored one", async () => {
    await withCase(async (client) => {
      await asRole(client, "postgres");
      await client.query(
        "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en') on conflict do nothing",
        [EMAIL],
      );
      await asRole(client, "service_role");
      expect(await submit(client, EMAIL, "suppressed")).toEqual({ accepted: true, stored: false });
      expect(await stored(client, EMAIL)).toEqual([]);
    });
  });

  it("refuses an invalid payload silently and keeps the landing path and the row shape apart", async () => {
    await withCase(async (client) => {
      for (const patch of [{ role: "president" }, { state: "ma" }, { size: "huge" }, { organization: "A" }, { campaign: "utm_source=x" }]) {
        expect(await submit(client, EMAIL, `invalid:${JSON.stringify(patch)}`, patch)).toEqual({ accepted: true, stored: false });
      }
      expect(await stored(client, EMAIL)).toEqual([]);
      // A control character in the address is refused by the function too.
      expect(await submit(client, "a\u001b[8m@example.invalid", "invalid:control")).toEqual({ accepted: true, stored: false });
      expect(await stored(client, "a\u001b[8m@example.invalid")).toEqual([]);
      // The landing form cannot write a request-to-join row.
      const { rows } = await client.query(
        "select public.submit_public_interest($1, 'Proof', 'request_to_join', 'en', 'public-landing', '', $2, $3) as result",
        [EMAIL, hex("network:landing"), hex("email-interest:landing")],
      );
      expect(rows[0].result).toEqual({ accepted: true });
      expect(await stored(client, EMAIL)).toEqual([]);
      // And a landing row cannot carry organization fields, nor a request row the landing shape.
      await asRole(client, "postgres");
      await client.query("savepoint shape");
      await expect(client.query(
        "insert into public.public_interest_submissions (email, interest, locale, source, organization_name) values ($1, 'chapter_updates', 'en', 'public-landing', 'Local 12')",
        [EMAIL],
      )).rejects.toThrow(/public_interest_submissions_request_to_join_shape/);
      await client.query("rollback to savepoint shape");
      await expect(client.query(
        "insert into public.public_interest_submissions (email, interest, locale, source) values ($1, 'request_to_join', 'en', 'request-to-join')",
        [EMAIL],
      )).rejects.toThrow(/public_interest_submissions_request_to_join_shape/);
      await client.query("rollback to savepoint shape");
    });
  });

  it("lets the service role list requests, filtered by status, and records one read per call", async () => {
    await withCase(async (client) => {
      await submit(client, EMAIL, "list-a");
      await submit(client, OTHER, "list-b", { organization: "Other Proof Council", state: "outside-us", campaign: "" });
      const all = await list(client);
      expect(all.rowCount).toBe(2);
      // Both rows share one transaction timestamp, so order between them is by id.
      expect(all.requests.map((request) => request.organizationName).sort()).toEqual(["Other Proof Council", "Proof Workers Local 12"]);
      expect(all.requests.find((request) => request.email === EMAIL)).toMatchObject({
        role: "officer", sizeBand: "500-1999", state: "MA", phone: "(617) 555-0100",
        note: "Three sites.", campaignCode: "flyer-ma", status: "new",
      });
      expect(all.requests.find((request) => request.email === OTHER)).toMatchObject({ state: "outside-us", campaignCode: null });
      expect(all.hasMore).toBe(false);
      // The cursor is the page's last row in page order: both rows share one
      // timestamp, so the second part (the id) is what tells them apart.
      expect(all.cursorId).toBe(all.requests[1].id);
      expect(new Date(all.cursorSubmittedAt).getTime()).toBe(new Date(all.requests[1].lastSubmittedAt).getTime());
      // Continuing from the FIRST row reaches the tied second row; continuing
      // from the last row reaches nothing; a cursor before everything reaches both.
      const tied = await list(client, null, ACTOR, all.requests[0].lastSubmittedAt, all.requests[0].id);
      expect(tied.requests.map((row) => row.id)).toEqual([all.requests[1].id]);
      expect(tied).toMatchObject({ rowCount: 1, hasMore: false, cursorId: all.requests[1].id });
      const older = await list(client, null, ACTOR, all.cursorSubmittedAt, all.cursorId);
      expect(older).toMatchObject({ rowCount: 0, requests: [], hasMore: false, cursorSubmittedAt: null, cursorId: null });
      expect((await list(client, null, ACTOR, "2999-01-01T00:00:00Z", "00000000-0000-4000-8000-000000000000")).rowCount).toBe(2);
      await client.query("savepoint half_cursor");
      await expect(list(client, null, ACTOR, all.cursorSubmittedAt, null)).rejects.toThrow(/cursor needs both parts/);
      await client.query("rollback to savepoint half_cursor");
      expect((await list(client, "contacted")).rowCount).toBe(0);
      await client.query("savepoint before_bad");
      await expect(list(client, "answered")).rejects.toThrow(/invalid status/);
      await client.query("rollback to savepoint before_bad");
      expect(await events(client)).toEqual([
        { actor: ACTOR, action: "list", status_filter: null, row_count: 2, request_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "list", status_filter: null, row_count: 1, request_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "list", status_filter: null, row_count: 0, request_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "list", status_filter: null, row_count: 2, request_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "list", status_filter: "contacted", row_count: 0, request_id: null, from_status: null, to_status: null },
      ]);
    });
  });

  it("moves a request through new, contacted and closed with one audit row per change and refuses the rest", async () => {
    await withCase(async (client) => {
      await submit(client, EMAIL, "status");
      const [request] = (await list(client)).requests;
      expect(await setStatus(client, request.id, "contacted")).toEqual({ updated: true, id: request.id, from: "new", status: "contacted" });
      expect(await setStatus(client, request.id, "contacted")).toEqual({ updated: false, refusal: "unchanged", status: "contacted" });
      expect(await setStatus(client, request.id, "closed")).toEqual({ updated: true, id: request.id, from: "contacted", status: "closed" });
      expect(await setStatus(client, "00000000-0000-4000-8000-000000000000", "closed")).toEqual({ updated: false, refusal: "not-found" });
      expect((await stored(client, EMAIL))[0].status).toBe("closed");
      expect((await list(client, "closed")).requests.map((row) => row.id)).toEqual([request.id]);
      expect((await events(client)).filter((event) => event.action === "status")).toEqual([
        { actor: ACTOR, action: "status", status_filter: null, row_count: null, request_id: request.id, from_status: "new", to_status: "contacted" },
        { actor: ACTOR, action: "status", status_filter: null, row_count: null, request_id: request.id, from_status: "contacted", to_status: "closed" },
      ]);
      await client.query("savepoint bad_actor");
      await expect(setStatus(client, request.id, "new", "")).rejects.toThrow(/actor required/);
      await client.query("rollback to savepoint bad_actor");
    });
  });

  it("deletes the request row on a confirmed stop like every other row for the address", async () => {
    await withCase(async (client) => {
      await submit(client, EMAIL, "stop");
      const { rows: requested } = await client.query(
        "select public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4) as result",
        [EMAIL, hex("network:stop"), hex("stop-email:stop"), hex("token:stop")],
      );
      expect(requested[0].result).toEqual({ accepted: true, pending: true });
      const { rows: confirmed } = await client.query(
        "select public.confirm_public_interest_stop($1, $2) as result",
        [hex("token:stop"), hex("network:stop-confirm")],
      );
      expect(confirmed[0].result).toEqual({ confirmed: true });
      expect(await stored(client, EMAIL)).toEqual([]);
      expect(await submit(client, EMAIL, "after-stop")).toEqual({ accepted: true, stored: false });
      expect(await stored(client, EMAIL)).toEqual([]);
    });
  });

  it("keeps the three functions and the ledger away from browser roles and off the tenant reader", async () => {
    await withCase(async (client) => {
      await submit(client, EMAIL, "roles");
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        await client.query("savepoint role_probe");
        await expect(submit(client, OTHER, `roles:${role}`)).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint role_probe");
        await expect(list(client)).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint role_probe");
        await expect(setStatus(client, "00000000-0000-4000-8000-000000000000", "closed")).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint role_probe");
        await expect(client.query("select count(*) from private.join_request_access_events")).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint role_probe");
        await expect(client.query("select count(*) from public.public_interest_submissions")).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint role_probe");
      }
      await asRole(client, "service_role");
      await client.query("savepoint service_probe");
      await expect(client.query("select count(*) from private.join_request_access_events")).rejects.toThrow(/permission denied/);
      await client.query("rollback to savepoint service_probe");
      // The row has no tenant, so no organization's lead list can contain it.
      await asRole(client, "postgres");
      const { rows } = await client.query(
        "select count(*)::int as n from public.public_interest_submissions where email = $1 and organization_id is not null",
        [EMAIL],
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
