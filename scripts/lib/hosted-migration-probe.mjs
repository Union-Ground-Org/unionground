// Ledger 370: the CLI's default search_path hides failures in the hosted
// runner's empty-path wrapper (notably pg_get_functiondef md5 guards over
// composite types). The grant probe already holds exactly the ADDED files in
// a workdir copy. Rehearse each before its real CLI apply on both cold and
// physical starts. No historical blobs or replay of already-applied files.
import { sourceTransactionProblem, stripOuterTransaction } from "../hosted-migration-apply-runner.mjs";
import { readFileSync } from "node:fs";

// Read the very same SQL the hosted packet copies, never a weaker catalog
// approximation. Target/history pins and approval of the resulting delta
// remain hosted-only; the disposable rehearsal checks execution and rollback.
const lifecycle = readFileSync(new URL("../hosted-migration-apply/lifecycle-cte.sql", import.meta.url), "utf8").trimEnd();
const state = readFileSync(new URL("../hosted-migration-apply/state-select.sql", import.meta.url), "utf8").trim();
const STATE_QUERY = `${lifecycle},\nst as materialized (${state} state)\nselect st.state,encode(sha256(convert_to(st.state::text,'UTF8')),'hex') state_sha256 from st`;
const SESSION_SETTINGS = "set local search_path=''; set local statement_timeout='60s'";

async function stateHash(client) {
  const { rows: [row] } = await client.query(STATE_QUERY);
  if (!/^[a-f0-9]{64}$/u.test(row?.state_sha256 ?? "")) throw new Error("hosted migration state hash missing");
  return row.state_sha256;
}

export async function probeHostedMigration(client, source, file) {
  const problem = sourceTransactionProblem(source);
  if (problem || source.includes("$src_late2d$")) throw new Error(`hosted migration source: ${problem || "reserved $src_late2d$ delimiter"}`);
  const migration = /^(\d{14})_([a-z0-9_]+)\.sql$/u.exec(file ?? "");
  if (!migration) throw new Error("hosted migration requires its filename");
  const [, version, name] = migration;
  const started = performance.now();
  let before;
  await client.query("begin isolation level read committed");
  try {
    await client.query("set local search_path=''; set local lock_timeout='5s'; set local statement_timeout='60s'");
    await client.query("lock table supabase_migrations.schema_migrations in share row exclusive mode");
    before = await stateHash(client);
    await client.query(stripOuterTransaction(source));
    // Rehearse the common post-body operations too: a role left behind by
    // the body must still be able to append and read history. Parameterized
    // source bytes represent the runner's single dollar-quoted history item.
    await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,array[$3]::text[])", [version, name, source]);
    await client.query(SESSION_SETTINGS);
    const { rows: [history] } = await client.query("select version,name,statements from supabase_migrations.schema_migrations where version=$1", [version]);
    if (history?.version !== version || history.name !== name || history.statements?.length !== 1 || history.statements[0] !== source) {
      throw new Error("hosted migration history read-back mismatch");
    }
    // Run under the role/session left by the body, exactly as hosted does.
    await stateHash(client);
  } finally {
    await client.query("rollback");
  }
  await client.query("begin isolation level repeatable read read only");
  try {
    await client.query(SESSION_SETTINGS);
    if (await stateHash(client) !== before) throw new Error("hosted migration rollback state mismatch");
  } finally {
    await client.query("rollback");
  }
  return Math.round(performance.now() - started);
}
