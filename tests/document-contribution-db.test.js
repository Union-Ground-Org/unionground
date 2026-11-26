// @vitest-environment node
// REQ-UG-UNION-DOCUMENT-INTAKE-PAGE-20261022: live proof on the
// disposable stack that a /contribute submission is stored only through the
// service-only begin function behind the landing limiter and the suppression
// check; that a file counts as received only after a clean verdict recorded
// through a receipt-bound, three-attempt lease on the stored object; that the
// owner reads and works the queue with one audit row per call; and that no
// browser role reaches the tables, the functions or the private bucket.
// Also exercises the outreach code writer and lookup, the code and chosen
// organization on the submission, notification preference and 40-file limit.
import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const EMAIL = "document-contribution-proof@example.invalid";
const OTHER = "document-contribution-proof-other@example.invalid";
const ACTOR = "document-contribution-proof";
const BUCKET = "union-document-contributions";
const PDF = "application/pdf";

function hex(seed) {
  return createHash("sha256").update(`document-contribution-proof:${seed}`).digest("hex");
}

async function connect() {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "document-contribution-proof",
  });
  await client.connect();
  return client;
}

async function asRole(client, role) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
  if (role !== "postgres") await client.query(`set local role ${role}`);
}

const FILES = Object.freeze([
  { name: "contract.pdf", kind: "contract", mime: PDF, size: 2048 },
  { name: "grievance.pdf", kind: "grievance-form", mime: PDF, size: 512 },
]);

async function begin(client, email, seed, patch = {}) {
  const f = {
    organization: "Proof Workers Local 12", affiliation: "Proof Council", state: "MA", contact: "Pat Proof",
    role: "officer", notes: "Two documents.", attested: true, permitted: true, files: FILES, website: "",
    code: null, choice: null, notify: "email", phone: null, address: null, ...patch,
  };
  const { rows } = await client.query(
    `select public.begin_union_document_contribution($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19) as result`,
    [email, f.organization, f.affiliation, f.state, f.contact, f.role, f.notes, f.attested, f.permitted,
      JSON.stringify(f.files), hex(`receipt:${seed}`), f.website, hex(`network:${seed}`), hex(`email:${email.trim().toLowerCase()}`),
      f.code, f.choice, f.notify, f.phone, f.address],
  );
  return rows[0].result;
}

async function authorize(client, contributionId, fileId, receiptSeed, seed = "inspect") {
  const { rows } = await client.query(
    "select public.authorize_union_document_file_inspection($1, $2, $3, $4) as result",
    [contributionId, fileId, hex(`receipt:${receiptSeed}`), hex(`inspect-network:${seed}`)],
  );
  return rows[0].result;
}

async function finish(client, attemptId, verdict, provenance = true) {
  const now = new Date().toISOString();
  const { rows } = await client.query(
    "select public.finish_union_document_file_inspection($1, $2, $3, $4, $5, $6, $7) as result",
    provenance
      ? [attemptId, verdict, hex(`bytes:${attemptId}`), "ClamAV 1.5.4", 28113, now, now]
      : [attemptId, verdict, null, null, null, null, null],
  );
  return rows[0].result;
}

// Storage writes the object row when the browser's signed upload lands; the
// proof writes the same row as the database owner.
async function storeObject(client, objectPath, { size, mimetype = PDF }) {
  await asRole(client, "postgres");
  await client.query(
    "insert into storage.objects (bucket_id, name, version, metadata) values ($1, $2, 'proof-v1', $3::jsonb)",
    [BUCKET, objectPath, JSON.stringify({ size, mimetype })],
  );
  await asRole(client, "service_role");
}

// Synthetic outreach codes: never real organization data.
const CODES = Object.freeze([
  { code: "PRFS2345", kind: "single", channel: "mail", orgs: [{ body_id: "proof-1001", display_name: "Proof Workers Local 12" }] },
  { code: "PRFM2345", kind: "shared", channel: "mail", orgs: [
    { body_id: "proof-2001", display_name: "Proof Nurses Local 7" },
    { body_id: "proof-2002", display_name: null },
    { body_id: "proof-2003", display_name: "Proof Retirees Chapter" },
  ] },
  { code: "PRFN2345", kind: "single", channel: "email", orgs: [{ body_id: "proof-3001", display_name: null }] },
]);

async function upsertCodes(client, codes) {
  const { rows: result } = await client.query("select public.upsert_union_outreach_codes($1::jsonb) as result", [JSON.stringify(codes)]);
  return result[0].result;
}

async function lookupCode(client, code, seed = "lookup") {
  const { rows: result } = await client.query("select public.lookup_union_outreach_code($1, $2) as result", [code, hex(`lookup-network:${seed}`)]);
  return result[0].result;
}

async function rows(client, sql, params = []) {
  await asRole(client, "postgres");
  const result = await client.query(sql, params);
  await asRole(client, "service_role");
  return result.rows;
}

async function list(client, status = null, actor = ACTOR, before = null, beforeId = null) {
  const { rows: result } = await client.query("select public.list_union_document_contributions($1, $2, $3, $4) as result", [status, actor, before, beforeId]);
  return result[0].result;
}

async function setStatus(client, id, status, notes = null, actor = ACTOR) {
  const { rows: result } = await client.query("select public.set_union_document_contribution_status($1, $2, $3, $4) as result", [id, status, actor, notes]);
  return result[0].result;
}

async function withCase(run) {
  const client = await connect();
  try {
    await client.query("begin");
    await asRole(client, "postgres");
    await client.query("delete from public.union_document_contributions where contact_email like 'document-contribution-proof%@example.invalid'");
    await client.query("delete from private.union_document_contribution_access_events");
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function expectRefused(client, query, pattern) {
  await client.query("savepoint refused");
  await expect(query()).rejects.toThrow(pattern);
  await client.query("rollback to savepoint refused");
}

live("union document contributions (live)", () => {
  it("installs a private bucket with the eight formats and 10 MiB", async () => {
    await withCase(async (client) => {
      const [bucket] = await rows(client, "select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [BUCKET]);
      expect(bucket.public).toBe(false);
      expect(Number(bucket.file_size_limit)).toBe(10485760);
      expect([...bucket.allowed_mime_types].sort()).toEqual([
        "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg", "image/png", "image/webp", "text/csv", "text/plain",
      ]);
    });
  });

  it("stores a submission with one pending file per declared file at server-chosen paths", async () => {
    await withCase(async (client) => {
      const result = await begin(client, " Document-Contribution-Proof@Example.Invalid ", "store", { notes: "Two documents.\r\nBlank." });
      expect(result).toMatchObject({ accepted: true, stored: true });
      expect(result.files.map((file) => file.position)).toEqual([1, 2]);
      for (const file of result.files) expect(file.objectPath).toBe(`${result.contributionId}/${file.fileId}`);
      const [contribution] = await rows(client, "select * from public.union_document_contributions where id = $1", [result.contributionId]);
      expect(contribution).toMatchObject({
        organization_name: "Proof Workers Local 12", affiliation: "Proof Council", state: "MA", contact_name: "Pat Proof",
        contact_role: "officer", contact_email: EMAIL, notes: "Two documents.\nBlank.", blank_forms_attested: true,
        permission_granted: true, source: "contribute-page", status: "pending", file_count: 2, receipt_hash: hex("receipt:store"),
      });
      const files = await rows(client, "select position, original_name, declared_kind, mime, size_bytes, inspection_status, inspection_attempts from public.union_document_contribution_files where contribution_id = $1 order by position", [result.contributionId]);
      expect(files).toEqual([
        { position: 1, original_name: "contract.pdf", declared_kind: "contract", mime: PDF, size_bytes: 2048, inspection_status: "pending", inspection_attempts: 0 },
        { position: 2, original_name: "grievance.pdf", declared_kind: "grievance-form", mime: PDF, size_bytes: 512, inspection_status: "pending", inspection_attempts: 0 },
      ]);
    });
  });

  it("refuses an invalid submission, answers a honeypot without a row, bounds the address per day and answers a stopped address exactly like any other", async () => {
    await withCase(async (client) => {
      for (const patch of [
        { attested: false }, { permitted: null }, { files: [] }, { state: "ma" }, { role: "boss" },
        { files: Array.from({ length: 41 }, () => FILES[0]) },
        { notify: null }, { notify: "pigeon" }, { notify: "text" }, { notify: "text", phone: "6175550123" },
        { notify: "email", phone: "+16175550123" }, { notify: "mail" }, { notify: "mail", address: "Boston" },
        { notify: "mail", address: "x".repeat(301) }, { notify: "text", phone: "+16175550123", address: "12 Proof Street, Boston MA" },
        { code: "ABCD1234" }, { choice: 1 }, { code: "PRFS2345", choice: 0 },
        { files: [{ ...FILES[0], size: 10485761 }] },
        { files: [{ ...FILES[0], size: "12x" }] },
        { files: [{ ...FILES[0], mime: "application/x-msdownload" }] },
        { files: [{ ...FILES[0], name: "../contract.pdf" }] },
        { files: [{ ...FILES[0], kind: "minutes" }] },
      ]) {
        await expectRefused(client, () => begin(client, EMAIL, `invalid:${JSON.stringify(patch)}`, patch), /invalid contribution/);
      }
      expect(await begin(client, EMAIL, "honeypot", { website: "spam.example" })).toEqual({ accepted: true, stored: false, files: [] });
      for (let index = 0; index < 5; index += 1) {
        expect((await begin(client, EMAIL, `day:${index}`)).stored).toBe(true);
      }
      expect(await begin(client, EMAIL, "day:5")).toEqual({ accepted: false, refusal: "rate-limited" });
      await asRole(client, "postgres");
      await client.query(
        "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en') on conflict do nothing",
        [OTHER],
      );
      await asRole(client, "service_role");
      // The answer for a stopped address
      // has the same shape as any other, so nobody can test an address
      // against the private ledger; only the row records the stop.
      const stopped = await begin(client, OTHER, "suppressed");
      const open = await begin(client, "document-contribution-proof-open@example.invalid", "open");
      expect(Object.keys(stopped).sort()).toEqual(Object.keys(open).sort());
      expect(stopped).toMatchObject({ accepted: true, stored: true });
      expect(stopped.files.map((file) => file.position)).toEqual([1, 2]);
      expect(await rows(client, "select contact_email, contact_suppressed from public.union_document_contributions where id = any($1::uuid[]) order by contact_suppressed", [[stopped.contributionId, open.contributionId]])).toEqual([
        { contact_email: "document-contribution-proof-open@example.invalid", contact_suppressed: false },
        { contact_email: OTHER, contact_suppressed: true },
      ]);
      expect((await list(client)).contributions.find((row) => row.id === stopped.contributionId).contactSuppressed).toBe(true);
      // A stop confirmed after the submission is listed too (#5729 pre-review
      // P2, comment 6424356892); the stored row keeps its submission-time flag.
      const contributed = (await list(client)).contributions.find((row) => row.id === open.contributionId);
      expect(contributed.contactSuppressed).toBe(false);
      await asRole(client, "postgres");
      await client.query(
        "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en') on conflict do nothing",
        ["document-contribution-proof-open@example.invalid"],
      );
      await asRole(client, "service_role");
      expect((await list(client)).contributions.find((row) => row.id === open.contributionId).contactSuppressed).toBe(true);
      expect(await rows(client, "select contact_suppressed from public.union_document_contributions where id = $1", [open.contributionId]))
        .toEqual([{ contact_suppressed: false }]);
    });
  });

  it("stores up to 40 files and the notification preference with its one contact value", async () => {
    await withCase(async (client) => {
      const forty = Array.from({ length: 40 }, (_, index) => ({ ...FILES[0], name: `form-${index + 1}.pdf`, size: 10485760 }));
      const many = await begin(client, EMAIL, "forty", { files: forty });
      expect(many.files.map((file) => file.position)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      const text = await begin(client, EMAIL, "text", { notify: "text", phone: "+16175550123" });
      const mail = await begin(client, EMAIL, "mail", { notify: "mail", address: " 12 Proof Street\r\nBoston, MA 02108 " });
      expect(await rows(client, "select id, file_count, notify_via, notify_phone, notify_mail_address, outreach_code, outreach_body_id from public.union_document_contributions where id = any($1::uuid[])", [[many.contributionId, text.contributionId, mail.contributionId]]))
        .toEqual(expect.arrayContaining([
          { id: many.contributionId, file_count: 40, notify_via: "email", notify_phone: null, notify_mail_address: null, outreach_code: null, outreach_body_id: null },
          { id: text.contributionId, file_count: 2, notify_via: "text", notify_phone: "+16175550123", notify_mail_address: null, outreach_code: null, outreach_body_id: null },
          { id: mail.contributionId, file_count: 2, notify_via: "mail", notify_phone: null, notify_mail_address: "12 Proof Street\nBoston, MA 02108", outreach_code: null, outreach_body_id: null },
        ]));
      const listed = (await list(client)).contributions.find((row) => row.id === text.contributionId);
      expect(listed).toMatchObject({ notifyVia: "text", notifyPhone: "+16175550123", notifyMailAddress: null, outreachCode: null, outreachBodyId: null });
      // The table itself refuses a preference without its contact value.
      await asRole(client, "postgres");
      await expectRefused(client, () => client.query("update public.union_document_contributions set notify_via = 'mail' where id = $1", [text.contributionId]), /union_document_contributions_notify_shape/);
      await asRole(client, "service_role");
    });
  });

  it("imports outreach codes only through the service-only writer, all or nothing, and updates only what changed", async () => {
    await withCase(async (client) => {
      expect(await upsertCodes(client, CODES)).toEqual({ inserted: 3, updated: 0, unchanged: 0 });
      expect(await upsertCodes(client, CODES)).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
      const renamed = [{ ...CODES[0], orgs: [{ body_id: "proof-1001", display_name: "  Proof Workers Local 12A  " }] }];
      expect(await upsertCodes(client, renamed)).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
      expect(await rows(client, "select kind, channel, orgs from private.union_outreach_codes where code = 'PRFS2345'"))
        .toEqual([{ kind: "single", channel: "mail", orgs: [{ body_id: "proof-1001", display_name: "Proof Workers Local 12A" }] }]);
      for (const batch of [
        [],
        [{ ...CODES[0], code: "PRFS234O" }],
        [{ ...CODES[0], code: "prfs2345" }],
        [{ ...CODES[0], kind: "shared" }],
        [{ ...CODES[1], kind: "single" }],
        [{ ...CODES[0], channel: "phone" }],
        [{ ...CODES[0], orgs: [{ body_id: "Proof 1001", display_name: "Proof Workers Local 12" }] }],
        [{ ...CODES[0], orgs: [{ body_id: "proof-1001", display_name: "P" }] }],
        [{ ...CODES[0], orgs: [{ body_id: "proof-1001", display_name: "Proof\u0007Local" }] }],
        [{ ...CODES[0], orgs: [{ body_id: "proof-1001", display_name: "Proof Workers Local 12", address: "12 Proof Street" }] }],
        [{ ...CODES[0], code: "PRFT2345" }, { ...CODES[0], code: "PRFT2345" }],
        [{ ...CODES[0], code: "PRFU2345" }, { ...CODES[0], code: "PRFV2345", orgs: [] }],
      ]) {
        await expectRefused(client, () => upsertCodes(client, batch), /invalid outreach codes/);
      }
      // A visitor's choice is a position: a refresh may rename and append, but
      // never move or drop a body_id an existing code holds.
      const [nurses, unnamedOrg, retirees] = CODES[1].orgs;
      expect(await upsertCodes(client, [{ ...CODES[1], orgs: [nurses, unnamedOrg, retirees, { body_id: "proof-2004", display_name: "Proof Clerks Unit" }] }]))
        .toEqual({ inserted: 0, updated: 1, unchanged: 0 });
      for (const orgs of [[retirees, unnamedOrg, nurses], [nurses, unnamedOrg], [nurses, { ...unnamedOrg, body_id: "proof-2999" }, retirees]]) {
        await expectRefused(client, () => upsertCodes(client, [{ ...CODES[1], orgs }]), /outreach code remapped/);
      }
      await expectRefused(client, () => upsertCodes(client, [{ code: "PRFW2345", kind: "single", channel: "mail", orgs: [nurses] }, { ...CODES[0], orgs: [{ body_id: "proof-1999", display_name: "Proof Other" }] }]), /outreach code remapped/);
      // A refused batch wrote nothing, not even its valid entries.
      expect(await rows(client, "select code from private.union_outreach_codes where code like 'PRF%' order by code")).toEqual([
        { code: "PRFM2345" }, { code: "PRFN2345" }, { code: "PRFS2345" },
      ]);
    });
  });

  // Two imports of one code may not both validate against the same positions
  // and then overwrite each other's appended organization (gate round 2, Sol
  // r2s1). The sessions must commit to see each other, so the case removes
  // its own codes afterwards.
  it("serializes concurrent imports of one code so a later import never overwrites an earlier append", async () => {
    const RACE = ["RACE2345", "RACF2345"];
    const org = (n) => ({ body_id: `proof-${n}`, display_name: `Proof Race Local ${n}` });
    const shared = (code, ns) => ({ code, kind: "shared", channel: "mail", orgs: ns.map(org) });
    const admin = await connect();
    const sessions = [];
    const session = async () => {
      const client = await connect();
      sessions.push(client);
      await client.query("begin");
      await asRole(client, "service_role");
      return client;
    };
    const pid = async (client) => (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
    const waitsOnAdvisoryLock = async (backend) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const { rows: [activity] } = await admin.query("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [backend]);
        if (activity?.wait_event_type === "Lock") return activity.wait_event;
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      return null;
    };
    const stored = async (code) => (await admin.query("select orgs from private.union_outreach_codes where code = $1", [code]))
      .rows[0]?.orgs.map((entry) => entry.body_id);
    try {
      await admin.query("delete from private.union_outreach_codes where code = any($1)", [RACE]);
      const seed = await session();
      expect(await upsertCodes(seed, [shared(RACE[0], [101, 102])])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
      await seed.query("commit");

      // Both append to the same two positions; the second waits on the first's lock.
      for (const [code, first, second, held] of [
        [RACE[0], [101, 102, 103], [101, 102, 104], ["proof-101", "proof-102", "proof-103"]],
        [RACE[1], [201, 202], [301, 302], ["proof-201", "proof-202"]],
      ]) {
        const a = await session();
        const b = await session();
        await upsertCodes(a, [shared(code, first)]);
        const waiting = await pid(b);
        const later = upsertCodes(b, [shared(code, second)]).then(() => null, (error) => error);
        expect(await waitsOnAdvisoryLock(waiting)).toBe("advisory");
        await a.query("commit");
        expect((await later)?.message).toMatch(/outreach code remapped/);
        await b.query("rollback");
        expect(await stored(code)).toEqual(held);
      }
    } finally {
      await Promise.all(sessions.map((client) => client.query("rollback").catch(() => {}).then(() => client.end())));
      await admin.query("delete from private.union_outreach_codes where code = any($1)", [RACE]).catch(() => {});
      await admin.end();
    }
  }, 30_000);

  it("looks a code up behind its own limiter and answers display names and positions only", async () => {
    await withCase(async (client) => {
      await upsertCodes(client, CODES);
      expect(await lookupCode(client, "prfs-2345")).toEqual({ kind: "single", organizations: [{ choice: 1, name: "Proof Workers Local 12" }] });
      const shared = await lookupCode(client, "PRFM 2345");
      expect(shared).toEqual({ kind: "shared", organizations: [{ choice: 1, name: "Proof Nurses Local 7" }, { choice: 3, name: "Proof Retirees Chapter" }] });
      expect(JSON.stringify(shared)).not.toContain("proof-2");
      // Unknown, and known with no displayable organization: the same answer as no code.
      expect(await lookupCode(client, "PRFZ2345")).toEqual({ kind: null, organizations: [] });
      expect(await lookupCode(client, "PRFN2345")).toEqual({ kind: null, organizations: [] });
      await expectRefused(client, () => lookupCode(client, "PRFS234O"), /invalid outreach code/);
      for (let index = 0; index < 30; index += 1) expect((await lookupCode(client, "PRFZ2345", "burst")).refusal).toBeUndefined();
      expect(await lookupCode(client, "PRFS2345", "burst")).toEqual({ refusal: "rate-limited" });
    });
  });

  it("stores a known code with the chosen organization's body_id and name, and gives a shared code a larger daily allowance", async () => {
    await withCase(async (client) => {
      await upsertCodes(client, CODES);
      const single = await begin(client, EMAIL, "code-single", { organization: "Typed Name", code: "prfs-2345", choice: 1 });
      const typed = await begin(client, EMAIL, "code-typed", { organization: "Proof Typed Local", code: "PRFS2345" });
      const unnamed = await begin(client, EMAIL, "code-unnamed", { organization: "Proof Typed Unit", code: "PRFM2345", choice: 2 });
      const unknown = await begin(client, EMAIL, "code-unknown", { code: "PRFZ2345", choice: 1 });
      expect(await rows(client, "select id, organization_name, outreach_code, outreach_body_id from public.union_document_contributions where id = any($1::uuid[])", [[single.contributionId, typed.contributionId, unnamed.contributionId, unknown.contributionId]]))
        .toEqual(expect.arrayContaining([
          { id: single.contributionId, organization_name: "Proof Workers Local 12", outreach_code: "PRFS2345", outreach_body_id: "proof-1001" },
          { id: typed.contributionId, organization_name: "Proof Typed Local", outreach_code: "PRFS2345", outreach_body_id: null },
          { id: unnamed.contributionId, organization_name: "Proof Typed Unit", outreach_code: "PRFM2345", outreach_body_id: null },
          { id: unknown.contributionId, organization_name: "Proof Workers Local 12", outreach_code: null, outreach_body_id: null },
        ]));
      expect((await list(client)).contributions.find((row) => row.id === single.contributionId))
        .toMatchObject({ outreachCode: "PRFS2345", outreachBodyId: "proof-1001" });
      // One officer may send one submission per organization at a shared address.
      for (let index = 0; index < 25; index += 1) {
        expect((await begin(client, OTHER, `shared-day:${index}`, { code: "PRFM2345", choice: (index % 2) * 2 + 1 })).stored).toBe(true);
      }
      expect(await begin(client, OTHER, "shared-day:25", { code: "PRFM2345", choice: 1 })).toEqual({ accepted: false, refusal: "rate-limited" });
    });
  });

  it("counts a file received only after a clean verdict on a live lease for the stored object", async () => {
    await withCase(async (client) => {
      const { contributionId, files: [first, second] } = await begin(client, EMAIL, "lease");
      // The per-network budget covers 40-file submissions: 600 per 15 minutes,
      // not 60.
      for (let index = 0; index < 600; index += 1) {
        expect(await authorize(client, contributionId, "00000000-0000-4000-8000-000000000000", "lease", "budget")).toEqual({ refusal: "not-found" });
      }
      expect(await authorize(client, contributionId, first.fileId, "lease", "budget")).toEqual({ refusal: "rate-limited" });
      // A wrong receipt, an unknown file and a missing upload spend no attempt.
      expect(await authorize(client, contributionId, first.fileId, "other")).toEqual({ refusal: "not-found" });
      expect(await authorize(client, contributionId, "00000000-0000-4000-8000-000000000000", "lease")).toEqual({ refusal: "not-found" });
      expect(await authorize(client, contributionId, first.fileId, "lease")).toEqual({ refusal: "not-uploaded" });
      await storeObject(client, first.objectPath, { size: 2048 });
      const lease = await authorize(client, contributionId, first.fileId, "lease");
      expect(lease).toMatchObject({ fileId: first.fileId, bucketId: BUCKET, objectName: first.objectPath, filename: "contract.pdf", mimeType: PDF, sizeBytes: 2048 });
      expect(await authorize(client, contributionId, first.fileId, "lease")).toEqual({ refusal: "busy" });
      // A clean verdict without provenance is refused; a stale attempt records nothing.
      await expectRefused(client, () => finish(client, lease.attemptId, "clean", false), /clean verdict needs scanner provenance/);
      expect(await finish(client, "00000000-0000-4000-8000-000000000000", "clean")).toEqual({ recorded: false, refusal: "stale" });
      expect((await rows(client, "select status from public.union_document_contributions where id = $1", [contributionId]))[0].status).toBe("pending");
      expect(await finish(client, lease.attemptId, "clean")).toEqual({ recorded: true, fileId: first.fileId, status: "clean" });
      const [row] = await rows(client, "select inspection_status, sha256, scan_engine, storage_object_id, inspection_attempts, inspection_attempt_id from public.union_document_contribution_files where id = $1", [first.fileId]);
      expect(row).toMatchObject({ inspection_status: "clean", sha256: hex(`bytes:${lease.attemptId}`), scan_engine: "ClamAV 1.5.4", storage_object_id: lease.objectId, inspection_attempts: 1, inspection_attempt_id: null });
      expect((await rows(client, "select status from public.union_document_contributions where id = $1", [contributionId]))[0].status).toBe("received");
      // A decided file is answered from the record and cannot be re-leased.
      expect(await authorize(client, contributionId, first.fileId, "lease")).toEqual({ fileId: first.fileId, status: "clean" });
      expect(await finish(client, lease.attemptId, "blocked", false)).toEqual({ recorded: false, refusal: "stale" });

      // Bytes whose stored size disagrees with the declaration are blocked unscanned.
      await storeObject(client, second.objectPath, { size: 999 });
      expect(await authorize(client, contributionId, second.fileId, "lease")).toEqual({ fileId: second.fileId, status: "blocked" });
      expect((await rows(client, "select inspection_status, inspection_attempts from public.union_document_contribution_files where id = $1", [second.fileId]))[0])
        .toEqual({ inspection_status: "blocked", inspection_attempts: 0 });
    });
  });

  it("allows three failed attempts, then reports the file exhausted and never received", async () => {
    await withCase(async (client) => {
      const { contributionId, files: [first] } = await begin(client, EMAIL, "exhaust", { files: [FILES[0]] });
      await storeObject(client, first.objectPath, { size: 2048 });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const lease = await authorize(client, contributionId, first.fileId, "exhaust", `exhaust:${attempt}`);
        expect(lease.attemptId).toBeTruthy();
        expect(await finish(client, lease.attemptId, "failed", false)).toEqual({ recorded: true, fileId: first.fileId, status: "failed" });
      }
      expect(await authorize(client, contributionId, first.fileId, "exhaust", "exhaust:4")).toEqual({ fileId: first.fileId, status: "failed", refusal: "exhausted" });
      expect((await rows(client, "select status from public.union_document_contributions where id = $1", [contributionId]))[0].status).toBe("pending");
      // A clean verdict whose bound object was replaced records failed, not clean.
      const other = await begin(client, EMAIL, "replaced", { files: [FILES[0]] });
      await storeObject(client, other.files[0].objectPath, { size: 2048 });
      const lease = await authorize(client, other.contributionId, other.files[0].fileId, "replaced", "replaced");
      // The Storage API's own delete path sets this guard for its statement.
      await rows(client, "select set_config('storage.allow_delete_query', 'true', true)");
      await rows(client, "delete from storage.objects where bucket_id = $1 and name = $2", [BUCKET, other.files[0].objectPath]);
      expect(await finish(client, lease.attemptId, "clean")).toEqual({ recorded: true, fileId: other.files[0].fileId, status: "failed" });
    });
  });

  it("lets the owner list submissions with file verdicts and move them, one audit row per call", async () => {
    await withCase(async (client) => {
      const { contributionId, files: [first] } = await begin(client, EMAIL, "owner");
      // A pending submission can only be declined.
      expect(await setStatus(client, contributionId, "reviewed")).toEqual({ updated: false, refusal: "no-clean-file", status: "pending" });
      await storeObject(client, first.objectPath, { size: 2048 });
      const lease = await authorize(client, contributionId, first.fileId, "owner");
      await finish(client, lease.attemptId, "clean");
      const page = await list(client);
      expect(page).toMatchObject({ rowCount: 1, hasMore: false, cursorId: contributionId });
      expect(page.contributions[0]).toMatchObject({
        id: contributionId, organizationName: "Proof Workers Local 12", contactEmail: EMAIL, status: "received",
        blankFormsAttested: true, permissionGranted: true,
      });
      expect(page.contributions[0].files.map((file) => [file.originalName, file.inspectionStatus])).toEqual([["contract.pdf", "clean"], ["grievance.pdf", "pending"]]);
      expect(await setStatus(client, contributionId, "reviewed", "Contract is the 2024 agreement.")).toEqual({ updated: true, id: contributionId, from: "received", status: "reviewed" });
      expect(await setStatus(client, contributionId, "reviewed")).toEqual({ updated: false, refusal: "unchanged", status: "reviewed" });
      expect(await setStatus(client, contributionId, "digitized")).toMatchObject({ updated: true, from: "reviewed", status: "digitized" });
      expect((await list(client, "digitized")).contributions[0].reviewerNotes).toBe("Contract is the 2024 agreement.");
      expect((await list(client, "pending")).rowCount).toBe(0);
      await expectRefused(client, () => setStatus(client, contributionId, "pending"), /invalid status/);
      await expectRefused(client, () => list(client, null, ""), /actor required/);
      await expectRefused(client, () => list(client, null, ACTOR, page.cursorCreatedAt, null), /cursor needs both parts/);
      expect(await rows(client, "select actor, action, status_filter, row_count, contribution_id, from_status, to_status from private.union_document_contribution_access_events order by id")).toEqual([
        { actor: ACTOR, action: "list", status_filter: null, row_count: 1, contribution_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "status", status_filter: null, row_count: null, contribution_id: contributionId, from_status: "received", to_status: "reviewed" },
        { actor: ACTOR, action: "status", status_filter: null, row_count: null, contribution_id: contributionId, from_status: "reviewed", to_status: "digitized" },
        { actor: ACTOR, action: "list", status_filter: "digitized", row_count: 1, contribution_id: null, from_status: null, to_status: null },
        { actor: ACTOR, action: "list", status_filter: "pending", row_count: 0, contribution_id: null, from_status: null, to_status: null },
      ]);
    });
  });

  it("keeps the functions, the tables, the ledger and the bucket away from browser roles", async () => {
    await withCase(async (client) => {
      const { files: [first] } = await begin(client, EMAIL, "roles");
      await storeObject(client, first.objectPath, { size: 2048 });
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        await expectRefused(client, () => begin(client, OTHER, `roles:${role}`), /permission denied/);
        await expectRefused(client, () => authorize(client, first.fileId, first.fileId, "roles"), /permission denied/);
        await expectRefused(client, () => list(client), /permission denied/);
        await expectRefused(client, () => setStatus(client, first.fileId, "declined"), /permission denied/);
        await expectRefused(client, () => upsertCodes(client, CODES), /permission denied/);
        await expectRefused(client, () => lookupCode(client, "PRFS2345"), /permission denied/);
        for (const table of ["public.union_document_contributions", "public.union_document_contribution_files", "private.union_document_contribution_access_events", "private.union_outreach_codes"]) {
          await expectRefused(client, () => client.query(`select count(*) from ${table}`), /permission denied/);
        }
        // No storage.objects policy admits the bucket: nothing is visible or writable.
        await client.query("savepoint storage_probe");
        try {
          const { rows: visible } = await client.query("select count(*)::int as n from storage.objects where bucket_id = $1", [BUCKET]);
          expect(visible[0].n).toBe(0);
        } catch (error) {
          expect(String(error?.message)).toMatch(/permission denied/);
        }
        await client.query("rollback to savepoint storage_probe");
        await expectRefused(client, () => client.query(
          "insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{}'::jsonb)", [BUCKET, `${role}/probe`],
        ), /row-level security|permission denied/);
      }
      await asRole(client, "service_role");
      await expectRefused(client, () => client.query("select count(*) from public.union_document_contributions"), /permission denied/);
      await expectRefused(client, () => client.query("select count(*) from private.union_outreach_codes"), /permission denied/);
    });
  });
});
