// @vitest-environment node
//
// Required disposable-database proof for
// REQ-UG-DOCUMENT-CONVERSION-PROVENANCE-20260904.
//
// The record asks for something a schema diff cannot demonstrate: that an
// operator can reproduce how a document became model-grounding content, months
// later, during a dispute. That claim rests on four database behaviours, and
// each is executed here against a real disposable Postgres rather than
// described:
//
//   1. the ledger DERIVES the attempt number and the change kind, so a handler
//      cannot relabel a changed source as a retry;
//   2. a written row cannot be altered, and a review cannot be overwritten;
//   3. conversion metadata cannot carry document text;
//   4. the reviewer is auth.uid() under MFA, and one organization's staff
//      cannot read another's provenance.
//
// Style follows tests/private-file-workflow-gates-db.test.js: one pg.Client,
// begin/rollback-only fixtures, set_config('request.jwt.claims') plus
// `set local role` to switch identity, and a savepoint-wrapped denied() helper
// that asserts SQLSTATE so a MISSING function is a red test, not a silent skip.
import { reviewStewardLibraryFile, publishStewardLibraryFile, restoreKnowledgeRevision } from "../src/features/knowledge/knowledgeApi.js";
import { saveChapterKnowledgeArticle } from "../src/lib/memberApi.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_KNOWLEDGE_CONVERSION_PROVENANCE_DB_TESTS === "1" ? it : it.skip;
const record = "select public.record_knowledge_conversion($1,$2,$3,$4::jsonb) value";
const review = "select public.review_knowledge_conversion($1,$2) value";
const reject = "select public.reject_knowledge_conversion($1,$2,$3) value";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "c".repeat(64);

function connect() {
  return new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: "knowledge-conversion-provenance-proof",
  });
}

function makeIds() {
  const ids = Object.fromEntries([
    "owner", "reviewer", "outsider", "ownerSession", "reviewerSession", "outsiderSession",
    "org", "otherOrg", "file", "source",
  ].map((key) => [key, randomUUID()]));
  ids.chapter = `conv-${ids.org}`;
  return ids;
}

function harness(client, ids) {
  const role = async (name, actor = ids.owner, session = ids.ownerSession, aal = "aal2") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: name, sub: actor, session_id: session, aal }),
    ]);
    await client.query(`set local role ${name}`);
  };
  let savepoint = 0;
  const denied = async (statement, params, expected = "42501") => {
    const label = `conv_denied_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
    }
    expect(caught, `expected SQLSTATE ${expected} from: ${statement}`).toBeTruthy();
    expect(caught.code, `${statement} -> ${caught.message}`).toBe(expected);
    return caught.message;
  };
  return { role, denied };
}

async function seed(client, ids, role) {
  await role("postgres");
  for (const [user, session] of [
    [ids.owner, ids.ownerSession],
    [ids.reviewer, ids.reviewerSession],
    [ids.outsider, ids.outsiderSession],
  ]) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic conversion factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `conv-proof-${org}`, ids.owner]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
  }
  await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9911)", [ids.chapter, ids.org]);
  for (const [user, grant] of [[ids.owner, "admin"], [ids.reviewer, "steward"]]) {
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, ids.chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, user, grant]);
  }
  // Staff of a DIFFERENT organization. Tenant isolation has to be proved against
  // somebody who really is staff somewhere, not against an anonymous caller.
  await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.otherOrg, ids.outsider]);
  await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [ids.otherOrg, ids.outsider]);

  await role("authenticated", ids.owner, ids.ownerSession);
  const prepared = (await client.query(
    "select public.prepare_steward_library_upload('agreement.pdf',9,$1,'Synthetic agreement','Conversion provenance proof','contract',$2,$3) value",
    [DIGEST_A, randomUUID(), ids.chapter],
  )).rows[0].value;
  await role("postgres");
  await client.query(
    "insert into public.organization_knowledge_sources(id,organization_id,file_id,source_kind,label,doc_type)"
    + " values($1,$2,$3,'steward_file','Synthetic agreement','contract')",
    [ids.source, ids.org, prepared.fileId],
  );
  ids.file = prepared.fileId;
  return { fileId: prepared.fileId, storageHandle: prepared.storageHandle };
}

function payload(overrides = {}) {
  return JSON.stringify({
    sourceSha256: DIGEST_A,
    sourceByteSize: 9,
    sourceFormat: "pdf",
    converterName: "unpdf",
    converterVersion: "1.8.1",
    pipelineVersion: "2026.09.06",
    outcome: "succeeded",
    metadata: { inputBytes: 9, outputCharacters: 120, chunkCount: 1 },
    ...overrides,
  });
}

// Read as the table owner. The ledger grants SELECT to `authenticated` only --
// service_role deliberately has no table privilege at all, because every write
// goes through a security-definer RPC -- so an internal assertion has to reset
// the role rather than assume the writing identity can read back.
async function conversions(client, ids) {
  await client.query("reset role");
  return (await client.query(
    "select attempt, change_kind, outcome, source_sha256, converter_version, error_code"
    + " from public.organization_knowledge_conversions where source_id=$1 order by attempt",
    [ids.source],
  )).rows;
}

databaseIt("derives the attempt number and discriminates every reprocessing case itself", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");

    const first = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;
    // Same bytes, same converter: a retry.
    await client.query(record, [ids.org, ids.source, ids.owner, payload()]);
    // Same bytes, the library moved.
    await client.query(record, [ids.org, ids.source, ids.owner, payload({ converterVersion: "1.9.0" })]);
    // A different document behind the same source.
    await client.query(record, [ids.org, ids.source, ids.owner, payload({ sourceSha256: DIGEST_B, converterVersion: "1.9.0" })]);
    // A human replaced the extracted content.
    await client.query(record, [ids.org, ids.source, ids.owner, payload({ sourceSha256: DIGEST_B, converterVersion: "1.9.0", manualCorrection: true })]);
    // A caller cannot choose its own answer. This attempt asserts an attempt
    // number and a change kind that are both wrong for it, and the ledger
    // classifies it from the previous row regardless.
    await client.query(record, [ids.org, ids.source, ids.owner, payload({
      sourceSha256: DIGEST_B, converterVersion: "1.9.0", attempt: 99, changeKind: "changed-source",
    })]);

    expect(first.attempt).toBe(1);
    expect(first.changeKind).toBe("initial");
    expect((await conversions(client, ids)).map((row) => [row.attempt, row.change_kind])).toEqual([
      [1, "initial"],
      [2, "identical-input"],
      [3, "changed-converter"],
      [4, "changed-source"],
      [5, "manual-correction"],
      [6, "identical-input"],
    ]);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("records a failed conversion with its error code and refuses an impossible one", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");

    await client.query(record, [ids.org, ids.source, ids.owner, payload({
      outcome: "failed", errorCode: "knowledge-file-no-extractable-text", metadata: {},
    })]);
    // A failure with no code, and a success carrying one, are both incoherent.
    await denied(record, [ids.org, ids.source, ids.owner, payload({ outcome: "failed", metadata: {} })], "23514");
    await denied(record, [ids.org, ids.source, ids.owner, payload({ errorCode: "knowledge-file-size-invalid" })], "23514");
    // A format the converter table does not know is refused rather than stored.
    await denied(record, [ids.org, ids.source, ids.owner, payload({ sourceFormat: "heic" })], "23514");
    // And an actor with no active staff role in this organization cannot be
    // credited with a conversion.
    await denied(record, [ids.org, ids.source, ids.outsider, payload()], "42501");

    const rows = await conversions(client, ids);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].error_code).toBe("knowledge-file-no-extractable-text");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("freezes a written attempt and survives retries, retirement and restoration of its source", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const first = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;

    await role("postgres");
    for (const [column, literal] of [
      ["source_sha256", `'${DIGEST_B}'`],
      ["converter_version", "'9.9.9'"],
      ["change_kind", "'identical-input'"],
      ["outcome", "'failed'"],
      // A literal instant, not now(): inside one transaction now() equals the
      // value the row already holds, so `is distinct from` would be false and
      // the update would be a no-op the trigger correctly ignores.
      ["converted_at", "'2020-01-01T00:00:00Z'::timestamptz"],
      ["conversion_metadata", "'{}'::jsonb"],
    ]) {
      await denied(
        `update public.organization_knowledge_conversions set ${column} = ${literal} where id=$1`,
        [first.id],
      );
    }
    // Deleting a single provenance row is not an update, so the trigger cannot
    // see it -- but no role except the table owner can reach the table at all,
    // and the owner is postgres inside a migration. What must survive is the
    // source's own lifecycle, which is what the rest of this case exercises.
    await client.query("update public.organization_knowledge_sources set health='failed', chunk_count=0, last_error='knowledge-ingest-time-budget' where id=$1", [ids.source]);
    await client.query("delete from public.organization_knowledge_chunks where source_id=$1", [ids.source]);
    await client.query("update public.organization_knowledge_sources set health='unset_embedding', chunk_count=3, last_error=null where id=$1", [ids.source]);

    const rows = await conversions(client, ids);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_sha256).toBe(DIGEST_A);
    expect(rows[0].change_kind).toBe("initial");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("cannot be used to carry document text into a table staff can list", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");

    // A string value is the whole attack: one field is all an extract needs.
    await denied(record, [ids.org, ids.source, ids.owner, payload({
      metadata: { clause: "Article 14 - the employer shall not..." },
    })], "23514");
    // Seventeen keys, so text cannot be smuggled a character at a time either.
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index]));
    await denied(record, [ids.org, ids.source, ids.owner, payload({ metadata: many })], "23514");
    // Numeric and boolean counters are exactly what is allowed.
    await client.query(record, [ids.org, ids.source, ids.owner, payload({
      metadata: { inputBytes: 9, outputCharacters: 120, chunkCount: 1, articleCount: 0, extractionMs: 12 },
    })]);

    expect(await conversions(client, ids)).toHaveLength(1);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("attributes the review to the caller under MFA and records it exactly once", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const attempt = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;

    // A session that has not satisfied its assurance level cannot sign off on
    // what a model will quote.
    await role("authenticated", ids.reviewer, ids.reviewerSession, "aal1");
    await denied(review, [ids.org, attempt.id]);
    // Neither can staff of another organization.
    await role("authenticated", ids.outsider, ids.outsiderSession);
    await denied(review, [ids.org, attempt.id]);

    await role("authenticated", ids.reviewer, ids.reviewerSession);
    const signed = (await client.query(review, [ids.org, attempt.id])).rows[0].value;
    expect(signed.reviewedBy).toBe(ids.reviewer);
    expect(signed.reviewedAt).toBeTruthy();
    // A second reviewer cannot overwrite the first.
    await denied(review, [ids.org, attempt.id], "P0002");

    // The ledger row is the audit record: it names the reviewer and the instant,
    // and it carries no document content of any kind.
    await role("postgres");
    const signedRow = (await client.query(
      "select * from public.organization_knowledge_conversions where id=$1", [attempt.id],
    )).rows[0];
    expect(signedRow.conversion_reviewed_by).toBe(ids.reviewer);
    expect(signedRow.conversion_reviewed_at).toBeTruthy();
    expect(signedRow.review_status).toBe("approved");
    expect(signedRow.rejection_reason).toBeNull();
    expect(Object.keys(signedRow.conversion_metadata).sort())
      .toEqual(["chunkCount", "inputBytes", "outputCharacters"]);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("persists a rejected conversion with its reason and reviewer exactly once", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const succeeded = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;
    const failed = (await client.query(record, [ids.org, ids.source, ids.owner, payload({
      outcome: "failed", errorCode: "knowledge-file-no-extractable-text", metadata: {},
    })])).rows[0].value;

    await role("authenticated", ids.reviewer, ids.reviewerSession, "aal1");
    await denied(reject, [ids.org, succeeded.id, "Extracted text does not match the signed agreement."]);
    await role("authenticated", ids.outsider, ids.outsiderSession);
    await denied(reject, [ids.org, succeeded.id, "Extracted text does not match the signed agreement."]);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await denied(reject, [ids.org, succeeded.id, "   "], "22023");
    await denied(reject, [ids.org, succeeded.id, "x".repeat(281)], "22023");

    const refused = (await client.query(reject, [
      ids.org, succeeded.id, "  Extracted text does not match the signed agreement.  ",
    ])).rows[0].value;
    expect(refused.reviewedBy).toBe(ids.reviewer);
    expect(refused.reviewStatus).toBe("rejected");
    expect(refused.rejectionReason).toBe("Extracted text does not match the signed agreement.");
    await denied(reject, [ids.org, succeeded.id, "A second refusal must not overwrite the first."], "P0002");
    await denied(review, [ids.org, succeeded.id], "P0002");

    const failedRefusal = (await client.query(reject, [
      ids.org, failed.id, "No extractable text; do not retry until a readable scan is uploaded.",
    ])).rows[0].value;
    expect(failedRefusal.reviewStatus).toBe("rejected");
    expect(failedRefusal.reviewedBy).toBe(ids.reviewer);

    await role("postgres");
    const refusedRow = (await client.query(
      "select review_status, rejection_reason, conversion_reviewed_by from public.organization_knowledge_conversions where id=$1",
      [succeeded.id],
    )).rows[0];
    expect(refusedRow).toEqual({
      review_status: "rejected",
      rejection_reason: "Extracted text does not match the signed agreement.",
      conversion_reviewed_by: ids.reviewer,
    });
    await denied(
      "update public.organization_knowledge_conversions set rejection_reason='rewritten' where id=$1",
      [succeeded.id],
    );
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

// UX-UG-KNOWLEDGE-CONVERSION-CARD-POLISH-20260917.
//
// public.reject_knowledge_conversion used to validate the reason BEFORE it
// checked the caller's active staff role, so an outsider who sent a blank or
// 281-character reason was answered 'invalid conversion rejection' (22023)
// rather than 'not authorized' (42501). Both codes are reachable from a browser
// client, and the sibling public.review_knowledge_conversion refuses first, so
// the two answered the same unauthorized caller differently. Nothing about the
// authorized path changes: a member who may write the review still gets 22023
// for the same two reasons.
databaseIt("refuses an unauthorized rejection before it judges the reason", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const succeeded = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;

    // Staff of a DIFFERENT organization, so the caller really is somebody --
    // the refusal must come from the membership gate, not from being anonymous.
    for (const reason of ["", "   ", "x".repeat(281)]) {
      await role("authenticated", ids.outsider, ids.outsiderSession);
      const message = await denied(reject, [ids.org, succeeded.id, reason], "42501");
      expect(message).toBe("not authorized");
    }
    // A caller who has not satisfied MFA is refused on the same gate order.
    await role("authenticated", ids.reviewer, ids.reviewerSession, "aal1");
    expect(await denied(reject, [ids.org, succeeded.id, ""], "42501")).toBe("reauthentication required");

    // The authorized reviewer still learns that the reason itself is the
    // problem, so the repair narrowed nothing for a caller who may write.
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    expect(await denied(reject, [ids.org, succeeded.id, "   "], "22023")).toBe("invalid conversion rejection");
    expect(await denied(reject, [ids.org, succeeded.id, "x".repeat(281)], "22023")).toBe("invalid conversion rejection");

    // Nothing above wrote: the attempt is still awaiting review.
    await role("postgres");
    const row = (await client.query(
      "select review_status, conversion_reviewed_at, rejection_reason from public.organization_knowledge_conversions where id=$1",
      [succeeded.id],
    )).rows[0];
    expect(row).toEqual({ review_status: null, conversion_reviewed_at: null, rejection_reason: null });
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

// SEC-UG-KNOWLEDGE-CONVERSION-WRITE-PREDICATE-WEAKER-THAN-READ-20260920.
//
// The review and reject RPCs used to authorize with an inline membership x
// role-grant EXISTS that dropped two terms of the ledger's SELECT policy
// (private.has_organization_role): the caller's selected staff organization and
// the staff second factor. Each caller state below is one the read policy
// refuses, and each must now be refused the write as well.
databaseIt("refuses review and rejection to every caller the ledger's read policy refuses", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const attempt = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;
    const readable = async () => (await client.query(
      "select count(*)::int n from public.organization_knowledge_conversions where id=$1", [attempt.id],
    )).rows[0].n;

    // 1. Staff of this organization whose selected chapter belongs to another
    //    organization: the grant is real, but the selected staff organization
    //    is not this one.
    await role("postgres");
    const otherChapter = `conv-other-${ids.otherOrg}`;
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9912)", [otherChapter, ids.otherOrg]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.otherOrg, ids.reviewer]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids.reviewer, otherChapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.reviewer, otherChapter]);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    expect(await readable()).toBe(0);
    expect(await denied(review, [ids.org, attempt.id], "42501")).toBe("not authorized");
    expect(await denied(reject, [ids.org, attempt.id, "Selected elsewhere."], "42501")).toBe("not authorized");

    // 2. Staff of this organization, selected here, with no enrolled second
    //    factor while the organization requires staff MFA.
    await role("postgres");
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.reviewer, ids.chapter]);
    await client.query("delete from auth.mfa_factors where user_id=$1", [ids.reviewer]);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    expect(await readable()).toBe(0);
    await denied(review, [ids.org, attempt.id], "42501");
    await denied(reject, [ids.org, attempt.id, "No second factor."], "42501");

    // Nothing above wrote: the attempt is still awaiting review, and the
    // owner, whom the read policy admits, may still sign it.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await readable()).toBe(1);
    const signed = (await client.query(review, [ids.org, attempt.id])).rows[0].value;
    expect(signed).toMatchObject({ reviewStatus: "approved", reviewedBy: ids.owner });
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

// The append-only trigger's third branch guarded an already-signed row whose
// review_status was still null. organization_knowledge_conversions_review_is_
// complete makes that state unreachable, so removing the branch narrows the
// guard rather than widening it: the remaining branch must still refuse every
// review-column rewrite on a signed row, for an approval and for a refusal.
databaseIt("keeps a recorded decision unrewritable now that the signed-without-status branch is gone", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    const approvedAttempt = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;
    const rejectedAttempt = (await client.query(record, [ids.org, ids.source, ids.owner, payload({
      sourceSha256: DIGEST_B, outcome: "failed", errorCode: "knowledge-file-no-extractable-text", metadata: {},
    })])).rows[0].value;

    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await client.query(review, [ids.org, approvedAttempt.id]);
    await client.query(reject, [ids.org, rejectedAttempt.id, "No extractable text."]);

    await role("postgres");
    // The removed branch described a signed row whose review_status is still
    // null. Take the append-only trigger out of the way and the CHECK refuses
    // that state on its own, which is why the branch was unreachable: nothing
    // the trigger allows or forbids can bring the row into it.
    await client.query("savepoint conv_invariant");
    await client.query("alter table public.organization_knowledge_conversions disable trigger organization_knowledge_conversions_append_only");
    await denied(
      "update public.organization_knowledge_conversions set review_status=null where id=$1",
      [approvedAttempt.id],
      "23514",
    );
    await client.query("rollback to savepoint conv_invariant");
    await client.query("release savepoint conv_invariant");

    // With the trigger in place the same rewrite is refused one gate earlier.
    await denied(
      "update public.organization_knowledge_conversions set review_status=null where id=$1",
      [approvedAttempt.id],
    );
    // Both recorded decisions, and every review column, in one branch.
    for (const [id, flipped] of [[approvedAttempt.id, "rejected"], [rejectedAttempt.id, "approved"]]) {
      await denied("update public.organization_knowledge_conversions set review_status=$2 where id=$1", [id, flipped]);
      await denied("update public.organization_knowledge_conversions set conversion_reviewed_by=$2 where id=$1", [id, ids.owner]);
      await denied("update public.organization_knowledge_conversions set rejection_reason='rewritten' where id=$1", [id]);
      // now() is the transaction timestamp the RPC already wrote, so the new
      // value has to actually differ for the guard to be exercised.
      await denied("update public.organization_knowledge_conversions set conversion_reviewed_at=now()+interval '1 hour' where id=$1", [id]);
    }

    const rows = (await client.query(
      "select id, review_status, rejection_reason, conversion_reviewed_by from public.organization_knowledge_conversions where id = any($1) order by review_status",
      [[approvedAttempt.id, rejectedAttempt.id]],
    )).rows;
    expect(rows).toEqual([
      { id: approvedAttempt.id, review_status: "approved", rejection_reason: null, conversion_reviewed_by: ids.reviewer },
      { id: rejectedAttempt.id, review_status: "rejected", rejection_reason: "No extractable text.", conversion_reviewed_by: ids.reviewer },
    ]);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("shows provenance to the owning organization's staff and to nobody else", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds();
  const { role } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("service_role");
    await client.query(record, [ids.org, ids.source, ids.owner, payload()]);

    const visible = async () => (await client.query(
      "select pg_catalog.count(*)::integer c from public.organization_knowledge_conversions where source_id=$1",
      [ids.source],
    )).rows[0].c;

    await role("authenticated", ids.reviewer, ids.reviewerSession);
    const staffSees = await visible();
    await role("authenticated", ids.outsider, ids.outsiderSession);
    const outsiderSees = await visible();
    // The MFA overlay is restrictive, so an unelevated session of the OWNING
    // organization's own staff sees nothing either.
    await role("authenticated", ids.reviewer, ids.reviewerSession, "aal1");
    const unelevatedSees = await visible();

    expect(staffSees).toBe(1);
    expect(outsiderSees).toBe(0);
    expect(unelevatedSees).toBe(0);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

// Calls the shipped browser API functions through a Supabase-shaped adapter.
// The adapter only transports named parameters to PostgreSQL; it implements no
// authorization, provenance or workflow behaviour of its own.
function productClient(client) {
  const names = new Set(["review_steward_library_file", "publish_steward_file_to_catalog", "save_chapter_kb_article", "restore_chapter_kb_revision"]);
  return { rpc: async (name, params) => {
    if (!names.has(name)) throw new Error(`Unexpected product RPC ${name}`);
    const keys = Object.keys(params);
    try {
      const args = keys.map((key, index) => `${key} => $${index + 1}`).join(",");
      const { rows } = await client.query(`select to_jsonb(public.${name}(${args})) value`, Object.values(params));
      return { data: rows[0].value, error: null };
    } catch (error) { return { data: null, error }; }
  } };
}

async function workflowFixture(client, ids, role) {
  const prepared = await seed(client, ids, role);
  await role("authenticated");
  const target = (await client.query("select public.get_knowledge_file_storage_target($1,$2,'upload') value", [prepared.fileId, prepared.storageHandle])).rows[0].value;
  await role("postgres");
  await client.query("insert into storage.objects(bucket_id,name,owner,version,metadata) values($1,$2,$3,'conversion-proof-v1',$4::jsonb)", [target.bucketId, target.objectName, ids.owner, JSON.stringify({ size: 9, mimetype: target.mimeType })]);
  await role("authenticated");
  const inspection = (await client.query("select public.authorize_private_upload_inspection('knowledge',$1) value", [ids.file])).rows[0].value;
  await role("service_role");
  await client.query("select public.finish_private_upload_inspection($1,'clean',$2,'ClamAV 1.5.4',28113,now(),clock_timestamp())", [inspection.attemptId, DIGEST_A]);
  const attempt = (await client.query(record, [ids.org, ids.source, ids.owner, payload()])).rows[0].value;
  await client.query("select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb)", [ids.org, ids.source, ids.owner, ids.chapter, JSON.stringify([{ clauseKey: "article:1", articleRef: "Article 1", title: "Synthetic clause", body: "Original extracted clause", keywords: ["clause"] }])]);
  await role("postgres");
  const article = (await client.query("select id from public.member_kb_articles where knowledge_source_id=$1", [ids.source])).rows[0].id;
  return { attempt, article };
}

const articleFields = (ids, article, overrides = {}) => ({ articleId: article, chapterId: ids.chapter, kind: "contract", title: "Synthetic clause", articleRef: "Article 1", body: "Corrected clause", keywords: ["clause"], status: "published", confirmVerified: true, ...overrides });

databaseIt("product review and publication sign the corresponding conversion once with the session reviewer", async () => {
  const client = connect(); await client.connect(); await client.query("begin");
  const ids = makeIds(); const { role } = harness(client, ids);
  try {
    const { attempt } = await workflowFixture(client, ids, role);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    const api = productClient(client);
    await reviewStewardLibraryFile(api, ids.file, "approved");
    await publishStewardLibraryFile(api, ids.file, "contract");
    await role("authenticated");
    await publishStewardLibraryFile(api, ids.file, "contract");
    await role("postgres");
    const row = (await client.query("select conversion_reviewed_by, conversion_reviewed_at from public.organization_knowledge_conversions where id=$1", [attempt.id])).rows[0];
    expect(row.conversion_reviewed_by).toBe(ids.reviewer);
    expect(row.conversion_reviewed_at).toBeTruthy();
    expect((await client.query("select published_to_catalog from public.organization_knowledge_files where id=$1", [ids.file])).rows[0].published_to_catalog).toBe(true);
  } finally { await client.query("rollback"); await client.end(); }
});

databaseIt("product correction and revision restore append attributed manual attempts bound to article versions", async () => {
  const client = connect(); await client.connect(); await client.query("begin");
  const ids = makeIds(); const { role, denied } = harness(client, ids);
  try {
    const { attempt, article } = await workflowFixture(client, ids, role);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    const api = productClient(client);
    await saveChapterKnowledgeArticle(api, articleFields(ids, article));
    await role("postgres");
    const revision = (await client.query("select id from public.member_kb_article_revisions where article_id=$1 order by id desc limit 1", [article])).rows[0].id;
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await saveChapterKnowledgeArticle(api, articleFields(ids, article, { body: "Second correction", status: "draft", confirmVerified: false }));
    await restoreKnowledgeRevision(api, article, revision, true, ids.chapter);
    await role("postgres");
    const rows = (await client.query("select * from public.organization_knowledge_conversions where source_id=$1 order by attempt", [ids.source])).rows;
    expect(rows.map((row) => row.change_kind)).toEqual(["initial", "manual-correction", "manual-correction", "manual-correction"]);
    expect(rows.slice(1).map((row) => row.corrected_article_version)).toEqual([2, 3, 4]);
    expect(rows.slice(1).every((row) => row.corrected_article_id === article && row.corrected_by === ids.reviewer)).toBe(true);
    expect(rows[1].parent_conversion_id).toBe(attempt.id);
    expect(rows[2].parent_conversion_id).toBe(rows[1].id);
    expect(rows[1].conversion_reviewed_by).toBe(ids.reviewer);
    expect(rows[2].conversion_reviewed_by).toBeNull();
    expect(rows[3].conversion_reviewed_by).toBe(ids.reviewer);
    await denied("update public.organization_knowledge_conversions set corrected_article_version=99 where id=$1", [rows[1].id]);
  } finally { await client.query("rollback"); await client.end(); }
});

databaseIt("retains reviewer and corrector UUID evidence after the Auth accounts are deleted", async () => {
  const client = connect(); await client.connect(); await client.query("begin");
  const ids = makeIds(); const { role } = harness(client, ids);
  try {
    const { attempt, article } = await workflowFixture(client, ids, role);
    const api = productClient(client);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await reviewStewardLibraryFile(api, ids.file, "approved");
    await saveChapterKnowledgeArticle(api, articleFields(ids, article));
    await role("postgres");
    await client.query("delete from auth.users where id=$1", [ids.reviewer]);

    const rows = (await client.query(
      "select id, conversion_reviewed_by, corrected_by from public.organization_knowledge_conversions where id=$1 or corrected_by=$2 order by attempt",
      [attempt.id, ids.reviewer],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].conversion_reviewed_by).toBe(ids.reviewer);
    expect(rows[1].corrected_by).toBe(ids.reviewer);
  } finally { await client.query("rollback"); await client.end(); }
});

databaseIt("product provenance rejects foreign staff, low assurance and failed attempts with atomic rollback", async () => {
  const client = connect(); await client.connect(); await client.query("begin");
  const ids = makeIds(); const { role } = harness(client, ids);
  try {
    const { article } = await workflowFixture(client, ids, role);
    const api = productClient(client);
    const refuses = async (operation, code = "42501") => {
      await client.query("savepoint product_refusal");
      try { await expect(operation()).rejects.toMatchObject({ code }); }
      finally { await client.query("rollback to savepoint product_refusal"); }
    };
    await role("authenticated", ids.outsider, ids.outsiderSession);
    await refuses(() => reviewStewardLibraryFile(api, ids.file, "approved"), "P0002");
    await refuses(() => saveChapterKnowledgeArticle(api, articleFields(ids, article)));
    await role("authenticated", ids.reviewer, ids.reviewerSession, "aal1");
    await refuses(() => reviewStewardLibraryFile(api, ids.file, "approved"));
    await refuses(() => saveChapterKnowledgeArticle(api, articleFields(ids, article)));
    await role("service_role");
    await client.query(record, [ids.org, ids.source, ids.owner, payload({ outcome: "failed", errorCode: "knowledge-ingest-failed" })]);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await refuses(() => reviewStewardLibraryFile(api, ids.file, "approved"));
    await refuses(() => saveChapterKnowledgeArticle(api, articleFields(ids, article)));
    await role("postgres");
    expect((await client.query("select version,body from public.member_kb_articles where id=$1", [article])).rows[0]).toEqual({ version: 1, body: "Original extracted clause" });
    const rows = (await client.query("select conversion_reviewed_at from public.organization_knowledge_conversions where source_id=$1", [ids.source])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.conversion_reviewed_at === null)).toBe(true);
  } finally { await client.query("rollback"); await client.end(); }
});
