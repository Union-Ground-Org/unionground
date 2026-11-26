import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const migrationSql = readFileSync(
  "supabase/migrations/20260907151000_account_deletion_finalization_reconciliation.sql",
  "utf8",
);
const migrationPrefix = migrationSql.slice(
  0,
  migrationSql.indexOf("create or replace function public.authorize_member_account_deletion"),
);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const bootstrap = `
create schema extensions;
create schema auth;
create schema private;
create extension pgcrypto with schema extensions;

create table auth.users (id uuid primary key);
create table private.member_account_lifecycle_secret (
  id boolean primary key default true check (id),
  secret bytea not null check (pg_catalog.length(secret) = 32)
);
create table private.member_account_deletions (
  id uuid primary key default extensions.gen_random_uuid(),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('authorized', 'processing', 'completed', 'failed')),
  authorized_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  finalized_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 64),
  check (expires_at > authorized_at),
  check ((status = 'authorized' and claimed_at is null and finalized_at is null)
      or (status = 'processing' and claimed_at is not null and finalized_at is null)
      or (status in ('completed', 'failed') and finalized_at is not null))
);

create function private.member_lifecycle_subject_hash(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(p_user_id::text, 'UTF8'),
      secret.secret,
      'sha256'),
    'hex')
  from private.member_account_lifecycle_secret secret
  where secret.id
$$;
`;

export async function proveLegacyFingerprintUpgrade(databaseUrl) {
  const sourceUrl = new URL(databaseUrl);
  assert(["127.0.0.1", "localhost"].includes(sourceUrl.hostname),
    `Refusing fingerprint-upgrade proof against non-local host ${sourceUrl.hostname}`);

  const scratchName = `account_deletion_upgrade_${randomBytes(6).toString("hex")}`;
  const scratchUrl = new URL(databaseUrl);
  scratchUrl.pathname = `/${scratchName}`;
  const admin = new Client({ connectionString: databaseUrl, application_name: "account-deletion-upgrade-admin" });
  let scratch;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database ${scratchName} template template0`);
    created = true;
    scratch = new Client({ connectionString: scratchUrl.toString(), application_name: "account-deletion-upgrade-proof" });
    await scratch.connect();
    await scratch.query(bootstrap);

    const olderKeyUser = "50900907-0000-4000-8000-000000000001";
    const currentKeyUser = "50900907-0000-4000-8000-000000000002";
    await scratch.query("insert into private.member_account_lifecycle_secret (id, secret) values (true, extensions.gen_random_bytes(32))");
    await scratch.query("insert into auth.users (id) values ($1), ($2)", [olderKeyUser, currentKeyUser]);
    await scratch.query(`
      insert into private.member_account_deletions (subject_hash, token_hash, status, expires_at, claimed_at)
      values (private.member_lifecycle_subject_hash($1), pg_catalog.repeat('a', 64), 'processing', now() + interval '5 minutes', now())
    `, [olderKeyUser]);
    await scratch.query("update private.member_account_lifecycle_secret set secret = extensions.gen_random_bytes(32) where id");
    await scratch.query(`
      insert into private.member_account_deletions (subject_hash, token_hash, status, expires_at, claimed_at)
      values (private.member_lifecycle_subject_hash($1), pg_catalog.repeat('b', 64), 'processing', now() + interval '5 minutes', now())
    `, [currentKeyUser]);

    await scratch.query(migrationPrefix);

    const rows = (await scratch.query(`
      select subject_hash_key_fingerprint, failure_code
        from private.member_account_deletions
       order by token_hash
    `)).rows;
    assert(rows.length === 2, `fingerprint-upgrade proof expected two legacy requests, got ${rows.length}`);
    assert(rows[0].subject_hash_key_fingerprint === null
        && rows[0].failure_code === "subject-key-rotated",
    `an older-key legacy request must remain unstamped and parked: ${JSON.stringify(rows[0])}`);
    assert(/^[0-9a-f]{64}$/.test(rows[1].subject_hash_key_fingerprint || "")
        && rows[1].failure_code === null,
    `a legacy request verified under the installed key must be stamped: ${JSON.stringify(rows[1])}`);

    await scratch.query(`
      insert into private.member_account_deletions (
        subject_hash, subject_hash_key_fingerprint, token_hash, status, expires_at, claimed_at, failure_code
      ) values (pg_catalog.repeat('c', 64), null, pg_catalog.repeat('c', 64), 'processing', now() + interval '5 minutes', now(), null)
    `).then(
      () => { throw new Error("an unparked active request unexpectedly accepted a null fingerprint"); },
      (error) => assert(error.code === "23514", `expected active fingerprint check SQLSTATE 23514, got ${error.code || error.message}`),
    );

    console.log("PASS: migration-time legacy fingerprint backfill stamps only live identities verified under the installed key; an older-key active request remains unstamped and parked as subject-key-rotated.");
  } finally {
    await scratch?.end().catch(() => {});
    if (created) await admin.query(`drop database ${scratchName} with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
