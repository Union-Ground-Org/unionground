// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/scheduled-job-alerts.js";
import {
  MONITOR_FAILURE_WINDOW_MS, SCHEDULED_JOB_STALE_AFTER_SECONDS, buildScheduledJobAlertText, maxCronGapMinutes,
  resetScheduledJobAlerts, runScheduledJobAlerts, staleAfterSeconds,
} from "../api/_lib/scheduledJobAlerts.js";
import { PRODUCT_JOBS } from "../src/features/operations/jobRegistry.js";
import { JOB_ACTS_BESIDE } from "../src/lib/heldSettingCompanions.js";
import { fnBody, latestFnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { PORTAL_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// OPS-UG-SCHEDULED-JOB-FAILURES-RAISE-NO-OPERATOR-ALERT-20261115 (#8881).
// The database half (claim, 30-minute limit, recovery, release) is proved on
// real SQL by tests/scheduled-job-alerts-db.test.js; this file proves the
// thresholds, the monitored set, the metadata-only text and the tick.
const MIGRATION = "20261117091100_scheduled_job_failure_alerts";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/abc123";
const SECRET = "cron-secret-value-32-characters-min";
const NOW = new Date("2026-11-17T14:10:00Z");
const HELD_JOB = "learning-period-end-tick";

const quotedNames = (text) => [...text.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);

function failedAlert(patch = {}) {
  return {
    claimId: "11111111-1111-4111-8111-111111111111", jobName: "union-ground-organization-retention", kind: "failed",
    failures: 3, firstFailureAt: "2026-11-17T13:47:00+00:00", lastFailureAt: "2026-11-17T14:02:30+00:00",
    lastStartedAt: "2026-11-17T14:02:30+00:00", ...patch,
  };
}

function slackFetch(status = 200) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status }));
}

beforeEach(() => resetScheduledJobAlerts());

describe("expected intervals", () => {
  it("reads the longest gap of each schedule shape, in UTC over a week", () => {
    expect(maxCronGapMinutes("* * * * *")).toBe(1);
    expect(maxCronGapMinutes("1-56/5 * * * *")).toBe(5);
    expect(maxCronGapMinutes("10-55/15 * * * *")).toBe(15);
    expect(maxCronGapMinutes("*/10 * * * *")).toBe(10);
    expect(maxCronGapMinutes("42 * * * *")).toBe(60);
    expect(maxCronGapMinutes("47 3 * * *")).toBe(1440);
    expect(maxCronGapMinutes("10 3 * * 1")).toBe(7 * 1440);
    // Runs every 20 minutes, but only from 13:07 to 23:47 UTC: the night gap counts.
    expect(maxCronGapMinutes("7-47/20 13-23 * * *")).toBe(1440 - (23 * 60 + 47 - (13 * 60 + 7)));
    // Monday only, 13:08 to 23:58 UTC.
    expect(maxCronGapMinutes("8-58/10 13-23 * * 1")).toBe(7 * 1440 - (23 * 60 + 58 - (13 * 60 + 8)));
    expect(() => maxCronGapMinutes("0 0 1 * *")).toThrow(/unsupported/);
    expect(() => maxCronGapMinutes("nonsense")).toThrow(/unsupported/);
  });

  it("adds half the gap as a margin, at least 15 minutes and at most two hours", () => {
    expect(staleAfterSeconds("* * * * *")).toBe(16 * 60);
    expect(staleAfterSeconds("42 * * * *")).toBe(90 * 60);
    expect(staleAfterSeconds("47 3 * * *")).toBe(26 * 3600);
    expect(staleAfterSeconds("10 3 * * 1")).toBe(7 * 86400 + 2 * 3600);
  });

  it("gives every monitored job a threshold the database accepts", () => {
    const values = Object.values(SCHEDULED_JOB_STALE_AFTER_SECONDS);
    expect(values).toHaveLength(PRODUCT_JOBS.length);
    for (const value of values) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(60);
      expect(value).toBeLessThanOrEqual(1209600);
    }
  });

  it("reads each job's cadence from the schedule that really runs it", () => {
    // A cadence that drifted from its schedule would call a healthy job overdue.
    const scheduled = new Map();
    for (const file of migrationFiles()) {
      const sql = stripComments(file.sql);
      for (const match of sql.matchAll(/cron\.schedule\(\s*'([a-z0-9-]+)'\s*,\s*'([^']+)'/g)) scheduled.set(match[1], match[2]);
      for (const match of sql.matchAll(/cron\.alter_job\([^;]*?schedule\s*:=\s*'([^']+)'[^;]*?jobname\s*=\s*'([a-z0-9-]+)'/g)) scheduled.set(match[2], match[1]);
    }
    const vercel = new Map(JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons.map((cron) => [cron.path, cron.schedule]));
    const platformRoutes = {
      "account-deletion-reconcile-tick": "/api/account-deletion-reconcile",
      "dues-stripe-reconcile-tick": "/api/dues-stripe-reconcile",
      "dues-reminders-dispatch-tick": "/api/dues-reminders-dispatch",
    };
    for (const job of PRODUCT_JOBS) {
      const schedule = platformRoutes[job.jobName] ? vercel.get(platformRoutes[job.jobName]) : scheduled.get(job.jobName);
      expect(schedule, job.jobName).toBe(job.cadence);
    }
  });
});

describe("the monitored set", () => {
  it("monitors the public Job health catalogue and excludes retained SQL compatibility names", () => {
    const catalogue = quotedNames(/unnest\(array\[([^\]]+)\]\)/.exec(latestFnBody("public.list_organization_job_health"))[1]).sort();
    const claimed = quotedNames(/v_jobs := array\[([^\]]+)\];/.exec(fnBody(loadMigrationSql(MIGRATION), "public.claim_scheduled_job_alerts"))[1]).sort();
    expect(claimed).toEqual(catalogue);
    const absentFromPublicEdition = [
      "casework-ulp-deadline-tick", "dues-reminders-dispatch-tick", "dues-stripe-reconcile-tick",
      "mi1-public-rsvp-retention", "organization-claim-retention", "sso-identity-link-sweep",
    ];
    const publicJobs = catalogue.filter((job) => !absentFromPublicEdition.includes(job));
    expect(Object.keys(SCHEDULED_JOB_STALE_AFTER_SECONDS).sort()).toEqual(publicJobs);
    expect(PRODUCT_JOBS.map(({ jobName }) => jobName).sort()).toEqual(publicJobs);
    for (const held of Object.keys(JOB_ACTS_BESIDE)) expect(publicJobs).toContain(held);
  });

  it("leaves the admin Job health function, the job catalogue and every schedule unchanged", () => {
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql).not.toMatch(/list_organization_job_health|organization_job_runs_job_name_check|cron\.|insert into public\.organization_job_runs|update public\.organization_job_runs|delete from public\.organization_job_runs/i);
    const created = [...sql.matchAll(/create (?:or replace )?function ([a-z_.]+)/gi)].map((match) => match[1]);
    expect(created).toEqual([
      "private.undo_scheduled_job_alert_claim", "public.claim_scheduled_job_alerts",
      "public.confirm_scheduled_job_alert", "public.release_scheduled_job_alert",
    ]);
    for (const name of created.filter((fn) => fn.startsWith("public."))) {
      expect(sql).toContain(`revoke all on function ${name}(`);
      expect(sql).toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([a-z]+\\) to service_role;`));
    }
    // The undo helper runs only inside the definer functions: no role may call it.
    expect(sql).toContain("revoke all on function private.undo_scheduled_job_alert_claim(uuid) from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant execute on function private\./i);
    expect(sql).not.toMatch(/to (?:anon|authenticated)\b/i);
    for (const table of ["private.scheduled_job_alert_state", "private.scheduled_job_alert_reported"]) {
      expect(sql).toContain(`revoke all on table ${table} from public, anon, authenticated, service_role;`);
    }
  });
});

describe("alert text", () => {
  it("names the job, the failure count and the first and last failure, in Eastern time", () => {
    const text = buildScheduledJobAlertText(failedAlert(), "production");
    expect(text).toContain("Union Ground scheduled job — FAILED (production)");
    expect(text).toContain("job: union-ground-organization-retention");
    expect(text).toContain("failed runs since the last alert: 3");
    expect(text).toContain("first failure: 11/17/2026, 8:47:00 AM ET (2026-11-17T13:47:00.000Z)");
    expect(text).toContain("last failure: 11/17/2026, 9:02:30 AM ET (2026-11-17T14:02:30.000Z)");
  });

  it("says when an overdue job last started and when a run was expected", () => {
    const text = buildScheduledJobAlertText({ jobName: "mesh-agency-usage-aggregate-tick", kind: "overdue", lastStartedAt: "2026-11-02T03:10:00Z" }, "preview");
    expect(text).toContain("OVERDUE (preview)");
    expect(text).toContain("newest run started: 11/1/2026, 10:10:00 PM ET (2026-11-02T03:10:00.000Z)");
    expect(text).toContain("expected a run within: 7 days (schedule 10 3 * * 1 UTC)");
  });

  it("sends one recovery notice text", () => {
    const text = buildScheduledJobAlertText({ jobName: HELD_JOB, kind: "recovered", lastStartedAt: "2026-11-17T14:11:00Z" }, "production");
    expect(text).toContain("RECOVERED (production)");
    expect(text).toContain(`job: ${HELD_JOB}`);
  });

  it("carries metadata only, whatever else the answer holds", () => {
    const text = buildScheduledJobAlertText(failedAlert({
      failureCode: "boom-from-the-job", redactedSummary: "Scheduled command failed.", organizationId: "org-1",
      errorText: "member jane@example.org",
    }), "production");
    for (const leaked of ["boom-from-the-job", "Scheduled command failed", "org-1", "jane@example.org", "claimId", "11111111-1111"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("refuses an unknown job, kind, count or time", () => {
    expect(() => buildScheduledJobAlertText(failedAlert({ jobName: "evil https://x.example" }), "production")).toThrow(/unknown scheduled job/);
    expect(() => buildScheduledJobAlertText(failedAlert({ kind: "fixed" }), "production")).toThrow(/kind/);
    expect(() => buildScheduledJobAlertText(failedAlert({ failures: 0 }), "production")).toThrow(/count/);
    expect(() => buildScheduledJobAlertText(failedAlert({ firstFailureAt: "never" }), "production")).toThrow(/time/);
  });
});

describe("one tick", () => {
  const env = { UG_ALERTS_SLACK_WEBHOOK_URL: WEBHOOK, VERCEL_ENV: "production" };

  it("claims nothing and posts nothing without the webhook", async () => {
    const callRpc = vi.fn();
    const fetchImpl = slackFetch();
    for (const value of [undefined, "", "http://hooks.slack.com/x", "https://example.com/hook"]) {
      expect(await runScheduledJobAlerts({ callRpc, env: { UG_ALERTS_SLACK_WEBHOOK_URL: value }, fetchImpl, now: NOW })).toEqual({ outcome: "disabled", alerts: [] });
    }
    expect(callRpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a failing run's alert, a missed interval, a held feature's job and a recovery to ug-alerts", async () => {
    const claimed = [
      failedAlert(),
      { claimId: "22222222-2222-4222-8222-222222222222", jobName: "mesh-agency-usage-aggregate-tick", kind: "overdue", failures: 0, firstFailureAt: null, lastFailureAt: null, lastStartedAt: "2026-11-02T03:10:00Z" },
      failedAlert({ claimId: "33333333-3333-4333-8333-333333333333", jobName: HELD_JOB, failures: 1 }),
      { claimId: "44444444-4444-4444-8444-444444444444", jobName: "live-poll-schedule-tick", kind: "recovered", failures: 0, lastStartedAt: "2026-11-17T14:06:00Z" },
    ];
    const callRpc = vi.fn(async (name) => (name === "claim_scheduled_job_alerts" ? claimed : true));
    const fetchImpl = slackFetch();
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(callRpc.mock.calls[0]).toEqual(["claim_scheduled_job_alerts", { p_stale_after_seconds: SCHEDULED_JOB_STALE_AFTER_SECONDS }]);
    // Gate round 1 of #9024 (r1s2/r2s2): a delivered post confirms its claim;
    // only an unconfirmed claim is offered again after 30 minutes.
    expect(callRpc.mock.calls.slice(1)).toEqual(claimed.map((alert) => ["confirm_scheduled_job_alert", { p_claim_id: alert.claimId }]));
    expect(result.alerts.map(({ jobName, kind, delivery, confirmed }) => `${jobName}:${kind}:${delivery}:${confirmed}`)).toEqual([
      "union-ground-organization-retention:failed:posted:true",
      "mesh-agency-usage-aggregate-tick:overdue:posted:true",
      `${HELD_JOB}:failed:posted:true`,
      "live-poll-schedule-tick:recovered:posted:true",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toBe(WEBHOOK);
      expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
      expect(Object.keys(JSON.parse(init.body))).toEqual(["text"]);
    }
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).text).toContain(`job: ${HELD_JOB}`);
  });

  it("releases the claim of a refused or failed post and touches no job", async () => {
    const claimed = [failedAlert(), failedAlert({ claimId: "55555555-5555-4555-8555-555555555555", jobName: "task-maintenance-daily" })];
    const callRpc = vi.fn(async (name) => (name === "claim_scheduled_job_alerts" ? claimed : true));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(result.alerts.map(({ delivery, released }) => `${delivery}:${released}`)).toEqual(["rejected:true", "failed:true"]);
    expect(callRpc.mock.calls.map(([name, body]) => `${name} ${JSON.stringify(body)}`).slice(1)).toEqual([
      'release_scheduled_job_alert {"p_claim_id":"11111111-1111-4111-8111-111111111111"}',
      'release_scheduled_job_alert {"p_claim_id":"55555555-5555-4555-8555-555555555555"}',
    ]);
    // Only the claim and the releases: the tick never stops, retries or records a job.
    expect(new Set(callRpc.mock.calls.map(([name]) => name))).toEqual(new Set(["claim_scheduled_job_alerts", "release_scheduled_job_alert"]));
  });

  it("releases a claim whose text would carry more than metadata, without posting it", async () => {
    const callRpc = vi.fn(async (name) => (name === "claim_scheduled_job_alerts" ? [failedAlert({ jobName: "not-a-job" })] : true));
    const fetchImpl = slackFetch();
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(result.alerts).toEqual([{ jobName: "unknown", kind: "failed", delivery: "refused_payload", confirmed: false, released: true }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Grok pre-push read of #8881, P2: a release that throws holds the batch back
  // until the database undoes the claim, so the operator is told now.
  it("posts CHECK FAILED and reports release_failed when a failed post's release throws, after trying every alert", async () => {
    const callRpc = vi.fn(async (name) => {
      if (name === "claim_scheduled_job_alerts") return [failedAlert(), failedAlert({ claimId: "66666666-6666-4666-8666-666666666666", jobName: "task-maintenance-daily" })];
      throw new Error("release-failed");
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(result).toMatchObject({
      outcome: "release_failed", monitor: "posted",
      alerts: [{ delivery: "rejected", released: false }, { jobName: "task-maintenance-daily", delivery: "posted", released: false }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const notice = JSON.parse(fetchImpl.mock.calls[2][1].body).text;
    expect(notice).toContain("CHECK FAILED (production)");
    expect(notice).toContain("could not be released, so it is held back for 30 minutes before it is offered again");
  });

  // A timeout is an unknown outcome. Slack may have the post, so its claim is
  // neither confirmed nor released: it stays pending, the 30-minute limit holds,
  // and the database offers the same alert again after it (gate round 1 of
  // #9024, r1s2/r2s2; the database side is in tests/scheduled-job-alerts-db.test.js).
  it("leaves the claim of a post that timed out pending, neither confirmed nor released", async () => {
    const callRpc = vi.fn(async (name) => (name === "claim_scheduled_job_alerts" ? [failedAlert()] : true));
    const fetchImpl = vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(result).toEqual({ outcome: "done", alerts: [{ jobName: "union-ground-organization-retention", kind: "failed", delivery: "timed_out", confirmed: false, released: false }] });
    expect(callRpc.mock.calls.map(([name]) => name)).toEqual(["claim_scheduled_job_alerts"]);
  });

  it("keeps going when a delivered post cannot be confirmed: at worst it repeats once, 30 minutes later", async () => {
    const callRpc = vi.fn(async (name) => {
      if (name === "claim_scheduled_job_alerts") return [failedAlert()];
      throw new Error("confirm-failed");
    });
    const fetchImpl = slackFetch();
    const result = await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW });
    expect(result).toEqual({ outcome: "done", alerts: [{ jobName: "union-ground-organization-retention", kind: "failed", delivery: "posted", confirmed: false, released: false }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("tells the operator once per 30 minutes when the check itself cannot read job health", async () => {
    const callRpc = vi.fn(async () => { throw new Error("claim_scheduled_job_alerts-failed"); });
    const fetchImpl = slackFetch();
    expect(await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: NOW })).toMatchObject({ outcome: "claim_failed", monitor: "posted" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text).toContain("CHECK FAILED (production)");
    expect(await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: new Date(NOW.getTime() + 60_000) })).toMatchObject({ monitor: "throttled" });
    expect(await runScheduledJobAlerts({ callRpc, env, fetchImpl, now: new Date(NOW.getTime() + MONITOR_FAILURE_WINDOW_MS) })).toMatchObject({ monitor: "posted" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable claim answer as the check failing", async () => {
    const fetchImpl = slackFetch();
    expect(await runScheduledJobAlerts({ callRpc: async () => ({ alerts: [] }), env, fetchImpl, now: NOW })).toMatchObject({ outcome: "claim_failed" });
  });
});

describe("the cron route", () => {
  function response() {
    return {
      code: 0, headers: {}, body: null,
      status(code) { this.code = code; return this; },
      setHeader(name, value) { this.headers[name] = value; return this; },
      end(body) { this.body = JSON.parse(body); },
    };
  }
  async function call({ method = "GET", headers = {} } = {}) {
    const res = response();
    // What a Vercel cron invocation carries: the CRON_SECRET bearer and its
    // user agent. Vercel documents no x-vercel-cron header, so none is sent.
    await handler({ method, headers: { host: PORTAL_HOST, "user-agent": "vercel-cron/1.0", authorization: `Bearer ${SECRET}`, ...headers } }, res);
    return res;
  }
  const PRODUCTION_URL = SUPABASE_ORIGIN;
  const SAMPLE_URL = "https://scheduledsamplefixture.supabase.co";
  let rpcAnswer;
  beforeEach(() => {
    for (const [key, value] of Object.entries({
      VITE_SUPABASE_URL: PRODUCTION_URL, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "public-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-key", CRON_SECRET: SECRET, UG_ALERTS_SLACK_WEBHOOK_URL: WEBHOOK, VERCEL_ENV: "production",
      SAMPLE_SUPABASE_URL: SAMPLE_URL, VITE_SAMPLE_SUPABASE_URL: "", SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service-key",
    })) vi.stubEnv(key, value);
    rpcAnswer = [failedAlert()];
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).startsWith(`${PRODUCTION_URL}/`)
      ? { ok: true, status: 200, text: async () => JSON.stringify(rpcAnswer) }
      : { ok: true, status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses anything but a GET bearing the CRON_SECRET", async () => {
    expect((await call({ method: "POST" })).code).toBe(405);
    expect((await call({ headers: { authorization: "Bearer wrong" } })).code).toBe(401);
    expect((await call({ headers: { authorization: undefined } })).code).toBe(401);
    expect((await call({ headers: { authorization: SECRET } })).code).toBe(401);
    // A header alone authorizes nothing.
    expect((await call({ headers: { authorization: undefined, "x-vercel-cron": "1" } })).code).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    const unconfigured = await call({ headers: { authorization: "Bearer " } });
    expect(unconfigured.code).toBe(503);
    expect(unconfigured.body).toMatchObject({ ok: false, error: "cron_secret_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  // Gate round 1 of #9024 (r1s1/r2s1): Vercel authenticates a cron call with
  // the CRON_SECRET bearer only. Requiring x-vercel-cron refused every real tick.
  it("runs a real Vercel cron call that carries no x-vercel-cron header", async () => {
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "done", posted: 1, undelivered: 0 });
  });

  it("claims through the production service role, posts, and answers counts only", async () => {
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "done", posted: 1, undelivered: 0 });
    const [claimUrl, claimInit] = fetch.mock.calls[0];
    expect(claimUrl).toBe(`${PRODUCTION_URL}/rest/v1/rpc/claim_scheduled_job_alerts`);
    expect(claimInit.headers.Authorization).toBe("Bearer service-key");
    expect(String(fetch.mock.calls[1][0])).toBe(WEBHOOK);
  });

  it("answers 503 when job health cannot be read", async () => {
    rpcAnswer = null;
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "job_health_unavailable" });
  });

  // Grok pre-push read of #8881, P2: the same isolation predicate as
  // api/account-deletion-reconcile.js, before any call.
  it("refuses a SAMPLE or misconfigured production backend before any call", async () => {
    const refused = async () => {
      const res = await call();
      expect(res.code).toBe(503);
      expect(res.body).toEqual({ ok: false, error: "production_backend_isolation_required" });
    };
    vi.stubEnv("VITE_SUPABASE_URL", SAMPLE_URL);
    await refused();
    vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION_URL);
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "  service-key  ");
    await refused();
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sample-service-key");
    vi.stubEnv("SAMPLE_SUPABASE_URL", PRODUCTION_URL);
    await refused();
    vi.stubEnv("SAMPLE_SUPABASE_URL", "://misconfigured-sample-origin");
    await refused();
    vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE_URL);
    for (const url of ["http://project.supabase.co", "https://embedded@project.supabase.co", "https://project.supabase.co/path", "://not-an-origin"]) {
      vi.stubEnv("VITE_SUPABASE_URL", url);
      await refused();
    }
    vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    await refused();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 503 when a failed post's claim cannot be released", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/rpc/claim_scheduled_job_alerts")) return { ok: true, status: 200, text: async () => JSON.stringify(rpcAnswer) };
      if (String(url).endsWith("/rpc/release_scheduled_job_alert")) return { ok: false, status: 503, text: async () => "" };
      return { ok: false, status: 500 };
    }));
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "alert_release_failed" });
  });

  it("is scheduled every five minutes", () => {
    const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons;
    expect(crons).toContainEqual({ path: "/api/scheduled-job-alerts", schedule: "4-59/5 * * * *" });
  });
});
