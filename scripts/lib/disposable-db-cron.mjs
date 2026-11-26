import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Supabase's pinned CLI does not expose arbitrary PostgreSQL startup settings.
// Bootstrap its services with application migrations disabled, pause the cron
// launcher, then replay the untouched migration files explicitly. Keep cron
// paused for the proofs too; a scheduler proof must opt in on its own target.
export function replayWithCronPaused({ workdir, invoke, run, startArgs, timeout, now = () => performance.now() }) {
  const path = join(workdir, "supabase/config.toml");
  const config = readFileSync(path, "utf8");
  const projectId = config.split(/^\[/m)[0].match(/^project_id = "(unionground-lab-ci-[a-f0-9]{12})"\s*$/m)?.[1];
  if (!projectId || existsSync(join(workdir, "supabase/.temp/project-ref"))) {
    throw new Error("cron-replay-requires-unlinked-disposable-project");
  }
  const section = config.match(/^\[db\.migrations\][\s\S]*?(?=^\[|$(?![\s\S]))/m)?.[0];
  if (!section || !/^enabled = true\s*$/m.test(section)) throw new Error("cron-replay-requires-enabled-migrations");
  const bootstrapConfig = config.replace(section, section.replace(/^enabled = true\s*$/m, "enabled = false"));
  const deadline = now() + timeout;
  const outputs = [];
  const execute = (operation, cap = Infinity) => {
    const left = Math.floor(Math.min(cap, deadline - now()));
    // This deadline may expire after bootstrap has created containers. Use
    // the same timeout failure as an interrupted child so callers stop them.
    const result = left > 0 ? operation(left)
      : { status: null, error: { code: "ETIMEDOUT" } };
    outputs.push(result);
    return result;
  };
  const finish = (result) => {
    const combined = outputs.at(-1) === result ? outputs : [...outputs, result];
    return { ...result,
      stdout: combined.map((item) => item.stdout ?? "").join("\n"),
      stderr: combined.map((item) => item.stderr ?? "").join("\n"),
    };
  };
  let result;
  writeFileSync(path, bootstrapConfig);
  try {
    result = execute((left) => invoke(startArgs, left));
  } finally {
    writeFileSync(path, config);
  }
  if (result.status !== 0) return finish(result);
  const docker = (args) => execute((left) => run("docker", args, {
    encoding: "utf8", timeout: left, maxBuffer: 1024 * 1024,
  }), 60_000);
  result = docker(["inspect", "--format", '{{json .Id}} {{json .Config.Labels}}', `supabase_db_${projectId}`]);
  if (result.status !== 0) return finish(result);
  const match = result.stdout?.trim().match(/^"([a-f0-9]{64})" (\{.*\})$/);
  if (!match || JSON.parse(match[2])["com.supabase.cli.project"] !== projectId) {
    return finish({ status: 1, stderr: "cron-replay-container-identity-mismatch" });
  }
  const sql = (statement) => docker(["exec", match[1], "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement]);
  result = sql("ALTER SYSTEM SET cron.launch_active_jobs = off");
  if (result.status !== 0) return finish(result);
  // Autovacuum stays off for the replay only (#5871/#5872). Once it analyzes
  // pg_catalog.pg_proc mid-replay, the planner picks a far slower plan for the
  // account-lifecycle trigger-surface scan that ~60 inventory migrations run
  // under their own 30-120 s statement limits: 1.4 s before and 26.6 s after
  // `ANALYZE pg_proc` on 2 CPUs, and over 60 s on GitHub's 2-vCPU runner (run
  // 39878959580, SQLSTATE 57014). The full 661-migration chain took 102 s
  // with it off against about 24 minutes for its last 293 migrations with
  // pg_proc analyzed. No migration analyzes anything itself. Disposable
  // targets only; it is restored before any proof runs.
  result = sql("ALTER SYSTEM SET autovacuum = off");
  if (result.status !== 0) return finish(result);
  result = sql("SELECT pg_reload_conf()");
  if (result.status !== 0) return finish(result);
  const paused = `IF current_setting('cron.launch_active_jobs') <> 'off' THEN RAISE EXCEPTION 'cron launcher is not paused'; END IF;`;
  result = sql(`DO $proof$ BEGIN ${paused}
    IF current_setting('autovacuum') <> 'off' THEN RAISE EXCEPTION 'autovacuum is not paused'; END IF;
  END $proof$;`);
  if (result.status !== 0) return finish(result);
  // CLI 2.121 no longer preinstalls pg_net when database webhooks are off.
  // Historical migrations use CREATE EXTENSION without a schema, so installing
  // it first preserves the reviewed extensions namespace instead of public.
  // pg_net is not relocatable; do this before any application migration.
  result = sql("CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions");
  if (result.status !== 0) return finish(result);
  result = execute((left) => invoke(["migration", "up", "--local"], left));
  if (result.status !== 0) return finish(result);
  result = sql("ALTER SYSTEM RESET autovacuum");
  if (result.status !== 0) return finish(result);
  result = sql("SELECT pg_reload_conf()");
  if (result.status !== 0) return finish(result);
  result = sql(`DO $proof$ BEGIN ${paused}
    IF current_setting('autovacuum') <> 'on' THEN RAISE EXCEPTION 'autovacuum was not restored after the replay'; END IF;
    IF EXISTS (SELECT FROM cron.job_run_details) THEN RAISE EXCEPTION 'cron ran during disposable replay'; END IF;
    RAISE NOTICE 'Disposable replay verified: cron.launch_active_jobs=off, cron.job_run_details=0, autovacuum restored';
  END $proof$;`);
  return finish(result);
}
