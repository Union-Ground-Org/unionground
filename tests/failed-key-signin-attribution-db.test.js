// @vitest-environment node
// #9558: one transaction on the real auth schema, rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

let seed = Math.floor(Math.random() * 2000);
const net = () => { seed += 1; return `ipv4:203.0.${113 + Math.floor(seed / 250) % 10}.${seed % 250}`; };
const key = () => Buffer.from((randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 40), "hex").toString("base64url");

(process.env.SUPABASE_DB_URL ? describe : describe.skip)("refused key sign-in attribution", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("set statement_timeout = '10s'; begin");
  });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  const as = async (role, sql, args) => {
    await db.query("savepoint p");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
      await db.query(`set local role ${role}`);
      const { rows } = await db.query(sql, args);
      await db.query("release savepoint p");
      return rows[0].v;
    } catch (error) {
      await db.query("rollback to savepoint p");
      return error.code;
    } finally { await db.query("reset role"); }
  };
  const resolve = (id, handle, network = net()) =>
    as("service_role", "select public.resolve_failed_passkey_attempt($1, $2::uuid, $3) v", [id, handle, network]);
  const member = async () => {
    const id = randomUUID(); const k = key();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `Key.${id}@Example.invalid`]);
    await db.query("insert into auth.webauthn_credentials (user_id, credential_id, public_key) values ($1, decode(translate($2, '-_', '+/') || '=', 'base64'), '\\x02')", [id, k]);
    return { id, key: k, owner: { subject: id, email: `key.${id}@example.invalid` } };
  };

  it("names only the registered key's owner", async () => {
    const m = await member(); const other = await member();
    expect(await resolve(m.key, m.id)).toEqual(m.owner);
    expect(await resolve(m.key, null)).toEqual(m.owner);
    for (const id of [m.key, key(), "not base64url!", "a".repeat(17), "", null]) expect(await resolve(id, other.id)).toBeNull();
  });

  it("limits one member to five records an hour, across networks", async () => {
    const m = await member(); const got = [];
    for (let i = 0; i < 6; i += 1) got.push((await resolve(m.key, m.id))?.subject ?? null);
    expect(got).toEqual([m.id, m.id, m.id, m.id, m.id, null]);
  });

  it("limits one network to twenty attempts an hour, before any key is read", async () => {
    const shared = net();
    for (let i = 0; i < 20; i += 1) expect(await resolve(key(), null, shared)).toBeNull();
    const m = await member();
    expect(await resolve(m.key, m.id, shared)).toBeNull();
    expect(await resolve(m.key, m.id)).toEqual(m.owner);
  });

  it("leaves the password buckets alone and is for the service role only", async () => {
    const m = await member(); const shared = net();
    for (let i = 0; i < 25; i += 1) await resolve(m.key, m.id, shared);
    expect(await as("service_role", "select public.consume_password_signin_attempt($1, $2) v", [m.owner.email, shared])).toBe(true);
    const sql = "select public.resolve_failed_passkey_attempt('AAAAAAAAAAAAAAAAAAAAAA', null, 'unknown') v";
    expect([await as("authenticated", sql), await as("anon", sql), await resolve(m.key, null, "10.0.0.1")]).toEqual(["42501", "42501", "22023"]);
  });
});
