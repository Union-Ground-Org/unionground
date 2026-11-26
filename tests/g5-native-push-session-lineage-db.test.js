// @vitest-environment node
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_G5_NATIVE_PUSH_LINEAGE_DB_TESTS === "1" ? it : it.skip;

const ids = {
  user: "50961000-0000-4000-8000-000000000001",
  olderSession: "50961000-0000-4000-8000-000000000011",
  newerSession: "50961000-0000-4000-8000-000000000012",
  installation: "50961000-0000-4000-8000-000000000101",
  tokenInstallation: "50961000-0000-4000-8000-000000000102",
  staleInstallation: "50961000-0000-4000-8000-000000000103",
};

const tokens = {
  older: "g5-native-lineage-older-token",
  newer: "g5-native-lineage-newer-token",
  shared: "g5-native-lineage-shared-token",
};

function claims(sessionID) {
  return { sub: ids.user, session_id: sessionID, role: "authenticated", aal: "aal2" };
}

async function asAuthenticated(client, sessionID) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims(sessionID))]);
  await client.query("set local role authenticated");
}

let savepointSequence = 0;
async function expectAuthorizationRefusal(client, sessionID, statement, values) {
  savepointSequence += 1;
  const savepoint = `g5_native_lineage_refusal_${savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await asAuthenticated(client, sessionID);
    await client.query(statement, values);
    throw new Error("expected stale native push lineage to be refused");
  } catch (error) {
    expect(error.code, error.message).toBe("42501");
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

async function register(client, sessionID, installationID, token, expectedHandle) {
  await asAuthenticated(client, sessionID);
  return (await client.query(
    `select public.register_my_native_push_installation(
       $1::uuid, 'fcm', 'production', $2::text, $3::uuid, $4::text
     ) as value`,
    [installationID, token, ids.user, expectedHandle],
  )).rows[0].value;
}

databaseIt("keeps a newer same-user native push lineage safe from an older still-live session", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "g5-native-push-session-lineage-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(
      "insert into auth.users (id, email, raw_user_meta_data) values ($1, 'g5-native-lineage@example.invalid', '{}'::jsonb)",
      [ids.user],
    );
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
        ($1, $3, now() - interval '2 hours', now() - interval '2 hours', 'aal2'),
        ($2, $3, now() - interval '1 hour', now() - interval '1 hour', 'aal2')
    `, [ids.olderSession, ids.newerSession, ids.user]);
    const handles = (await client.query(
      `select
         private.member_session_handle($1::uuid) as older,
         private.member_session_handle($2::uuid) as newer`,
      [ids.olderSession, ids.newerSession],
    )).rows[0];

    expect(await register(
      client,
      ids.olderSession,
      ids.installation,
      tokens.older,
      handles.older,
    )).toMatchObject({ registered: true, installationId: ids.installation });
    expect(await register(
      client,
      ids.newerSession,
      ids.installation,
      tokens.newer,
      handles.newer,
    )).toMatchObject({ registered: true, installationId: ids.installation });
    expect(await register(
      client,
      ids.newerSession,
      ids.tokenInstallation,
      tokens.shared,
      handles.newer,
    )).toMatchObject({ registered: true, installationId: ids.tokenInstallation });

    await expectAuthorizationRefusal(
      client,
      ids.olderSession,
      `select public.register_my_native_push_installation(
         $1::uuid, 'fcm', 'production', $2::text, $3::uuid, $4::text
       )`,
      [ids.installation, tokens.older, ids.user, handles.older],
    );
    await expectAuthorizationRefusal(
      client,
      ids.olderSession,
      `select public.register_my_native_push_installation(
         $1::uuid, 'fcm', 'production', $2::text, $3::uuid, $4::text
       )`,
      [ids.staleInstallation, tokens.shared, ids.user, handles.older],
    );

    await asAuthenticated(client, ids.olderSession);
    const staleDelete = (await client.query(
      "select public.delete_my_native_push_installation($1::uuid, $2::uuid, $3::text) as value",
      [ids.installation, ids.user, handles.older],
    )).rows[0].value;
    expect(staleDelete).toEqual({ deleted: false });

    await client.query("reset role");
    const retained = (await client.query(
      `select installation_id, device_token, session_handle
       from public.member_native_push_installations
       where user_id = $1
       order by installation_id`,
      [ids.user],
    )).rows;
    expect(retained).toEqual([
      { installation_id: ids.installation, device_token: tokens.newer, session_handle: handles.newer },
      { installation_id: ids.tokenInstallation, device_token: tokens.shared, session_handle: handles.newer },
    ]);

    await asAuthenticated(client, ids.newerSession);
    const currentDelete = (await client.query(
      "select public.delete_my_native_push_installation($1::uuid, $2::uuid, $3::text) as value",
      [ids.installation, ids.user, handles.newer],
    )).rows[0].value;
    expect(currentDelete).toEqual({ deleted: true });
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
