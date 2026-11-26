import { spawn, spawnSync } from "node:child_process";

const container = process.env.UNIONGROUND_DB_CONTAINER || "";
if (!/^supabase_db_unionground-lab-[a-z0-9-]+$/i.test(container)) {
  throw new Error(
    "UNIONGROUND_DB_CONTAINER must name an isolated supabase_db_unionground-lab-* container",
  );
}
const expectedProject = container.replace(/^supabase_db_/i, "");
const inspectedProject = spawnSync(
  "docker",
  [
    "inspect",
    "--format",
    "{{.Id}}|{{ index .Config.Labels \"com.supabase.cli.project\" }}",
    container,
  ],
  { encoding: "utf8", windowsHide: true },
);
// Report the docker failure itself rather than letting the destructure below
// throw on a null stdout: when docker is absent or the container is not
// running, the composite interlock's generic message hides the real cause.
if (inspectedProject.error || inspectedProject.status !== 0) {
  throw new Error(
    `docker inspect of ${container} failed: ${
      inspectedProject.error?.message
      || String(inspectedProject.stderr || "").trim()
      || "unknown"
    }`,
  );
}
const [inspectedContainerId = "", inspectedProjectLabel = ""] = String(inspectedProject.stdout || "")
  .trim()
  .split("|", 2);
const authorizedContainerId = process.env.UNIONGROUND_DB_CONTAINER_ID || "";
if (
  inspectedProject.status !== 0
  || inspectedProjectLabel !== expectedProject
  || !/^[0-9a-f]{64}$/i.test(inspectedContainerId)
  || authorizedContainerId !== inspectedContainerId
  || !/^unionground-lab-[a-z0-9-]+$/i.test(expectedProject)
) {
  throw new Error(
    "Disposable database container ID and project label must match the explicit Union Ground lab target",
  );
}
if (
  process.env.UNIONGROUND_DB_CONFIRM
  !== `RUN_DISPOSABLE_UNIONGROUND_DB_TESTS:${inspectedContainerId}`
) {
  throw new Error(
    "UNIONGROUND_DB_CONFIRM must bind disposable fixture authorization to the exact container ID",
  );
}

const USERS = {
  admin: "10000000-0000-4000-8000-000000000001",
  advisor: "10000000-0000-4000-8000-000000000002",
  staff: "10000000-0000-4000-8000-000000000003",
  member: "10000000-0000-4000-8000-000000000004",
  member2: "10000000-0000-4000-8000-000000000005",
  bosAdminA: "10000000-0000-4000-8000-000000000006",
  bosAdminB: "10000000-0000-4000-8000-000000000007",
  bargainer: "10000000-0000-4000-8000-000000000008",
  unenrolledStaff: "10000000-0000-4000-8000-000000000009",
};
const SESSION_IDS_BY_USER = new Map(
  Object.values(USERS).map((userId) => [
    userId,
    userId.replace(/^10000000-/, "40000000-"),
  ]),
);

let requestOrdinal = 1;
function requestId() {
  const tail = String(requestOrdinal++).padStart(12, "0");
  return `20000000-0000-4000-8000-${tail}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function lastLine(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function sqlStateOf(text) {
  return (
    text.match(/ERROR:\s+([0-9A-Z]{5}):/i)?.[1]?.toUpperCase()
    || text.match(/\bSQLSTATE\s+([0-9A-Z]{5})\b/i)?.[1]?.toUpperCase()
    || null
  );
}

function runPsql(sql, label = "psql") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        inspectedContainerId,
        "psql",
        "-X",
        "-qAt",
        "--set=ON_ERROR_STOP=1",
        "--set=VERBOSITY=verbose",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${label} failed${stderr ? `: ${stderr.trim()}` : ""}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      error.sqlState = sqlStateOf(`${stderr}\n${stdout}`);
      reject(error);
    });
    child.stdin.end(sql);
  });
}

function claimsSql(userId, aal, extra = {}) {
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aal,
    session_id: SESSION_IDS_BY_USER.get(userId),
    ...extra,
  });
  return `
do $claims$
begin
  perform pg_catalog.set_config('request.jwt.claims', ${sqlString(claims)}, true);
end
$claims$;
set local role authenticated;`;
}

async function asUser(userId, aal, statement, label, isolation = "read committed") {
  return runPsql(
    `begin isolation level ${isolation};
${claimsSql(userId, aal)}
${statement}
commit;`,
    label,
  );
}

async function asService(statement, label) {
  const claims = JSON.stringify({ role: "service_role" });
  return runPsql(
    `begin;
do $claims$
begin
  perform pg_catalog.set_config('request.jwt.claims', ${sqlString(claims)}, true);
end
$claims$;
set local role service_role;
${statement}
commit;`,
    label,
  );
}

function parseJson(result) {
  const value = lastLine(result.stdout);
  if (!value) throw new Error("Expected JSON result, received no rows");
  return JSON.parse(value);
}

async function scalar(sql, label = "scalar") {
  const result = await runPsql(sql, label);
  return lastLine(result.stdout);
}

async function jsonAs(userId, aal, expression, label, isolation) {
  return parseJson(await asUser(userId, aal, `select ${expression};`, label, isolation));
}

async function expectState(expected, action, label) {
  try {
    await action();
  } catch (error) {
    if (error.sqlState === expected) {
      pass(`${label} (${expected})`);
      return;
    }
    throw new Error(
      `${label}: expected SQLSTATE ${expected}, got ${error.sqlState || "unknown"}\n${error.stderr || error}`,
      { cause: error },
    );
  }
  throw new Error(`${label}: expected SQLSTATE ${expected}, but operation succeeded`);
}

function assert(condition, label, detail = "") {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  pass(label);
}

function pass(label) {
  process.stdout.write(`PASS ${label}\n`);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const lifecycleTables = [
  "union_employers",
  "union_worksites",
  "organizing_campaigns",
  "organizing_campaign_assignments",
  "organizing_stage_events",
  "organizing_work_areas",
  "organizing_workers",
  "organizing_contact_events",
  "organizing_resistance_incidents",
  "organizing_resistance_evidence",
  "organizing_bargaining_cycles",
  "organizing_bargaining_proposals",
  "organizing_bargaining_sessions",
  "organizing_bargaining_ratifications",
  "organizing_bargaining_ratification_corrections",
  "organizing_first_contracts",
  "member_membership_periods",
  "member_onboarding_steps",
  "member_participation_events",
  "coalition_partners",
  "coalition_handshakes",
  "coalition_commitments",
  "union_lifecycle_audit_events",
  "member_learning_sessions",
  "member_learning_assignments",
  "member_capacity_commitments",
  "member_participation_completions",
  "member_recognition_rules",
  "member_recognition_events",
];

function authUserValues([name, id]) {
  const email = `${name.toLowerCase()}@unionground-runtime.invalid`;
  const title = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `(
    '${id}'::uuid,
    'authenticated',
    'authenticated',
    '${email}',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    ${sqlString(JSON.stringify({
      first_name: title.split(" ")[0],
      full_name: title,
      initials: title.split(" ").map((part) => part[0]).join("").slice(0, 3).toUpperCase(),
    }))}::jsonb,
    pg_catalog.now(),
    pg_catalog.now()
  )`;
}

function authSessionValues([name, userId]) {
  const factors = {
    staff: "30000000-0000-4000-8000-000000000001",
    bargainer: "30000000-0000-4000-8000-000000000004",
    admin: "30000000-0000-4000-8000-000000000005",
    advisor: "30000000-0000-4000-8000-000000000006",
    bosAdminA: "30000000-0000-4000-8000-000000000007",
    bosAdminB: "30000000-0000-4000-8000-000000000008",
  };
  const factorId = factors[name] ? `${sqlString(factors[name])}::uuid` : "null";
  return `(
    '${SESSION_IDS_BY_USER.get(userId)}'::uuid,
    '${userId}'::uuid,
    pg_catalog.now(),
    pg_catalog.now(),
    ${factorId},
    'aal2',
    pg_catalog.now() + interval '1 day'
  )`;
}

async function setupFixtures() {
  const existing = Number(await scalar("select pg_catalog.count(*) from auth.users;", "preflight"));
  if (existing !== 0) {
    throw new Error(`Disposable lab must start empty; found ${existing} auth.users rows`);
  }
  const existingConnect = await scalar(`
select pg_catalog.concat_ws(',',
  (select pg_catalog.count(*) from private.unionground_connect_requests),
  (select pg_catalog.count(*) from private.unionground_connect_rate_buckets)
);`, "connect preflight");
  if (existingConnect !== "0,0") {
    throw new Error(
      `Disposable lab connect tables must start empty; found ${existingConnect}`,
    );
  }

  await runPsql(`
begin;
create table if not exists private.unionground_runtime_lab_sentinel (
  singleton boolean primary key default true check (singleton),
  project_id text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
insert into private.unionground_runtime_lab_sentinel (singleton, project_id)
values (true, ${sqlString(expectedProject)})
on conflict (singleton) do nothing;
do $sentinel$
begin
  if not exists (
    select 1
    from private.unionground_runtime_lab_sentinel
    where singleton and project_id = ${sqlString(expectedProject)}
  ) then
    raise exception 'disposable lab sentinel mismatch';
  end if;
end
$sentinel$;

-- These tenants and chapters exist only behind the composite disposable
-- container interlock. Neither sign-up nor a legacy seed supplies membership.
insert into public.organizations (id, slug, name) values
  ('60000000-0000-4000-8000-000000000001', 'psg-runtime-main', 'Runtime primary organization'),
  ('60000000-0000-4000-8000-000000000002', 'psg-runtime-other', 'Runtime other organization');
insert into public.chapters (id, name, region, order_index, organization_id, slug) values
  ('psg-runtime-main', 'Runtime primary chapter', 'Local proof', 9901, '60000000-0000-4000-8000-000000000001', 'psg-runtime-main'),
  ('psg-runtime-other', 'Runtime other chapter', 'Local proof', 9902, '60000000-0000-4000-8000-000000000002', 'psg-runtime-other');

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
${Object.entries(USERS).map(authUserValues).join(",\n")};

-- Direct lab Auth inserts are intentionally uninvited: production no longer
-- gives them an implicit chapter or role projection. Provision the fixture's
-- selected chapter and active membership explicitly, just like its role rows.
insert into public.member_chapter_memberships (user_id, chapter_id, status)
select id, case when id in ('${USERS.bosAdminA}'::uuid, '${USERS.bosAdminB}'::uuid)
  then 'psg-runtime-other' else 'psg-runtime-main' end, 'active'
from public.member_profiles where id in (${Object.values(USERS).map(sqlString).join(",")});
insert into public.organization_memberships (organization_id, user_id, status)
select c.organization_id, m.user_id, 'active'
from public.member_chapter_memberships m join public.chapters c on c.id = m.chapter_id
where m.user_id in (${Object.values(USERS).map(sqlString).join(",")});
update public.member_profiles p
set chapter_id = m.chapter_id
from public.member_chapter_memberships m
where m.user_id = p.id and p.id in (${Object.values(USERS).map(sqlString).join(",")});

delete from public.member_membership_periods
where user_id in ('${USERS.bosAdminA}'::uuid, '${USERS.bosAdminB}'::uuid);
update public.member_profiles
set chapter_id = 'psg-runtime-other'
where id in ('${USERS.bosAdminA}'::uuid, '${USERS.bosAdminB}'::uuid);

insert into public.member_roles (user_id, role, granted_by, chapter_id) values
  ('${USERS.admin}', 'admin', null, 'psg-runtime-main'),
  ('${USERS.admin}', 'coordinator', '${USERS.admin}', 'psg-runtime-main'),
  ('${USERS.advisor}', 'advisor', '${USERS.admin}', 'psg-runtime-main'),
  ('${USERS.staff}', 'organizer', '${USERS.admin}', 'psg-runtime-main'),
  ('${USERS.bargainer}', 'coordinator', '${USERS.admin}', 'psg-runtime-main'),
  ('${USERS.bosAdminA}', 'admin', null, 'psg-runtime-other'),
  ('${USERS.bosAdminB}', 'admin', null, 'psg-runtime-other'),
  ('${USERS.unenrolledStaff}', 'organizer', '${USERS.admin}', 'psg-runtime-main');

insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
select user_id, role, chapter_id, granted_by from public.member_roles
where user_id in (${Object.values(USERS).map(sqlString).join(",")});

insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret
) values (
  '30000000-0000-4000-8000-000000000001',
  '${USERS.staff}',
  'runtime',
  'totp',
  'verified',
  pg_catalog.now(),
  pg_catalog.now(),
  null
), (
  '30000000-0000-4000-8000-000000000004',
  '${USERS.bargainer}',
  'runtime bargaining coordinator',
  'totp',
  'verified',
  pg_catalog.now(),
  pg_catalog.now(),
  null
);

-- The current staff policy requires enrollment as well as an AAL2 claim.
insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret
) values
  ('30000000-0000-4000-8000-000000000005', '${USERS.admin}', 'runtime admin', 'totp', 'verified', now(), now(), null),
  ('30000000-0000-4000-8000-000000000006', '${USERS.advisor}', 'runtime advisor', 'totp', 'verified', now(), now(), null),
  ('30000000-0000-4000-8000-000000000007', '${USERS.bosAdminA}', 'runtime admin A', 'totp', 'verified', now(), now(), null),
  ('30000000-0000-4000-8000-000000000008', '${USERS.bosAdminB}', 'runtime admin B', 'totp', 'verified', now(), now(), null);

insert into auth.sessions (
  id, user_id, created_at, updated_at, factor_id, aal, not_after
) values
${Object.entries(USERS).map(authSessionValues).join(",\n")};
commit;`, "fixture setup");
  pass("isolated fixture setup");
}

async function verifyCatalog() {
  const tableList = lifecycleTables.map(sqlString).join(",");
  const protectedCount = Number(await scalar(`
select pg_catalog.count(*)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = any(array[${tableList}]::text[])
  and c.relrowsecurity
  and exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = c.oid
      and p.polname = 'mfa_assurance'
      and not p.polpermissive
  );`, "RLS catalog"));
  assert(
    protectedCount === lifecycleTables.length,
    "all lifecycle tables have RLS plus restrictive MFA",
    `${protectedCount}/${lifecycleTables.length}`,
  );

  const forbiddenPrivileges = Number(await scalar(`
select pg_catalog.count(*)
from (values
  ('member_learning_sessions'),
  ('member_learning_assignments'),
  ('member_capacity_commitments'),
  ('member_participation_completions')
) as tables(name)
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) as privileges(name)
where pg_catalog.has_table_privilege(
  'authenticated',
  'public.' || tables.name,
  privileges.name
);`, "canonical ACL catalog"));
  assert(forbiddenPrivileges === 0, "canonical source tables expose no browser table privilege");

  const acl = (await scalar(`
select pg_catalog.concat_ws(',',
  pg_catalog.has_table_privilege('authenticated','public.member_action_log','SELECT'),
  pg_catalog.has_table_privilege('authenticated','public.member_action_log','TRUNCATE'),
  pg_catalog.has_table_privilege('authenticated','public.member_participation_events','SELECT'),
  pg_catalog.has_column_privilege('authenticated','public.member_participation_events','activity_kind','SELECT'),
  pg_catalog.has_column_privilege('authenticated','public.member_participation_events','user_id','SELECT'),
  pg_catalog.has_column_privilege('authenticated','public.member_recognition_events','source_label','SELECT'),
  pg_catalog.has_column_privilege('authenticated','public.member_recognition_events','verified_by','SELECT'),
  pg_catalog.has_column_privilege('authenticated','public.member_recognition_events','canonical_completion_id','SELECT')
);`, "safe projection ACL"));
  assert(acl === "t,f,f,t,t,t,f,f", "historical and recognition column ACLs are least-privilege", acl);

  const lifecycleWriterCatalog = await scalar(`
select pg_catalog.concat_ws(',',
  pg_catalog.to_regprocedure(
    'public.transition_organizing_campaign(uuid,integer,text,text)'
  ) is null,
  pg_catalog.to_regprocedure(
    'public.set_organizing_campaign_status(uuid,integer,text,text,text)'
  ) is null,
  pg_catalog.to_regprocedure(
    'public.record_resistance_incident(uuid,text,text,text,text,date,timestamptz)'
  ) is null,
  pg_catalog.to_regprocedure(
    'public.transition_organizing_campaign(uuid,integer,text,uuid,text)'
  ) is not null,
  pg_catalog.to_regprocedure(
    'public.set_organizing_campaign_status(uuid,integer,text,uuid,text,text)'
  ) is not null,
  pg_catalog.to_regprocedure(
    'public.record_resistance_incident(uuid,text,text,text,text,uuid,text,date,timestamptz,boolean)'
  ) is not null,
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.transition_organizing_campaign(uuid,integer,text,uuid,text)',
    'EXECUTE'
  ),
  pg_catalog.has_function_privilege(
    'anon',
    'public.transition_organizing_campaign(uuid,integer,text,uuid,text)',
    'EXECUTE'
  )
);`, "lifecycle writer catalog");
  assert(
    lifecycleWriterCatalog === "t,t,t,t,t,t,t,f",
    "only hardened lifecycle writer signatures are exposed",
    lifecycleWriterCatalog,
  );

  const bargainingWriterCatalog = await scalar(`
with signatures(signature) as (
  values
    ('public.open_organizing_bargaining_cycle(uuid,integer,text,uuid,date,text,timestamptz)'),
    ('public.transition_organizing_bargaining_cycle(uuid,integer,integer,text,uuid,date,text,text,timestamptz)'),
    ('public.create_organizing_bargaining_proposal(uuid,integer,text,text,text,uuid,text,uuid[],text,uuid,integer,text,text,text)'),
    ('public.transition_organizing_bargaining_proposal(uuid,integer,integer,text,uuid,date,text)'),
    ('public.schedule_organizing_bargaining_session(uuid,integer,timestamptz,uuid,text,text)'),
    ('public.record_organizing_bargaining_session_outcome(uuid,integer,integer,text,uuid,timestamptz,text,text,text)'),
    ('public.record_organizing_ratification(uuid,integer,integer,uuid,text,text,date,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,text,text,uuid)'),
    ('public.correct_organizing_ratification(uuid,integer,integer,text,text,text,text,uuid)'),
    ('public.record_organizing_first_contract(uuid,integer,integer,uuid,text,date,uuid,text,text,text,integer,integer,date,date)')
)
select pg_catalog.concat_ws(',',
  pg_catalog.count(*) filter (
    where pg_catalog.to_regprocedure(signature) is not null
  ),
  pg_catalog.count(*) filter (
    where pg_catalog.has_function_privilege(
      'authenticated',
      pg_catalog.to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  pg_catalog.count(*) filter (
    where pg_catalog.has_function_privilege(
      'anon',
      pg_catalog.to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  (
    select pg_catalog.count(*)
    from (values
      ('organizing_bargaining_ratifications'),
      ('organizing_bargaining_ratification_corrections'),
      ('organizing_first_contracts')
    ) as evidence(name)
    cross join (values
      ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
    ) as privilege(name)
    where pg_catalog.has_table_privilege(
      'authenticated',
      'public.' || evidence.name,
      privilege.name
    )
  )
)
from signatures;`, "bargaining writer catalog");
  assert(
    bargainingWriterCatalog === "9,9,0,0",
    "only authenticated can execute the exact bargaining writer surface",
    bargainingWriterCatalog,
  );

  const memberLifecycleAcl = await scalar(`
select pg_catalog.concat_ws(',',
  pg_catalog.has_table_privilege(
    'authenticated',
    'public.member_membership_periods',
    'SELECT'
  ),
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.member_membership_periods',
    'id',
    'SELECT'
  ),
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.member_membership_periods',
    'verified_by',
    'SELECT'
  ),
  pg_catalog.has_table_privilege(
    'authenticated',
    'public.member_onboarding_steps',
    'SELECT'
  ),
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.member_onboarding_steps',
    'step_key',
    'SELECT'
  ),
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.member_onboarding_steps',
    'source_id',
    'SELECT'
  )
);`, "member lifecycle ACL catalog");
  assert(
    memberLifecycleAcl === "f,t,f,f,t,f",
    "member lifecycle reads expose only safe columns",
    memberLifecycleAcl,
  );
  const memberLifecycleColumns = await scalar(`
select pg_catalog.concat_ws('|',
  (
    select pg_catalog.string_agg(a.attname, ',' order by a.attnum)
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.member_membership_periods'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.has_column_privilege(
        'authenticated',
        'public.member_membership_periods',
        a.attname,
        'SELECT'
      )
  ),
  (
    select pg_catalog.string_agg(a.attname, ',' order by a.attnum)
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.member_onboarding_steps'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.has_column_privilege(
        'authenticated',
        'public.member_onboarding_steps',
        a.attname,
        'SELECT'
      )
  )
);`, "member lifecycle exact column ACL catalog");
  assert(
    memberLifecycleColumns
      === "id,joined_on,left_on,date_precision,status,verified_at"
        + "|id,membership_period_id,step_key,due_on,status,completed_at",
    "member lifecycle effective column allowlists are exact",
    memberLifecycleColumns,
  );

  const connectAcl = await scalar(`
select pg_catalog.concat_ws(',',
  pg_catalog.has_table_privilege(
    'authenticated',
    'private.unionground_connect_requests',
    'SELECT'
  ),
  pg_catalog.has_table_privilege(
    'service_role',
    'private.unionground_connect_requests',
    'SELECT'
  ),
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.submit_unionground_connect_request(uuid,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  pg_catalog.has_function_privilege(
    'service_role',
    'public.submit_unionground_connect_request(uuid,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.purge_expired_unionground_connect_requests()',
    'EXECUTE'
  ),
  pg_catalog.has_function_privilege(
    'service_role',
    'public.purge_expired_unionground_connect_requests()',
    'EXECUTE'
  )
);`, "connect ACL catalog");
  assert(connectAcl === "f,f,f,t,f,t", "public connect persistence is service-RPC-only", connectAcl);
}

async function verifyPublicConnectBoundary() {
  const ciphertext = "QUFBQUFBQUFBQUFB";
  const iv = "Q0NDQ0NDQ0NDQ0ND";
  const authTag = "QkJCQkJCQkJCQkJCQkJCQg==";
  const digest = "a".repeat(64);
  const ipHash = "b".repeat(64);
  const ids = Array.from(
    { length: 6 },
    (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const call = (id, requestDigest = digest) => `
select public.submit_unionground_connect_request(
  '${id}',
  '${ciphertext}',
  '${iv}',
  '${authTag}',
  '${requestDigest}',
  'v1',
  '${ipHash}'
);`;

  await expectState(
    "42501",
    () => asUser(
      USERS.member,
      "aal2",
      call(ids[0]),
      "authenticated connect RPC denial",
    ),
    "browser cannot invoke encrypted connect writer",
  );

  const accepted = [];
  for (const id of ids.slice(0, 5)) {
    accepted.push(parseJson(await asService(call(id), `connect accept ${id}`)));
  }
  assert(
    accepted.every((result) => result.accepted && result.idempotent === false),
    "connect RPC accepts five encrypted requests per hourly source bucket",
  );

  const limited = parseJson(await asService(call(ids[5]), "connect rate limit"));
  assert(
    limited.accepted === false && limited.reason === "rate-limit",
    "connect RPC atomically rate-limits the sixth hourly source request",
  );

  const replay = parseJson(await asService(call(ids[0]), "connect replay"));
  assert(
    replay.accepted && replay.idempotent && replay.requestId === ids[0],
    "connect retry remains idempotent after the source bucket is full",
  );
  await expectState(
    "22023",
    () => asService(call(ids[0], "c".repeat(64)), "connect key mismatch"),
    "connect request ID cannot be reused for a different payload",
  );

  const persistence = await scalar(`
select pg_catalog.concat_ws(',',
  (select pg_catalog.count(*) from private.unionground_connect_requests),
  (select attempt_count from private.unionground_connect_rate_buckets where ip_hash = '${ipHash}'),
  (select accepted_count from private.unionground_connect_rate_buckets where ip_hash = '${ipHash}'),
  (select pg_catalog.bool_and(expires_at > created_at + interval '29 days')
     from private.unionground_connect_requests),
  (select pg_catalog.count(*)
     from information_schema.columns
     where table_schema = 'private'
       and table_name = 'unionground_connect_requests'
       and column_name in (
         'employer_name','workplace_name','coworker_name',
         'support_count','card_count','allegation','narrative','notes'
       ))
);`, "connect encrypted persistence");
  assert(
    persistence === "5,7,5,t,0",
    "connect persistence is bounded, expiring, and has no organizing-detail columns",
    persistence,
  );

  await runPsql(`
update private.unionground_connect_requests
set created_at = pg_catalog.clock_timestamp() - interval '40 days',
    expires_at = pg_catalog.clock_timestamp() - interval '10 days'
where request_id = '${ids[0]}';`, "expired connect fixture");
  const purged = parseJson(await asService(
    "select public.purge_expired_unionground_connect_requests();",
    "connect retention purge",
  ));
  const remaining = Number(await scalar(
    "select pg_catalog.count(*) from private.unionground_connect_requests;",
    "connect retention remainder",
  ));
  assert(
    purged.requestsDeleted === 1
      && purged.bucketsDeleted === 0
      && remaining === 4,
    "scheduled connect retention purge deletes expired ciphertext",
    JSON.stringify({ purged, remaining }),
  );
}

async function verifyCampaignBoundary() {
  const tooLong = "x".repeat(121);
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.create_organizing_campaign(
        'Invalid employer length',
        ${sqlString(tooLong)},
        'Runtime worksite',
        'Runtime proposed unit',
        '${requestId()}',
        'election',
        50
      );`,
      "campaign input bound",
    ),
    "campaign shared employer length is prevalidated",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.create_organizing_campaign(
        'Invalid eligible estimate',
        'Runtime Employer',
        'Runtime Worksite',
        'Runtime proposed unit',
        '${requestId()}',
        'election',
        10000001
      );`,
      "campaign eligible estimate bound",
    ),
    "campaign eligible estimate is bounded server-side",
  );

  const campaignRequest = requestId();
  const created = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_campaign(
      'Runtime organizing drive',
      'Runtime Employer',
      'Runtime Worksite',
      'Runtime proposed unit',
      '${campaignRequest}',
      'election',
      50
    )`,
    "create campaign",
  );
  assert(created.changed && created.stage === "lead", "campaign create RPC writes initial audited state");

  const replayed = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_campaign(
      'Runtime organizing drive',
      'Runtime Employer',
      'Runtime Worksite',
      'Runtime proposed unit',
      '${campaignRequest}',
      'election',
      50
    )`,
    "replay campaign create",
  );
  assert(
    replayed.changed === false && replayed.campaignId === created.campaignId,
    "campaign create lost-response replay returns the original receipt",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.create_organizing_campaign(
        'Different campaign',
        'Runtime Employer',
        'Runtime Worksite',
        'Runtime proposed unit',
        '${campaignRequest}',
        'election',
        50
      );`,
      "campaign request mismatch",
    ),
    "campaign request ID cannot be reused for different fields",
  );
  const createCounts = await scalar(`
select pg_catalog.concat_ws(',',
  (select pg_catalog.count(*) from public.union_employers where created_by = '${USERS.staff}'),
  (select pg_catalog.count(*) from public.union_worksites where created_by = '${USERS.staff}'),
  (select pg_catalog.count(*) from public.organizing_campaigns where created_by = '${USERS.staff}')
);`, "campaign idempotency counts");
  assert(
    createCounts === "1,1,1",
    "campaign replay creates one employer, worksite, and campaign",
    createCounts,
  );

  const crossScopeRequest = requestId();
  const oldScopeCampaign = await scalar(`
with employer as (
  insert into public.union_employers (
    chapter_id, legal_name, display_name, created_by
  ) values (
    'psg-runtime-other', 'Cross-scope Runtime Employer', 'Cross-scope Runtime Employer', '${USERS.staff}'
  )
  returning id
),
worksite as (
  insert into public.union_worksites (
    chapter_id, employer_id, name, created_by
  )
  select 'psg-runtime-other', id, 'Cross-scope Runtime Worksite', '${USERS.staff}'
  from employer
  returning id, employer_id
)
insert into public.organizing_campaigns (
  chapter_id,
  employer_id,
  primary_worksite_id,
  name,
  proposed_unit,
  representation_path,
  eligible_estimate,
  owner_id,
  create_request_id,
  created_by
)
select
  'psg-runtime-other',
  employer_id,
  id,
  'Cross-scope Runtime Drive',
  'Cross-scope Runtime Unit',
  'election',
  25,
  '${USERS.staff}',
  '${crossScopeRequest}',
  '${USERS.staff}'
from worksite
returning id;`, "cross-scope campaign fixture");
  const currentScopeCampaign = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_campaign(
      'Cross-scope Runtime Drive',
      'Cross-scope Runtime Employer',
      'Cross-scope Runtime Worksite',
      'Cross-scope Runtime Unit',
      '${crossScopeRequest}',
      'election',
      25
    )`,
    "cross-scope campaign create",
  );
  assert(
    currentScopeCampaign.changed === true
      && currentScopeCampaign.campaignId !== oldScopeCampaign,
    "campaign idempotency keys cannot reveal or replay another chapter",
  );

  const committeeRequest = requestId();
  const committee = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_campaign(
      '${created.campaignId}',
      1,
      'committee',
      '${committeeRequest}',
      'Runtime'
    )`,
    "campaign lead to committee",
  );
  const committeeReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_campaign(
      '${created.campaignId}',
      1,
      'committee',
      '${committeeRequest}',
      'Runtime'
    )`,
    "campaign committee replay",
  );
  assert(
    committeeReplay.changed === false
      && committeeReplay.revision === committee.revision
      && committeeReplay.auditEventId === committee.auditEventId,
    "campaign milestone replay returns the original receipt before revision rejection",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.transition_organizing_campaign(
        '${created.campaignId}',
        1,
        'committee',
        '${committeeRequest}',
        'Changed input'
      );`,
      "campaign milestone request mismatch",
    ),
    "campaign milestone request ID rejects changed input",
  );
  await expectState(
    "40001",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.transition_organizing_campaign(
        '${created.campaignId}',
        1,
        'cards',
        '${requestId()}',
        'Stale'
      );`,
      "campaign milestone stale revision",
    ),
    "campaign milestone rejects a stale revision",
  );

  const cardsRequest = requestId();
  const cards = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_campaign(
      '${created.campaignId}',
      2,
      'cards',
      '${cardsRequest}',
      'Runtime'
    )`,
    "campaign committee to cards",
  );
  assert(committee.revision === 2 && cards.revision === 3, "campaign stage domain and revisions agree");

  const pauseRequest = requestId();
  const paused = await jsonAs(
    USERS.staff,
    "aal2",
    `public.set_organizing_campaign_status(
      '${created.campaignId}',
      3,
      'paused',
      '${pauseRequest}',
      null,
      'Runtime pause'
    )`,
    "pause campaign",
  );
  const pauseReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.set_organizing_campaign_status(
      '${created.campaignId}',
      3,
      'paused',
      '${pauseRequest}',
      null,
      'Runtime pause'
    )`,
    "replay pause campaign",
  );
  assert(
    paused.revision === 4
      && pauseReplay.changed === false
      && pauseReplay.auditEventId === paused.auditEventId,
    "campaign status replay returns one stable receipt",
  );
  const resumed = await jsonAs(
    USERS.staff,
    "aal2",
    `public.set_organizing_campaign_status(
      '${created.campaignId}',
      4,
      'active',
      '${requestId()}',
      null,
      'Runtime resume'
    )`,
    "resume campaign",
  );
  assert(resumed.revision === 5 && resumed.status === "active", "campaign pause and resume graph is explicit");
  await expectState(
    "42501",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.set_organizing_campaign_status(
        '${created.campaignId}',
        5,
        'closed',
        '${requestId()}',
        'withdrawn',
        'Runtime closure'
      );`,
      "organizer close campaign",
    ),
    "assigned organizer cannot permanently close a campaign",
  );

  const resistanceRequest = requestId();
  const resistance = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_resistance_incident(
      '${created.campaignId}',
      'Reported schedule threat',
      'threat',
      'high',
      'A supervisor reportedly linked schedules to campaign activity.',
      '${resistanceRequest}',
      'worker_report',
      '2026-07-20'::date,
      '2026-07-30T16:00:00Z'::timestamptz,
      true
    )`,
    "record resistance incident",
  );
  const resistanceReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_resistance_incident(
      '${created.campaignId}',
      'Reported schedule threat',
      'threat',
      'high',
      'A supervisor reportedly linked schedules to campaign activity.',
      '${resistanceRequest}',
      'worker_report',
      '2026-07-20'::date,
      '2026-07-30T16:00:00Z'::timestamptz,
      true
    )`,
    "replay resistance incident",
  );
  assert(
    resistance.changed === true
      && resistanceReplay.changed === false
      && resistanceReplay.incidentId === resistance.incidentId
      && resistanceReplay.auditEventId === resistance.auditEventId,
    "resistance replay creates one incident and one receipt",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.record_resistance_incident(
        '${created.campaignId}',
        'Reported schedule threat',
        'threat',
        'high',
        'Changed summary.',
        '${resistanceRequest}',
        'worker_report',
        '2026-07-20'::date,
        '2026-07-30T16:00:00Z'::timestamptz,
        true
      );`,
      "resistance request mismatch",
    ),
    "resistance request ID rejects changed narrative input",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.record_resistance_incident(
        '${created.campaignId}',
        'Future incident',
        'other',
        'monitor',
        'Identity-free future-dated report.',
        '${requestId()}',
        'organizer_note',
        current_date + 1,
        null,
        false
      );`,
      "future resistance incident",
    ),
    "resistance occurrence date cannot be in the future",
  );
  const resistanceCounts = await scalar(`
select pg_catalog.concat_ws(',',
  (
    select pg_catalog.count(*)
    from public.organizing_resistance_incidents
    where create_request_id = '${resistanceRequest}'
  ),
  (
    select pg_catalog.count(*)
    from public.union_lifecycle_audit_events
    where request_id = '${resistanceRequest}'
      and safe_metadata ? 'category'
      and not (safe_metadata ? 'summary')
  )
);`, "resistance idempotency counts");
  assert(
    resistanceCounts === "1,1",
    "resistance audit stores one metadata-only receipt",
    resistanceCounts,
  );

  const closureCampaign = await jsonAs(
    USERS.admin,
    "aal2",
    `public.create_organizing_campaign(
      'Runtime closure campaign',
      'Runtime Closure Employer',
      'Runtime Closure Worksite',
      'Runtime closure unit',
      '${requestId()}',
      'undecided',
      null
    )`,
    "create coordinator closure campaign",
  );
  const closeRequest = requestId();
  const closed = await jsonAs(
    USERS.admin,
    "aal2",
    `public.set_organizing_campaign_status(
      '${closureCampaign.campaignId}',
      1,
      'closed',
      '${closeRequest}',
      'withdrawn',
      'Scope changed after verification.'
    )`,
    "coordinator close campaign",
  );
  const closeReplay = await jsonAs(
    USERS.admin,
    "aal2",
    `public.set_organizing_campaign_status(
      '${closureCampaign.campaignId}',
      1,
      'closed',
      '${closeRequest}',
      'withdrawn',
      'Scope changed after verification.'
    )`,
    "coordinator close replay",
  );
  assert(
    closed.status === "closed"
      && closed.outcome === "withdrawn"
      && closeReplay.changed === false
      && closeReplay.auditEventId === closed.auditEventId,
    "coordinator closure is terminal and retry-safe",
  );

  await runPsql(`
update public.organizing_campaigns
set stage = 'certification', revision = 10
where id = '${created.campaignId}';`, "milestone fixture");
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.transition_organizing_campaign(
        '${created.campaignId}',
        10,
        'bargaining',
        '${requestId()}',
        'Must have evidence'
      );`,
      "campaign milestone gate",
    ),
    "bargaining stage requires a bargaining cycle",
  );
  await runPsql(`
insert into public.organizing_work_areas (
  campaign_id,
  chapter_id,
  name,
  shift,
  eligible_estimate,
  contacted_count,
  committee_count,
  issue_themes
) values (
  '${created.campaignId}',
  'psg-runtime-main',
  'Runtime day shift',
  'day',
  20,
  10,
  5,
  array['scheduling']
);`, "aggregate work-area fixture");

  const advisorWorkspace = await jsonAs(
    USERS.advisor,
    "aal2",
    "public.get_union_lifecycle_workspace()",
    "aggregate workspace",
  );
  assert(advisorWorkspace.access.aggregateOnly === true, "advisor workspace is marked aggregate-only");
  for (const key of ["campaigns", "worksites", "workAreas", "resistanceEvents", "bargaining", "coalitions"]) {
    assert(Array.isArray(advisorWorkspace[key]) && advisorWorkspace[key].length === 0, `aggregate workspace redacts ${key}`);
  }
  return created.campaignId;
}

async function createLearning({
  kind = "training",
  title,
  user = USERS.staff,
  aal = "aal2",
} = {}) {
  const request = requestId();
  const result = await jsonAs(
    user,
    aal,
    `public.create_learning_session(
      '${kind}',
      ${sqlString(title || `Runtime ${kind}`)},
      pg_catalog.now() - interval '2 hours',
      pg_catalog.now() - interval '1 hour',
      '${request}'
    )`,
    `create ${kind} learning session`,
  );
  return { ...result, request };
}

async function assignLearning(sessionId, memberId = USERS.member) {
  const request = requestId();
  const result = await jsonAs(
    USERS.staff,
    "aal2",
    `public.assign_learning_session('${sessionId}', '${memberId}', '${request}')`,
    "assign learning session",
  );
  return { ...result, request };
}

async function acceptLearning(assignmentId, request = requestId()) {
  const result = await jsonAs(
    USERS.member,
    "aal2",
    `public.respond_learning_assignment('${assignmentId}', true, '${request}')`,
    "accept learning assignment",
  );
  return { ...result, request };
}

async function verifyParticipation() {
  const deniedRequest = requestId();
  await expectState(
    "42501",
    () => asUser(
      USERS.staff,
      "aal1",
      `select public.create_learning_session(
        'training',
        'MFA denied session',
        pg_catalog.now() - interval '2 hours',
        pg_catalog.now() - interval '1 hour',
        '${deniedRequest}'
      );`,
      "MFA denial",
    ),
    "verified-TOTP staff is denied at AAL1",
  );

  await expectState("42501", () => createLearning({
    kind: "orientation",
    title: "Unenrolled staff session",
    user: USERS.unenrolledStaff,
    aal: "aal1",
  }), "staff without an enrolled factor cannot create learning sessions");

  const learning = await createLearning({ title: "Organizing foundations" });
  const assignment = await assignLearning(learning.sessionId);
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.assign_learning_session(
        '${learning.sessionId}',
        '${USERS.bosAdminA}',
        '${requestId()}'
      );`,
      "cross chapter assign",
    ),
    "cross-chapter learning assignment is denied",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.member2,
      "aal1",
      `select public.respond_learning_assignment(
        '${assignment.assignmentId}',
        true,
        '${requestId()}'
      );`,
      "wrong member response",
    ),
    "another member cannot answer an assignment",
  );

  const responseRequest = requestId();
  const accepted = await jsonAs(
    USERS.member,
    "aal1",
    `public.respond_learning_assignment(
      '${assignment.assignmentId}',
      true,
      '${responseRequest}'
    )`,
    "member learning consent",
  );
  assert(accepted.changed && accepted.status === "accepted", "member explicitly accepts learning assignment");

  const completionRequest = requestId();
  const verified = await jsonAs(
    USERS.staff,
    "aal2",
    `public.verify_learning_completion('${assignment.assignmentId}', '${completionRequest}')`,
    "verify learning completion",
  );
  assert(verified.changed && verified.completionId && verified.participationEventId, "learning verification returns full canonical receipt");

  const replay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.verify_learning_completion('${assignment.assignmentId}', '${completionRequest}')`,
    "replay learning completion",
  );
  assert(
    replay.changed === false
      && replay.completionId === verified.completionId
      && replay.participationEventId === verified.participationEventId,
    "lost-response replay returns identical completion and participation IDs",
  );
  await expectState(
    "22023",
    () => asUser(
      USERS.staff,
      "aal2",
      `select public.verify_learning_completion('${assignment.assignmentId}', '${requestId()}');`,
      "mismatched completion replay",
    ),
    "terminal completion rejects a different request key",
  );

  const provenance = await scalar(`
select pg_catalog.concat_ws(',',
  c.activity_kind,
  c.rung,
  (c.learning_assignment_id is not null and c.capacity_commitment_id is null),
  (e.source_id = c.id::text),
  (e.verified_at >= a.responded_at)
)
from public.member_participation_completions c
join public.member_participation_events e on e.canonical_completion_id = c.id
join public.member_learning_assignments a on a.id = c.learning_assignment_id
where c.id = '${verified.completionId}';`, "canonical provenance");
  assert(provenance === "training_complete,learn,t,t,t", "learning provenance is source-bound and chronological", provenance);
  const memberReceipt = parseJson(await asUser(
    USERS.member,
    "aal1",
    `select pg_catalog.jsonb_build_object(
      'activityKind', activity_kind,
      'rung', rung,
      'sourceKind', source_kind,
      'sourceId', source_id,
      'occurredAt', occurred_at
    )
    from public.member_participation_events
    where user_id = '${USERS.member}'
      and source_id = '${verified.completionId}';`,
    "member safe participation receipt",
  ));
  assert(
    memberReceipt.activityKind === "training_complete"
      && memberReceipt.rung === "learn"
      && memberReceipt.sourceId,
    "member can read only the safe participation receipt projection",
  );
  await expectState(
    "42501",
    () => asUser(
      USERS.member,
      "aal1",
      `select verified_by, canonical_completion_id
       from public.member_participation_events
       where id = '${verified.participationEventId}';`,
      "member internal participation receipt",
    ),
    "member cannot read verifier or canonical completion identifiers",
  );

  const recognition = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_member_recognition('${verified.participationEventId}')`,
    "record recognition",
  );
  const recognitionReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_member_recognition('${verified.participationEventId}')`,
    "replay recognition",
  );
  assert(recognition.changed && recognitionReplay.changed === false, "recognition is idempotent");

  const summary = await jsonAs(
    USERS.member,
    "aal1",
    "public.get_member_recognition_summary()",
    "member recognition summary",
  );
  assert(summary.totalVerified === 1 && summary.currentRung === "learn", "member summary reflects verified recognition");

  await runPsql(`
insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret
) values (
  '30000000-0000-4000-8000-000000000002',
  '${USERS.member}',
  'runtime',
  'totp',
  'verified',
  pg_catalog.now(),
  pg_catalog.now(),
  null
);`, "member MFA fixture");
  await expectState(
    "42501",
    () => asUser(
      USERS.member,
      "aal1",
      "select public.get_member_recognition_summary();",
      "summary MFA denial",
    ),
    "recognition summary fails closed at AAL1 after TOTP enrollment",
  );
  const elevated = await jsonAs(
    USERS.member,
    "aal2",
    "public.get_member_recognition_summary()",
    "elevated recognition summary",
  );
  assert(elevated.totalVerified === 1, "AAL2 recognition summary remains accurate");

  await expectState(
    "42501",
    () => asUser(
      USERS.member,
      "aal2",
      `select verified_by from public.member_recognition_events where id = '${recognition.recognitionId}';`,
      "private verifier column",
    ),
    "member cannot select verifier UUID",
  );
  const safeColumn = await asUser(
    USERS.member,
    "aal2",
    `select source_label from public.member_recognition_events where id = '${recognition.recognitionId}';`,
    "safe recognition projection",
  );
  assert(lastLine(safeColumn.stdout) === "Organizing foundations", "member can read safe recognition projection");

  await expectState(
    "42501",
    () => asUser(
      USERS.member,
      "aal2",
      `insert into public.member_learning_sessions (
        chapter_id, learning_kind, title, starts_at, ends_at, created_by, request_id
      ) values (
        'psg-runtime-main', 'training', 'Forbidden direct insert',
        pg_catalog.now() - interval '2 hours',
        pg_catalog.now() - interval '1 hour',
        '${USERS.member}',
        '${requestId()}'
      );`,
      "direct canonical DML",
    ),
    "browser direct canonical DML is denied",
  );

  return verified;
}

async function verifyCapacity() {
  const offerRequest = requestId();
  const offered = await jsonAs(
    USERS.staff,
    "aal2",
    `public.offer_capacity_commitment(
      '${USERS.member}',
      'peer_outreach',
      'Welcome-call commitment',
      '${offerRequest}'
    )`,
    "offer capacity commitment",
  );
  const responseRequest = requestId();
  const accepted = await jsonAs(
    USERS.member,
    "aal2",
    `public.respond_capacity_commitment(
      '${offered.commitmentId}',
      true,
      '${responseRequest}'
    )`,
    "accept capacity commitment",
  );
  assert(accepted.status === "accepted" && accepted.revision === 2, "capacity commitment records consent");

  const started = await jsonAs(
    USERS.member,
    "aal2",
    `public.start_capacity_commitment('${offered.commitmentId}', 2)`,
    "start capacity commitment",
  );
  const replay = await jsonAs(
    USERS.member,
    "aal2",
    `public.start_capacity_commitment('${offered.commitmentId}', 2)`,
    "replay capacity start",
  );
  assert(started.changed && replay.changed === false && replay.revision === 3, "capacity lost-response retry is idempotent");

  const completionRequest = requestId();
  const verified = await jsonAs(
    USERS.staff,
    "aal2",
    `public.verify_capacity_commitment('${offered.commitmentId}', '${completionRequest}')`,
    "verify capacity commitment",
  );
  const verifiedReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.verify_capacity_commitment('${offered.commitmentId}', '${completionRequest}')`,
    "replay capacity completion",
  );
  assert(
    verified.changed
      && verifiedReplay.changed === false
      && verifiedReplay.participationEventId === verified.participationEventId,
    "capacity verification returns stable full receipt",
  );
  const recognized = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_member_recognition('${verified.participationEventId}')`,
    "recognize capacity completion",
  );
  assert(recognized.changed, "eligible capacity completion can be recognized");
  return verified;
}

async function verifyChronologyRace() {
  const learning = await createLearning({ title: "Chronology race session" });
  const assignment = await assignLearning(learning.sessionId);
  const responseRequest = requestId();
  const completionRequest = requestId();

  const responderSql = `begin;
-- Match the public writer's admission order before holding its row. Locking
-- the row first would create a fixture-only inversion against the verifier.
select private.lock_case_graph(array['${USERS.member}'::uuid], array[]::uuid[]);
select id
from public.member_learning_assignments
where id = '${assignment.assignmentId}'
for update;
${claimsSql(USERS.member, "aal2")}
select pg_catalog.pg_sleep(0.6);
select public.respond_learning_assignment(
  '${assignment.assignmentId}',
  true,
  '${responseRequest}'
);
commit;`;
  // Attach the handler in the same tick the promise is created. The 100 ms
  // pause below is deliberate (the responder must hold its row lock before the
  // verifier starts), but an unhandled responder rejection during that window
  // crashes the whole run with ERR_UNHANDLED_REJECTION instead of reporting the
  // psql failure. Capturing it here preserves the error.stderr/error.sqlState
  // fields runPsql attaches.
  const responder = runPsql(responderSql, "chronology responder");
  let responderError = null;
  const responderSettled = responder.catch((error) => {
    responderError = error;
  });
  await pause(100);
  const verifier = asUser(
    USERS.staff,
    "aal2",
    `select public.verify_learning_completion(
      '${assignment.assignmentId}',
      '${completionRequest}'
    );`,
    "chronology verifier",
  );
  await Promise.all([responderSettled, verifier]);
  if (responderError) throw responderError;

  const chronological = await scalar(`
select (verified_at >= responded_at)::text
from public.member_learning_assignments
where id = '${assignment.assignmentId}';`, "chronology assertion");
  assert(chronological === "true", "blocked verification cannot predate member consent");
}

async function verifyCompletionAndRecognitionConcurrency() {
  const learning = await createLearning({ title: "Concurrent verification session" });
  const assignment = await assignLearning(learning.sessionId);
  await acceptLearning(assignment.assignmentId);
  const completionRequest = requestId();

  // Enter through the public writer in both transactions. Pre-locking the
  // source row outside the function would invert its reset-mutex-first order
  // and manufacture a deadlock that real callers cannot create.
  const [firstJson, secondJson] = await Promise.all([
    jsonAs(
      USERS.staff,
      "aal2",
      `public.verify_learning_completion(
        '${assignment.assignmentId}',
        '${completionRequest}'
      )`,
      "concurrent completion A",
    ),
    jsonAs(
      USERS.staff,
      "aal2",
      `public.verify_learning_completion(
        '${assignment.assignmentId}',
        '${completionRequest}'
      )`,
      "concurrent completion B",
    ),
  ]);
  const completionChanges = [firstJson.changed, secondJson.changed].sort();
  const participationEventId = firstJson.participationEventId;
  assert(
    completionChanges[0] === false
      && completionChanges[1] === true
      && firstJson.participationEventId === secondJson.participationEventId,
    "concurrent same-source verification writes one canonical outcome",
  );

  const [recognitionA, recognitionB] = await Promise.all([
    jsonAs(
      USERS.staff,
      "aal2",
      `public.record_member_recognition('${participationEventId}')`,
      "concurrent recognition A",
    ),
    jsonAs(
      USERS.staff,
      "aal2",
      `public.record_member_recognition('${participationEventId}')`,
      "concurrent recognition B",
    ),
  ]);
  const changes = [recognitionA.changed, recognitionB.changed].sort();
  assert(changes[0] === false && changes[1] === true, "concurrent duplicate recognition increments once");

  const atomicCounts = await scalar(`
select pg_catalog.concat_ws(',',
  (select pg_catalog.count(*) from public.member_participation_completions where learning_assignment_id = '${assignment.assignmentId}'),
  (select pg_catalog.count(*) from public.member_participation_events e join public.member_participation_completions c on c.id = e.canonical_completion_id where c.learning_assignment_id = '${assignment.assignmentId}'),
  (select pg_catalog.count(*) from public.member_recognition_events where participation_event_id = '${participationEventId}')
);`, "concurrent atomic counts");
  assert(atomicCounts === "1,1,1", "concurrency preserves one completion, participation, and recognition", atomicCounts);
}

async function verifyCounters() {
  const mismatches = Number(await scalar(`
with actual as (
  select
    user_id,
    pg_catalog.date_trunc('week', verified_at at time zone 'UTC')::date as week_start_utc,
    pg_catalog.count(*)::integer as used_count
  from public.member_recognition_events
  group by 1, 2
),
total_mismatch as (
  select 1
  from actual
  full join private.member_recognition_week_totals using (user_id, week_start_utc)
  where coalesce(actual.used_count, 0)
     <> coalesce(member_recognition_week_totals.used_count, 0)
),
actual_kind as (
  select
    user_id,
    pg_catalog.date_trunc('week', verified_at at time zone 'UTC')::date as week_start_utc,
    recognition_kind,
    pg_catalog.count(*)::integer as used_count
  from public.member_recognition_events
  group by 1, 2, 3
),
kind_mismatch as (
  select 1
  from actual_kind
  full join private.member_recognition_week_kind_totals
    using (user_id, week_start_utc, recognition_kind)
  where coalesce(actual_kind.used_count, 0)
     <> coalesce(member_recognition_week_kind_totals.used_count, 0)
)
select (select pg_catalog.count(*) from total_mismatch)
     + (select pg_catalog.count(*) from kind_mismatch);`, "counter reconciliation"));
  assert(mismatches === 0, "persisted global and per-kind counters reconcile to recognition rows");
}

async function verifyLastAdminConcurrency() {
  // The legacy chapter-role revoke RPC was retired (20260917050000); the selected-tenant
  // command public.set_member_chapter_role is the live way to remove a chapter
  // role. Its tenant lock re-checks the caller's authority after the rival
  // revocation commits, so the loser fails closed.
  const calls = [
    asUser(
      USERS.bosAdminA,
      "aal2",
      `select public.set_member_chapter_role('${USERS.bosAdminB}', 'psg-runtime-other', 'admin', false);`,
      "admin concurrency A",
    ),
    asUser(
      USERS.bosAdminB,
      "aal2",
      `select public.set_member_chapter_role('${USERS.bosAdminA}', 'psg-runtime-other', 'admin', false);`,
      "admin concurrency B",
    ),
  ];
  const results = await Promise.allSettled(calls);
  const successes = results.filter((result) => result.status === "fulfilled");
  const failures = results.filter((result) => result.status === "rejected");
  assert(successes.length === 1 && failures.length === 1, "last-two-admin race has exactly one winner");
  assert(
    ["22023", "40001", "42501"].includes(failures[0].reason.sqlState),
    "last-admin loser fails closed with expected SQLSTATE",
    failures[0].reason.sqlState || "unknown",
  );
  const remaining = Number(await scalar(`
select pg_catalog.count(*)
from public.member_roles
where chapter_id = 'psg-runtime-other' and role = 'admin';`, "remaining admins"));
  assert(remaining === 1, "last-admin race never leaves a chapter without an admin");
}

async function verifyMfaResetEpoch() {
  // October 14 reconciliation replaced July's request/complete epoch API with
  // the shared live-session boundary. Test that protocol, not retired RPCs.
  const retired = await scalar(`select pg_catalog.concat_ws(',',
    to_regclass('private.unionground_member_security_epochs') is null,
    to_regclass('private.unionground_mfa_reset_commands') is null,
    to_regclass('private.unionground_mfa_reset_requests') is null,
    to_regprocedure('public.begin_mfa_reset(uuid,uuid)') is null,
    to_regprocedure('public.complete_mfa_reset(uuid,uuid)') is null);`);
  assert(retired === "t,t,t,t,t", "only the current MFA reset protocol is installed");
  await expectState("42501", () => asUser(USERS.admin, "aal2",
    `select public.begin_mfa_reset('${USERS.bosAdminA}');`, "cross-organization MFA reset"),
  "admin cannot reset MFA across organizations");

  await runPsql(`insert into auth.mfa_factors
    (id,user_id,friendly_name,factor_type,status,created_at,updated_at,secret)
    values ('30000000-0000-4000-8000-000000000003','${USERS.member2}',
      'reset-runtime','totp','verified',now(),now(),null);`, "reset target factor");
  await jsonAs(USERS.member2, "aal2", "public.rotate_calendar_feed_token()", "calendar capability before reset");
  const begun = await jsonAs(USERS.admin, "aal2",
    `public.begin_mfa_reset('${USERS.member2}')`, "begin current MFA reset");
  assert(begun.authorized && begun.staleSessionsBlocked && begun.userId === USERS.member2,
    "reset establishes a session boundary before factor deletion");
  const before = await scalar(`select invalid_before::text from private.member_mfa_reset_boundaries
    where user_id='${USERS.member2}';`);
  const stale = await scalar(`begin;
${claimsSql(USERS.member2, "aal2")}
select private.mfa_satisfied(); commit;`, "pre-reset session");
  assert(stale === "f", "a pre-reset AAL2 session is immediately refused");
  assert(await scalar(`select count(*) from public.member_calendar_feed_tokens
    where user_id='${USERS.member2}';`) === "0", "reset revokes the calendar bearer capability");

  await runPsql(`delete from auth.mfa_factors where user_id='${USERS.member2}';`, "provider factor removal");
  const recorded = await jsonAs(USERS.admin, "aal2",
    `public.record_mfa_reset('${USERS.member2}',1)`, "record provider cleanup");
  assert(recorded.recorded && recorded.userId === USERS.member2, "factor cleanup is recorded through the current API");
  assert(await scalar(`begin;
${claimsSql(USERS.member2, "aal1")}
select private.mfa_satisfied(); commit;`) === "f", "factor removal does not revive a stale session");

  const freshSession = requestId();
  await runPsql(`insert into auth.sessions (id,user_id,created_at,updated_at,aal,not_after)
    values ('${freshSession}','${USERS.member2}',clock_timestamp(),clock_timestamp(),'aal1',now()+interval '1 day');`);
  SESSION_IDS_BY_USER.set(USERS.member2, freshSession);
  assert(await scalar(`begin;
${claimsSql(USERS.member2, "aal1")}
select private.mfa_satisfied(); commit;`) === "t", "a fresh post-reset no-factor session is admissible");
  await jsonAs(USERS.admin, "aal2", `public.begin_mfa_reset('${USERS.member2}')`, "repeat reset boundary");
  assert(await scalar(`select (invalid_before >= ${sqlString(before)}::timestamptz)::text
    from private.member_mfa_reset_boundaries where user_id='${USERS.member2}';`) === "true",
  "repeated reset never moves the boundary backwards");
  assert(await scalar(`begin;
${claimsSql(USERS.member2, "aal1")}
select private.mfa_satisfied(); commit;`) === "f", "a newer reset revokes the newly established session too");
}

// The bargaining phases assert the same audit-privacy invariant against the
// same campaign at two different points in the cycle. The query is identical;
// only the phase label differs, so it lives here rather than being pasted twice.
async function assertNoPrivateAudit(campaignId, label) {
  const auditSecrets = Number(await scalar(`
select pg_catalog.count(*)
from public.union_lifecycle_audit_events
where campaign_id = '${campaignId}'
  and (
    coalesce(reason, '') like '%PRIVATE-%'
    or safe_metadata::text like '%PRIVATE-%'
    or safe_metadata::text ~ '[0-9a-f]{64}'
  );`, `${label} audit privacy`));
  assert(
    auditSecrets === 0,
    `${label} audit metadata contains no private content or evidence reference`,
  );
}

async function verifyBargainingWriters() {
  const runtimeDate = await scalar("select current_date::text;", "bargaining fixture date");
  const agreementHash = "b".repeat(64);
  const tallyHash = "c".repeat(64);
  const contractHash = "d".repeat(64);
  const correctionHash = "f".repeat(64);
  const revokedContractHash = "a".repeat(64);
  const campaignRequest = requestId();
  const created = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_campaign(
      'Runtime first contract',
      'Runtime bargaining employer',
      'Runtime bargaining worksite',
      'Runtime bargaining unit',
      '${campaignRequest}',
      'voluntary_recognition',
      100
    )`,
    "create bargaining runtime campaign",
  );
  await runPsql(`
update public.organizing_campaigns
set stage = 'certification',
    stage_started_at = pg_catalog.clock_timestamp()
where id = '${created.campaignId}';`, "prepare bargaining campaign");

  await expectState(
    "22023",
    () => jsonAs(
      USERS.bargainer,
      "aal2",
      `public.open_organizing_bargaining_cycle(
        '${created.campaignId}',
        1,
        'Runtime first contract',
        '${requestId()}',
        date '${runtimeDate}' + 180,
        'Prepare proposals',
        null
      )`,
      "unassigned coordinator bargaining open",
    ),
    "unassigned coordinator cannot write a bargaining campaign",
  );

  await runPsql(`
insert into public.organizing_campaign_assignments (
  campaign_id,
  chapter_id,
  user_id,
  assignment_role,
  granted_by
) values (
  '${created.campaignId}',
  'psg-runtime-main',
  '${USERS.bargainer}',
  'coordinator',
  '${USERS.admin}'
);`, "assign bargaining coordinator");

  await expectState(
    "42501",
    () => jsonAs(
      USERS.staff,
      "aal1",
      `public.open_organizing_bargaining_cycle(
        '${created.campaignId}',
        1,
        'Runtime first contract',
        '${requestId()}',
        date '${runtimeDate}' + 180,
        'Prepare proposals',
        null
      )`,
      "AAL1 bargaining open",
    ),
    "bargaining writers require AAL2 even for an assigned organizer",
  );

  const openRequest = requestId();
  const opened = await jsonAs(
    USERS.staff,
    "aal2",
    `public.open_organizing_bargaining_cycle(
      '${created.campaignId}',
      1,
      'Runtime first contract',
      '${openRequest}',
      date '${runtimeDate}' + 180,
      'Prepare proposals',
      null
    )`,
    "open bargaining cycle",
  );
  const openReplay = await jsonAs(
    USERS.staff,
    "aal2",
    `public.open_organizing_bargaining_cycle(
      '${created.campaignId}',
      1,
      'Runtime first contract',
      '${openRequest}',
      date '${runtimeDate}' + 180,
      'Prepare proposals',
      null
    )`,
    "replay bargaining cycle open",
  );
  assert(
    opened.changed === true
      && opened.phase === "preparing"
      && opened.revision === 1
      && openReplay.changed === false
      && openReplay.auditEventId === opened.auditEventId,
    "bargaining cycle open has one durable retry receipt",
  );
  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.open_organizing_bargaining_cycle(
        '${created.campaignId}',
        1,
        'Changed title',
        '${openRequest}',
        date '${runtimeDate}' + 180,
        'Prepare proposals',
        null
      )`,
      "changed bargaining open replay",
    ),
    "bargaining request IDs reject changed input",
  );

  let cycleRevision = 1;
  let campaignRevision = 1;
  const prestartSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.schedule_organizing_bargaining_session(
      '${opened.cycleId}',
      ${cycleRevision},
      pg_catalog.now() - interval '2 days',
      '${requestId()}',
      'Runtime prestart room',
      'PRIVATE-PRESTART-SESSION-AGENDA'
    )`,
    "schedule prestart bargaining session",
  );
  cycleRevision = prestartSession.cycleRevision;
  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.record_organizing_bargaining_session_outcome(
        '${prestartSession.sessionId}',
        ${prestartSession.revision},
        ${cycleRevision},
        'held',
        '${requestId()}',
        pg_catalog.now() - interval '1 day',
        'Premature held session update.',
        'PRIVATE-PREMATURE-SESSION-MINUTES',
        null
      )`,
      "held session before verified bargaining start",
    ),
    "held sessions require a verified bargaining start",
  );
  const cancelledPrestartSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_organizing_bargaining_session_outcome(
      '${prestartSession.sessionId}',
      ${prestartSession.revision},
      ${cycleRevision},
      'cancelled',
      '${requestId()}',
      null,
      null,
      null,
      'Cancelled before bargaining began'
    )`,
    "cancel prestart bargaining session",
  );
  cycleRevision = cancelledPrestartSession.cycleRevision;
  assert(
    cancelledPrestartSession.status === "cancelled"
      && cancelledPrestartSession.revision === prestartSession.revision + 1,
    "prestart sessions remain cancellable without inventing held bargaining",
  );
  await expectState(
    "23514",
    () => runPsql(`
insert into public.organizing_bargaining_sessions (
  cycle_id, campaign_id, chapter_id, session_number, starts_at, status,
  member_update, revision, create_request_id, created_by
) values (
  '${opened.cycleId}', '${created.campaignId}', 'local-292', 9000,
  pg_catalog.now(), 'cancelled', '', 1, '${requestId()}', '${USERS.staff}'
);`, "insert cancelled session without a reason"),
    "table constraint rejects cancelled sessions without a reason",
  );
  const backdatedSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.schedule_organizing_bargaining_session(
      '${opened.cycleId}',
      ${cycleRevision},
      pg_catalog.now() - interval '40 days',
      '${requestId()}',
      'Runtime chronology room',
      'PRIVATE-BACKDATED-SESSION-AGENDA'
    )`,
    "schedule backdated bargaining session",
  );
  cycleRevision = backdatedSession.cycleRevision;
  const proposalPhase = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_bargaining_cycle(
      '${opened.cycleId}',
      ${cycleRevision},
      ${campaignRevision},
      'proposal_development',
      '${requestId()}',
      null,
      'Priorities verified',
      'Draft proposals',
      pg_catalog.now() + interval '5 days'
    )`,
    "enter proposal development",
  );
  cycleRevision = proposalPhase.revision;

  const proposalRequest = requestId();
  const article = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_bargaining_proposal(
      '${opened.cycleId}',
      ${cycleRevision},
      'Scheduling',
      'Predictable schedules',
      'union',
      '${proposalRequest}',
      'article',
      '{}'::uuid[],
      null,
      null,
      null,
      null,
      'The proposal sets advance schedule notice.',
      'PRIVATE-PROPOSAL-NOTES'
    )`,
    "create bargaining proposal",
  );
  cycleRevision = article.cycleRevision;
  assert(
    article.status === "draft"
      && article.recordKind === "article"
      && article.version === 1
      && article.revision === 1,
    "article proposal writer creates immutable version one",
  );

  let articleRevision = article.revision;
  const articleApproved = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_bargaining_proposal(
      '${article.proposalId}',
      ${articleRevision},
      ${cycleRevision},
      'approved',
      '${requestId()}',
      null,
      'Ready for presentation'
    )`,
    "approve article proposal",
  );
  articleRevision = articleApproved.revision;
  cycleRevision = articleApproved.cycleRevision;

  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.transition_organizing_bargaining_proposal(
        '${article.proposalId}',
        ${articleRevision},
        ${cycleRevision},
        'presented',
        '${requestId()}',
        date '${runtimeDate}' - 20,
        'Premature presentation'
      )`,
      "premature article presentation",
    ),
    "formal proposal status is denied before bargaining starts",
  );

  const started = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_bargaining_cycle(
      '${opened.cycleId}',
      ${cycleRevision},
      ${campaignRevision},
      'at_table',
      '${requestId()}',
      date '${runtimeDate}' - 30,
      'Bargaining start verified',
      'Hold session one',
      pg_catalog.now() + interval '2 days'
    )`,
    "record bargaining start",
  );
  cycleRevision = started.revision;
  campaignRevision = started.campaignRevision;
  assert(
    started.phase === "at_table" && campaignRevision === 2,
    "verified table start advances the campaign to bargaining",
  );
  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.record_organizing_bargaining_session_outcome(
        '${backdatedSession.sessionId}',
        ${backdatedSession.revision},
        ${cycleRevision},
        'held',
        '${requestId()}',
        pg_catalog.now() - interval '39 days',
        'Backdated held session update.',
        'PRIVATE-BACKDATED-SESSION-MINUTES',
        null
      )`,
      "held session predating verified bargaining start",
    ),
    "held sessions cannot predate the verified bargaining start",
  );
  const cancelledBackdatedSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_organizing_bargaining_session_outcome(
      '${backdatedSession.sessionId}',
      ${backdatedSession.revision},
      ${cycleRevision},
      'cancelled',
      '${requestId()}',
      null,
      null,
      null,
      'Legacy schedule predates verified bargaining start'
    )`,
    "cancel backdated bargaining session",
  );
  cycleRevision = cancelledBackdatedSession.cycleRevision;
  assert(
    cancelledBackdatedSession.status === "cancelled",
    "backdated schedules remain cancellable after chronology rejection",
  );

  for (const [nextStatus, reason] of [
    ["presented", "Presented at the table"],
    ["accepted", "Article language accepted for package drafting"],
  ]) {
    const transitioned = await jsonAs(
      USERS.staff,
      "aal2",
      `public.transition_organizing_bargaining_proposal(
        '${article.proposalId}',
        ${articleRevision},
        ${cycleRevision},
        '${nextStatus}',
        '${requestId()}',
        date '${runtimeDate}' - 20,
        '${reason}'
      )`,
      `transition article proposal to ${nextStatus}`,
    );
    articleRevision = transitioned.revision;
    cycleRevision = transitioned.cycleRevision;
  }

  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.create_organizing_bargaining_proposal(
        '${opened.cycleId}',
        ${cycleRevision},
        'Whole agreement',
        'Package missing its immutable document hash',
        'joint',
        '${requestId()}',
        'agreement_package',
        array['${article.proposalId}'::uuid],
        null,
        null,
        null,
        null,
        'Member-safe package summary.',
        null
      )`,
      "agreement package without hash",
    ),
    "agreement package requires an immutable document hash",
  );
  await expectState(
    "22023",
    () => jsonAs(
      USERS.staff,
      "aal2",
      `public.create_organizing_bargaining_proposal(
        '${opened.cycleId}',
        ${cycleRevision},
        'Whole agreement',
        'Package with a nonexistent article reference',
        'joint',
        '${requestId()}',
        'agreement_package',
        array['90000000-0000-4000-8000-000000000001'::uuid],
        '${agreementHash}',
        null,
        null,
        null,
        'Member-safe package summary.',
        null
      )`,
      "agreement package with a nonexistent article reference",
    ),
    "agreement package rejects nonexistent included proposal IDs",
  );

  const packageRequest = requestId();
  const proposal = await jsonAs(
    USERS.staff,
    "aal2",
    `public.create_organizing_bargaining_proposal(
      '${opened.cycleId}',
      ${cycleRevision},
      'Whole agreement',
      'Runtime whole-agreement package',
      'joint',
      '${packageRequest}',
      'agreement_package',
      array['${article.proposalId}'::uuid],
      '${agreementHash}',
      null,
      null,
      null,
      'The full first-contract package is ready for the external decision process.',
      'PRIVATE-PACKAGE-NOTES'
    )`,
    "create whole-agreement package",
  );
  cycleRevision = proposal.cycleRevision;
  assert(
    proposal.status === "draft"
      && proposal.recordKind === "agreement_package"
      && proposal.version === 1,
    "whole-agreement package binds current article versions and document hash",
  );

  let proposalRevision = proposal.revision;
  for (const [nextStatus, presentedOn] of [
    ["approved", "null"],
    ["presented", `date '${runtimeDate}' - 10`],
    ["tentative_agreement", `date '${runtimeDate}' - 10`],
  ]) {
    if (nextStatus === "tentative_agreement") {
      for (const forbiddenStatus of ["accepted", "rejected"]) {
        await expectState(
          "22023",
          () => jsonAs(
            USERS.staff,
            "aal2",
            `public.transition_organizing_bargaining_proposal(
              '${proposal.proposalId}',
              ${proposalRevision},
              ${cycleRevision},
              '${forbiddenStatus}',
              '${requestId()}',
              null,
              'Agreement packages require the tentative-agreement path'
            )`,
            `transition agreement package to forbidden ${forbiddenStatus}`,
          ),
          `agreement packages cannot enter the ${forbiddenStatus} terminal sink`,
        );
      }

      const unresolved = await jsonAs(
        USERS.staff,
        "aal2",
        `public.create_organizing_bargaining_proposal(
          '${opened.cycleId}',
          ${cycleRevision},
          'Unresolved article',
          'Runtime unresolved article',
          'union',
          '${requestId()}',
          'article',
          array[]::uuid[],
          null,
          null,
          null,
          null,
          'Member-safe unresolved article.',
          null
        )`,
        "create unresolved current article",
      );
      cycleRevision = unresolved.cycleRevision;
      await expectState(
        "22023",
        () => jsonAs(
          USERS.staff,
          "aal2",
          `public.transition_organizing_bargaining_proposal(
            '${proposal.proposalId}',
            ${proposalRevision},
            ${cycleRevision},
            'tentative_agreement',
            '${requestId()}',
            ${presentedOn},
            'Incomplete package must remain open'
          )`,
          "premature tentative agreement with unresolved article",
        ),
        "tentative agreement rejects unresolved current article leaves",
      );
      const withdrawn = await jsonAs(
        USERS.staff,
        "aal2",
        `public.transition_organizing_bargaining_proposal(
          '${unresolved.proposalId}',
          ${unresolved.revision},
          ${cycleRevision},
          'withdrawn',
          '${requestId()}',
          null,
          'Article excluded before the whole agreement became tentative'
        )`,
        "withdraw unresolved article",
      );
      cycleRevision = withdrawn.cycleRevision;
    }

    const transitioned = await jsonAs(
      USERS.staff,
      "aal2",
      `public.transition_organizing_bargaining_proposal(
        '${proposal.proposalId}',
        ${proposalRevision},
        ${cycleRevision},
        '${nextStatus}',
        '${requestId()}',
        ${presentedOn},
        'Whole-package workflow verification'
      )`,
      `transition agreement package to ${nextStatus}`,
    );
    proposalRevision = transitioned.revision;
    cycleRevision = transitioned.cycleRevision;
  }

  const session = await jsonAs(
    USERS.staff,
    "aal2",
    `public.schedule_organizing_bargaining_session(
      '${opened.cycleId}',
      ${cycleRevision},
      pg_catalog.now() - interval '1 day',
      '${requestId()}',
      'Runtime union hall',
      'PRIVATE-SESSION-AGENDA'
    )`,
    "schedule bargaining session",
  );
  cycleRevision = session.cycleRevision;
  const held = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_organizing_bargaining_session_outcome(
      '${session.sessionId}',
      ${session.revision},
      ${cycleRevision},
      'held',
      '${requestId()}',
      pg_catalog.now(),
      'Member-safe session update.',
      'PRIVATE-SESSION-MINUTES',
      null
    )`,
    "record held bargaining session",
  );
  cycleRevision = held.cycleRevision;
  assert(
    held.status === "held" && held.revision === 2,
    "session outcome uses canonical held state",
  );

  const tentative = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_bargaining_cycle(
      '${opened.cycleId}',
      ${cycleRevision},
      ${campaignRevision},
      'tentative_agreement',
      '${requestId()}',
      null,
      'Tentative agreement identified',
      'Prepare sourced ratification record',
      pg_catalog.now() + interval '3 days'
    )`,
    "enter tentative agreement",
  );
  cycleRevision = tentative.revision;
  const ratificationPhase = await jsonAs(
    USERS.staff,
    "aal2",
    `public.transition_organizing_bargaining_cycle(
      '${opened.cycleId}',
      ${cycleRevision},
      ${campaignRevision},
      'ratification',
      '${requestId()}',
      null,
      'External process scheduled',
      'Verify external aggregate',
      pg_catalog.now() + interval '4 days'
    )`,
    "enter ratification",
  );
  cycleRevision = ratificationPhase.revision;

  const ratificationSql = ({
    user,
    request,
    expectedCycleRevision,
    reported,
    reference,
  }) => jsonAs(
    user,
    "aal2",
    `public.record_organizing_ratification(
      '${opened.cycleId}',
      ${expectedCycleRevision},
      ${campaignRevision},
      '${proposal.proposalId}',
      '${agreementHash}',
      'vote',
      date '${runtimeDate}' - 1,
      '${reported}',
      'union_report',
      '${reference}',
      '${tallyHash}',
      'Approval requires more than half of non-abstaining ballots.',
      'Verified eligibility roster as of the decision date.',
      100,
      80,
      60,
      20,
      0,
      0,
      50,
      1,
      2,
      'more_than',
      'non_abstaining',
      '${request}'
    )`,
    `ratification ${reported}`,
  );

  await expectState(
    "22023",
    () => ratificationSql({
      user: USERS.staff,
      request: requestId(),
      expectedCycleRevision: cycleRevision,
      reported: "approved",
      reference: "PRIVATE-ORGANIZER-TALLY",
    }),
    "ratification certification is coordinator-only",
  );

  const mismatchRequest = requestId();
  const mismatch = await ratificationSql({
    user: USERS.bargainer,
    request: mismatchRequest,
    expectedCycleRevision: cycleRevision,
    reported: "rejected",
    reference: "PRIVATE-MISMATCH-TALLY",
  });
  const mismatchReplay = await ratificationSql({
    user: USERS.bargainer,
    request: mismatchRequest,
    expectedCycleRevision: cycleRevision,
    reported: "rejected",
    reference: "PRIVATE-MISMATCH-TALLY",
  });
  cycleRevision = mismatch.revision;
  assert(
    mismatch.outcome === "indeterminate"
      && mismatch.phase === "ratification"
      && mismatch.campaignStage === "bargaining"
      && mismatchReplay.changed === false
      && mismatchReplay.auditEventId === mismatch.auditEventId,
    "source/calculation mismatch is retry-safe and cannot advance",
  );

  await expectState(
    "23514",
    () => runPsql(`
insert into public.organizing_bargaining_ratifications (
  cycle_id, campaign_id, chapter_id, agreement_proposal_id, agreement_sha256,
  decision_method, held_on, source_reported_outcome, computed_outcome,
  source_kind, source_reference, source_sha256, rule_summary, eligibility_source,
  eligible_count, ballots_cast, approve_count, reject_count, abstain_count,
  invalid_count, quorum_required_count, threshold_numerator,
  threshold_denominator, approval_comparator, approval_denominator,
  recorded_by, create_request_id
) values (
  '${opened.cycleId}', '${created.campaignId}', 'local-292',
  '${proposal.proposalId}', '${agreementHash}', 'vote',
  date '${runtimeDate}' - 1, 'approved', 'rejected', 'union_report',
  'PRIVATE-DIRECT-INCONSISTENT-TALLY', '${tallyHash}',
  'Approval requires more than half of non-abstaining ballots.',
  'Verified eligibility roster as of the decision date.',
  100, 80, 60, 20, 0, 0, 50, 1, 2, 'more_than', 'non_abstaining',
  '${USERS.bargainer}', '${requestId()}'
);`, "insert tally-inconsistent ratification evidence"),
    "table constraint rejects tally-inconsistent computed outcomes",
  );
  await expectState(
    "23503",
    () => runPsql(`
insert into public.organizing_bargaining_ratifications (
  cycle_id, campaign_id, chapter_id, agreement_proposal_id, agreement_sha256,
  decision_method, held_on, source_reported_outcome, computed_outcome,
  source_kind, source_reference, source_sha256, rule_summary, eligibility_source,
  eligible_count, ballots_cast, approve_count, reject_count, abstain_count,
  invalid_count, quorum_required_count, threshold_numerator,
  threshold_denominator, approval_comparator, approval_denominator,
  recorded_by, create_request_id
) values (
  '${opened.cycleId}', '${created.campaignId}', 'local-292',
  '${proposal.proposalId}', '${"e".repeat(64)}', 'vote',
  date '${runtimeDate}' - 1, 'approved', 'approved', 'union_report',
  'PRIVATE-DIRECT-WRONG-AGREEMENT', '${tallyHash}',
  'Approval requires more than half of non-abstaining ballots.',
  'Verified eligibility roster as of the decision date.',
  100, 80, 60, 20, 0, 0, 50, 1, 2, 'more_than', 'non_abstaining',
  '${USERS.bargainer}', '${requestId()}'
);`, "insert ratification with unbound agreement hash"),
    "table foreign key binds ratification evidence to the proposal document hash",
  );

  const ratificationRequest = requestId();
  let approved = await ratificationSql({
    user: USERS.bargainer,
    request: ratificationRequest,
    expectedCycleRevision: cycleRevision,
    reported: "approved",
    reference: "PRIVATE-APPROVED-TALLY",
  });
  cycleRevision = approved.revision;
  campaignRevision = approved.campaignRevision;
  assert(
    approved.outcome === "approved"
      && approved.phase === "execution"
      && approved.campaignStage === "first_contract"
      && campaignRevision === 3,
    "matched staff-verified aggregate opens first-contract execution",
  );

  const originalApproved = approved;
  const correctionRequest = requestId();
  const correctionExpression = `public.correct_organizing_ratification(
    '${originalApproved.ratificationId}',
    ${cycleRevision},
    ${campaignRevision},
    'duplicate_record',
    'official_record',
    'PRIVATE-RATIFICATION-CORRECTION',
    '${correctionHash}',
    '${correctionRequest}'
  )`;
  const correction = await jsonAs(
    USERS.bargainer,
    "aal2",
    correctionExpression,
    "correct ratification authorization",
  );
  const correctionReplay = await jsonAs(
    USERS.bargainer,
    "aal2",
    correctionExpression,
    "replay ratification correction",
  );
  cycleRevision = correction.revision;
  campaignRevision = correction.campaignRevision;
  assert(
    correction.corrected === true
      && correction.phase === "ratification"
      && correction.campaignStage === "bargaining"
      && correction.integrityHold === false
      && correction.restoredRatificationId === mismatch.ratificationId
      && correctionReplay.changed === false
      && correctionReplay.correctionId === correction.correctionId,
    "duplicate correction restores the prior current fact and is retry-safe",
  );
  await expectState(
    "42501",
    () => runPsql(`
update public.organizing_bargaining_ratification_corrections
set reason_code = 'other'
where id = '${correction.correctionId}';`, "mutate ratification correction"),
    "ratification correction evidence rejects direct updates",
  );
  await expectState(
    "42501",
    () => runPsql(`
delete from public.organizing_bargaining_ratification_corrections
where id = '${correction.correctionId}';`, "delete ratification correction"),
    "ratification correction evidence rejects direct deletes",
  );

  approved = await ratificationSql({
    user: USERS.bargainer,
    request: requestId(),
    expectedCycleRevision: cycleRevision,
    reported: "approved",
    reference: "PRIVATE-REPLACEMENT-TALLY",
  });
  cycleRevision = approved.revision;
  campaignRevision = approved.campaignRevision;
  assert(
    approved.outcome === "approved"
      && approved.phase === "execution"
      && approved.campaignStage === "first_contract",
    "replacement sourced result becomes the only current authorization",
  );

  await expectState(
    "22023",
    () => jsonAs(
      USERS.bargainer,
      "aal2",
      `public.record_organizing_first_contract(
        '${opened.cycleId}',
        ${cycleRevision},
        ${campaignRevision},
        '${originalApproved.ratificationId}',
        '${agreementHash}',
        date '${runtimeDate}',
        '${requestId()}',
        'executed_contract',
        'PRIVATE-REVOKED-CONTRACT-REFERENCE',
        '${revokedContractHash}',
        4,
        4,
        date '${runtimeDate}' - 10,
        date '${runtimeDate}' + 730
      )`,
      "contract with corrected ratification",
    ),
    "corrected non-current ratification cannot authorize a contract",
  );

  await expectState(
    "22023",
    () => runPsql(`
update public.organizing_campaigns
set stage = 'established',
    status = 'closed',
    outcome = 'established',
    closed_at = pg_catalog.clock_timestamp()
where id = '${created.campaignId}';`, "premature established update"),
    "campaign stage guard rejects established before typed contract",
  );
  await expectState(
    "22023",
    () => runPsql(`
update public.organizing_campaigns
set status = 'closed',
    outcome = 'lost',
    outcome_reason = 'Invalid close after execution authority',
    closed_at = pg_catalog.clock_timestamp()
where id = '${created.campaignId}';`, "close first-contract campaign without contract"),
    "campaign status guard rejects closing an authorized first-contract workflow",
  );

  await expectState(
    "22023",
    () => jsonAs(
      USERS.bargainer,
      "aal2",
      `public.record_organizing_first_contract(
        '${opened.cycleId}',
        ${cycleRevision},
        ${campaignRevision},
        '${approved.ratificationId}',
        '${agreementHash}',
        date '${runtimeDate}',
        '${requestId()}',
        'executed_contract',
        'PRIVATE-CONTRACT-REFERENCE',
        '${contractHash}',
        4,
        3,
        date '${runtimeDate}' - 10,
        date '${runtimeDate}' + 730
      )`,
      "incomplete signatory contract",
    ),
    "contract writer rejects incomplete signatory verification",
  );

  const pendingSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.schedule_organizing_bargaining_session(
      '${opened.cycleId}',
      ${cycleRevision},
      pg_catalog.now() + interval '1 day',
      '${requestId()}',
      'Runtime closeout room',
      'PRIVATE-PENDING-SESSION-AGENDA'
    )`,
    "schedule pending execution-phase session",
  );
  cycleRevision = pendingSession.cycleRevision;
  const pendingSessionWorkspace = await jsonAs(
    USERS.bargainer,
    "aal2",
    "public.get_bargaining_workspace()",
    "pending-session bargaining workspace",
  );
  const pendingSessionCycle = pendingSessionWorkspace.bargaining.find(
    (row) => row.id === opened.cycleId,
  );
  assert(
    pendingSessionCycle?.canRecordFirstContract === false
      && pendingSessionCycle?.canRecordSessionOutcome === true,
    "pending sessions hide contract completion but preserve closeout capability",
  );
  await expectState(
    "22023",
    () => jsonAs(
      USERS.bargainer,
      "aal2",
      `public.record_organizing_first_contract(
        '${opened.cycleId}',
        ${cycleRevision},
        ${campaignRevision},
        '${approved.ratificationId}',
        '${agreementHash}',
        date '${runtimeDate}',
        '${requestId()}',
        'executed_contract',
        'PRIVATE-CONTRACT-WITH-PENDING-SESSION',
        '${contractHash}',
        4,
        4,
        date '${runtimeDate}' - 10,
        date '${runtimeDate}' + 730
      )`,
      "contract with pending bargaining session",
    ),
    "contract completion rejects stranded scheduled sessions",
  );
  const cancelledSession = await jsonAs(
    USERS.staff,
    "aal2",
    `public.record_organizing_bargaining_session_outcome(
      '${pendingSession.sessionId}',
      ${pendingSession.revision},
      ${cycleRevision},
      'cancelled',
      '${requestId()}',
      null,
      null,
      null,
      'Contract execution superseded the planned bargaining session'
    )`,
    "cancel pending execution-phase session",
  );
  cycleRevision = cancelledSession.cycleRevision;
  const contractReadyWorkspace = await jsonAs(
    USERS.bargainer,
    "aal2",
    "public.get_bargaining_workspace()",
    "contract-ready bargaining workspace",
  );
  const contractReadyCycle = contractReadyWorkspace.bargaining.find(
    (row) => row.id === opened.cycleId,
  );
  assert(
    contractReadyCycle?.canRecordFirstContract === true,
    "closing the last scheduled session restores contract capability",
  );

  const contractRequest = requestId();
  const contractExpression = `public.record_organizing_first_contract(
    '${opened.cycleId}',
    ${cycleRevision},
    ${campaignRevision},
    '${approved.ratificationId}',
    '${agreementHash}',
    date '${runtimeDate}',
    '${contractRequest}',
    'executed_contract',
    'PRIVATE-CONTRACT-REFERENCE',
    '${contractHash}',
    4,
    4,
    date '${runtimeDate}' - 10,
    date '${runtimeDate}' + 730
  )`;
  const contract = await jsonAs(
    USERS.bargainer,
    "aal2",
    contractExpression,
    "record executed first contract",
  );
  const contractReplay = await jsonAs(
    USERS.bargainer,
    "aal2",
    contractExpression,
    "replay executed first contract",
  );
  cycleRevision = contract.revision;
  assert(
    contract.phase === "complete"
      && contract.status === "source_recorded_fully_signed"
      && contractReplay.changed === false
      && contractReplay.auditEventId === contract.auditEventId,
    "source-recorded fully signed first contract is typed and retry-safe",
  );

  await expectState(
    "22023",
    () => runPsql(`
update public.organizing_bargaining_proposals
set title = 'Mutated title'
where id = '${proposal.proposalId}';`, "mutate proposal snapshot"),
    "proposal version content is immutable",
  );
  await expectState(
    "42501",
    () => runPsql(`
update public.organizing_bargaining_ratifications
set held_on = held_on - 1
where id = '${approved.ratificationId}';`, "mutate ratification evidence"),
    "ratification evidence is append-only",
  );

  const safeWorkspace = await jsonAs(
    USERS.bargainer,
    "aal2",
    "public.get_bargaining_workspace()",
    "safe bargaining workspace",
  );
  const safeText = JSON.stringify(safeWorkspace);
  const safeCycle = safeWorkspace.bargaining.find(
    (row) => row.id === opened.cycleId,
  );
  assert(
    safeCycle
      && safeCycle.canWrite === false
      && safeCycle.canCertify === false
      && safeCycle.canRecordFirstContract === false
      && safeCycle.canCorrectRatification === true
      && safeCycle.ratificationIntegrityHold === false
      && safeCycle.sessions.some(
        (row) => row.id === session.sessionId
          && row.status === "held"
          && row.summary === "Member-safe session update."
      )
      && safeCycle.ratifications.some(
        (row) => row.id === mismatch.ratificationId
          && row.outcome === "indeterminate"
          && row.current === false
          && row.corrected === false
      )
      && safeCycle.ratifications.some(
        (row) => row.id === originalApproved.ratificationId
          && row.corrected === true
          && row.current === false
          && row.supersedesRatificationId === mismatch.ratificationId
          && row.correctionReasonCode === "duplicate_record"
      )
      && safeCycle.ratifications.some(
        (row) => row.id === approved.ratificationId
          && row.corrected === false
          && row.current === true
          && row.supersedesRatificationId === mismatch.ratificationId
      )
      && safeCycle.firstContract.status === "source_recorded_fully_signed",
    "safe workspace exposes typed summaries and exact writer permissions",
  );
  for (const secret of [
    "PRIVATE-PROPOSAL-NOTES",
    "PRIVATE-PACKAGE-NOTES",
    "PRIVATE-SESSION-AGENDA",
    "PRIVATE-SESSION-MINUTES",
    "PRIVATE-MISMATCH-TALLY",
    "PRIVATE-APPROVED-TALLY",
    "PRIVATE-RATIFICATION-CORRECTION",
    "PRIVATE-REVOKED-CONTRACT-REFERENCE",
    "PRIVATE-REPLACEMENT-TALLY",
    "PRIVATE-CONTRACT-REFERENCE",
    agreementHash,
    tallyHash,
    contractHash,
    correctionHash,
    revokedContractHash,
  ]) {
    assert(
      !safeText.includes(secret),
      `safe bargaining workspace excludes ${secret.slice(0, 24)}`,
    );
  }

  await assertNoPrivateAudit(created.campaignId, "bargaining");

  const established = await jsonAs(
    USERS.bargainer,
    "aal2",
    `public.transition_organizing_campaign(
      '${created.campaignId}',
      ${campaignRevision},
      'established',
      '${requestId()}',
      'Typed first contract verified'
    )`,
    "establish campaign after typed contract",
  );
  assert(
    established.stage === "established"
      && established.revision === campaignRevision + 1,
    "typed contract unlocks the existing established transition",
  );
  campaignRevision = established.revision;

  const postContractCorrection = await jsonAs(
    USERS.bargainer,
    "aal2",
    `public.correct_organizing_ratification(
      '${approved.ratificationId}',
      ${cycleRevision},
      ${campaignRevision},
      'source_error',
      'official_record',
      'PRIVATE-POST-CONTRACT-CORRECTION',
      '${correctionHash}',
      '${requestId()}'
    )`,
    "correct ratification after established contract",
  );
  cycleRevision = postContractCorrection.revision;
  assert(
    postContractCorrection.phase === "complete"
      && postContractCorrection.campaignStage === "established"
      && postContractCorrection.campaignRevision === campaignRevision
      && postContractCorrection.integrityHold === true,
    "post-contract correction preserves history and places an integrity hold",
  );

  const heldWorkspace = await jsonAs(
    USERS.bargainer,
    "aal2",
    "public.get_bargaining_workspace()",
    "integrity-hold bargaining workspace",
  );
  const heldCycle = heldWorkspace.bargaining.find(
    (row) => row.id === opened.cycleId,
  );
  const heldText = JSON.stringify(heldWorkspace);
  assert(
    heldCycle
      && heldCycle.ratificationIntegrityHold === true
      && heldCycle.canRecordFirstContract === false
      && heldCycle.canCorrectRatification === false
      && heldCycle.firstContract?.status === "integrity_hold"
      && heldCycle.firstContract?.disputed === true
      && heldCycle.firstContract?.verification
        === "corrected_ratification_requires_governed_resolution"
      && heldCycle.ratifications.every((row) => row.current === false)
      && heldCycle.ratifications.some(
        (row) => row.id === approved.ratificationId
          && row.corrected === true
          && row.correctionReasonCode === "source_error"
      ),
    "integrity-hold projection exposes no stale execution authority",
  );
  assert(
    !heldText.includes("PRIVATE-POST-CONTRACT-CORRECTION")
      && !heldText.includes(correctionHash),
    "post-contract correction evidence stays out of the safe workspace",
  );

  await assertNoPrivateAudit(created.campaignId, "post-contract correction");
}

async function verifyOrganizingMfaEntries() {
  const names = [
    "get_union_lifecycle_workspace", "transition_organizing_campaign",
    "set_organizing_campaign_status", "record_resistance_incident",
    "open_organizing_bargaining_cycle", "transition_organizing_bargaining_cycle",
    "create_organizing_bargaining_proposal", "transition_organizing_bargaining_proposal",
    "schedule_organizing_bargaining_session", "record_organizing_first_contract",
    "record_organizing_bargaining_session_outcome", "record_organizing_ratification",
    "correct_organizing_ratification",
  ];
  // Typed null arguments reach the entry guard but cannot mutate any campaign.
  // Without an entry check, input validation would mask the missing MFA audit.
  const calls = JSON.parse(await scalar(`
    select json_agg('public.' || p.proname || '(' || coalesce((
      select string_agg('null::' || pg_catalog.format_type(a.type, null), ',' order by a.ordinal)
      from unnest(p.proargtypes) with ordinality a(type, ordinal)
    ), '') || ')' order by p.proname)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(array[${names.map(sqlString).join(",")}]);
  `, "organizing MFA RPC inventory"));
  assert(calls.length === names.length, "all thirteen organizing entry points are exercised");
  for (const call of calls) {
    for (const staleSession of [false, true]) {
      const override = staleSession
        ? `select pg_catalog.set_config('request.jwt.claims', ${sqlString(JSON.stringify({
          sub: USERS.staff, role: "authenticated", aal: "aal2",
          session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }))}, true);`
        : "";
      await expectState("42501", () => asUser(
        USERS.staff, "aal1", `${override} select ${call};`, "organizing MFA entry refusal",
      ), `${call.split("(")[0]} refuses ${staleSession ? "missing AAL2 session" : "AAL1 with verified TOTP"}`);
    }
  }
}

// Sections are addressable so a failing area can be re-run alone against the
// same lab container. setupFixtures always checks its disposable interlock.
const SECTIONS = new Map([
  ["catalog", verifyCatalog],
  ["organizingMfaEntries", verifyOrganizingMfaEntries],
  ["publicConnectBoundary", verifyPublicConnectBoundary],
  ["campaignBoundary", verifyCampaignBoundary],
  ["bargainingWriters", verifyBargainingWriters],
  ["participation", verifyParticipation],
  ["capacity", verifyCapacity],
  ["chronologyRace", verifyChronologyRace],
  ["completionAndRecognitionConcurrency", verifyCompletionAndRecognitionConcurrency],
  ["counters", verifyCounters],
  ["lastAdminConcurrency", verifyLastAdminConcurrency],
  ["mfaResetEpoch", verifyMfaResetEpoch],
]);

const requestedSections = process.argv.slice(2).map((name) => name.trim()).filter(Boolean);
const unknownSections = requestedSections.filter((name) => !SECTIONS.has(name));
if (unknownSections.length > 0) {
  throw new Error(
    `Unknown verification section(s): ${unknownSections.join(", ")}. Known sections: ${[...SECTIONS.keys()].join(", ")}`,
  );
}

await setupFixtures();
for (const [name, verifySection] of SECTIONS) {
  if (requestedSections.length > 0 && !requestedSections.includes(name)) continue;
  await verifySection();
}
process.stdout.write(
  requestedSections.length > 0
    ? `RESULT Union Ground database runtime verification passed for sections: ${requestedSections.join(", ")} (PARTIAL — not a full-gate pass)\n`
    : "RESULT Union Ground database runtime verification passed\n",
);
process.stdout.write(
  `LAB ${expectedProject} retains disposable fixtures; destroy the exact project after inspection\n`,
);
