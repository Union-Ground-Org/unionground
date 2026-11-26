import { WorkspaceSection } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuditLogPanel, auditActorIds } from "../features/operations/AuditLogPanel.jsx";
import { JobHealthPanel } from "../features/operations/JobHealthPanel.jsx";
import { ReleaseCalendarPanel } from "../features/operations/ReleaseCalendarPanel.jsx";
import { auditSourcesForViewer, isAuditSinkSource } from "../features/operations/index.js";
import { useMi1ScopedActor } from "../lib/mi1FeatureWiring.js";
import { createOperationsApi } from "../lib/mi1OperationsWiring.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { withoutJobsBesideHeldSwitches } from "../lib/heldSettingCompanions.js";

// heldScope comes from the admin desk: the keys of its settings list (null
// while unread) and whether the viewer is a platform operator. A job serving
// a held switch is left off the list (heldSettingCompanions.js). A platform
// operator also gets the release calendar on the job health page.
export function OperationsHealthView({ session, client, embedded = false, heldScope = null }) {
  const { t } = useLang();
  const saveError = t("operations.saveError");
  const retryError = t("operations.retryError");
  const mfaError = t("operations.mfaError");
  const scopedSession = useMi1ScopedActor(client, session);
  const api = useMemo(() => createOperationsApi(client), [client]);
  const [audit, setAudit] = useState({ state: "loading", events: [], hasOlder: false });
  const [jobs, setJobs] = useState({ state: "loading", jobs: [] });
  const [filters, setFilters] = useState({});
  // Display names for the ledger's actors, keyed by user id and kept per
  // organization (REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030).
  const [actorNames, setActorNames] = useState({ scope: null, names: {} });
  const [busyJobName, setBusyJobName] = useState(null);
  const [remediationError, setRemediationError] = useState(null);
  const auditSequence = useRef(0);
  const jobsSequence = useRef(0);
  const mounted = useRef(true);
  const organizationScope = scopedSession.selectedOrganizationId || null;
  const auditSources = useMemo(() => auditSourcesForViewer(scopedSession), [scopedSession]);
  const listedJobs = useMemo(() => withoutJobsBesideHeldSwitches(jobs.jobs, heldScope ?? {}), [jobs.jobs, heldScope]);

  useEffect(() => {
    auditSequence.current += 1;
    jobsSequence.current += 1;
    setAudit({ state: "loading", events: [], hasOlder: false });
    setJobs({ state: "loading", jobs: [] });
    setRemediationError(null);
  }, [organizationScope]);

  const loadAudit = useCallback(async (nextFilters = {}, append = false) => {
    const requestId = ++auditSequence.current;
    setAudit((current) => ({ ...current, state: current.events.length ? current.state : "loading" }));
    // The unified ledger and the five sink readers are different RPCs with
    // different filters. The selected source decides which one answers; it is
    // never merged into one page, because their cursors are not comparable.
    let page;
    try {
      page = isAuditSinkSource(nextFilters.source)
        ? await api.listAuditSource(scopedSession, nextFilters.source, nextFilters)
        : await api.listAudit(scopedSession, nextFilters);
    } catch {
      // A rejected read or invalid audit row uses the same recovery as an RPC error.
      page = { state: "error", events: [], hasOlder: false };
    }
    if (!mounted.current || requestId !== auditSequence.current) return;
    setAudit((current) => {
      if (!append) return page;
      if (page.state !== "ready" && page.state !== "empty") {
        return current.events.length ? { ...current, state: "ready", olderError: true } : page;
      }
      const events = page.state === "ready" ? [...current.events, ...page.events] : current.events;
      return {
        state: events.length ? "ready" : "empty",
        events,
        hasOlder: page.hasOlder,
        olderError: false,
      };
    });
  }, [api, scopedSession]);

  const loadJobs = useCallback(async () => {
    const requestId = ++jobsSequence.current;
    const next = await api.listJobHealth(scopedSession);
    if (mounted.current && requestId === jobsSequence.current) setJobs(next);
  }, [api, scopedSession]);

  const namesForScope = actorNames.scope === organizationScope ? actorNames.names : null;
  useEffect(() => {
    const known = namesForScope ?? {};
    const missing = auditActorIds(audit.events).filter((id) => !Object.hasOwn(known, id));
    if (!missing.length || !api.listActorNames) return undefined;
    let live = true;
    const scope = organizationScope;
    api.listActorNames(missing).then((found) => {
      if (!live) return;
      // Ids the reader could not name are remembered as unnamed, so they are not asked again.
      const settled = Object.fromEntries(missing.map((id) => [id, found[id] ?? null]));
      setActorNames((current) => ({ scope, names: { ...(current.scope === scope ? current.names : {}), ...settled } }));
    });
    return () => { live = false; };
  }, [api, audit.events, namesForScope, organizationScope]);

  useEffect(() => {
    mounted.current = true;
    loadAudit(filters);
    loadJobs();
    return () => {
      mounted.current = false;
      auditSequence.current += 1;
      jobsSequence.current += 1;
    };
  }, [filters, loadAudit, loadJobs]);

  // Health is time-derived. Refresh it while the desk remains open so a run
  // crossing its stale threshold cannot stay visually healthy indefinitely.
  useEffect(() => {
    const timer = globalThis.setInterval(() => void loadJobs(), 60_000);
    return () => globalThis.clearInterval(timer);
  }, [loadJobs]);

  return (
    <div className={embedded ? "" : "screen"} data-mi1-surface="operations-health">
      <WorkspaceSection name="admin-organization-audit"><AuditLogPanel
        state={audit.state === "unauthorized" && audit.reason === "mfa_required"
          ? "mfa"
          : audit.state === "unset" || audit.state === "unauthorized" ? "unavailable" : audit.state}
        events={audit.events}
        actorNames={namesForScope ?? {}}
        filters={filters}
        sources={auditSources}
        hasOlder={audit.hasOlder}
        onFilterChange={(next) => {
          setFilters(next);
        }}
        onRetry={() => loadAudit(filters)}
        onLoadOlder={() => loadAudit({
          ...filters,
          before: {
            occurredAt: audit.events.at(-1)?.occurredAt ?? null,
            id: audit.events.at(-1)?.id ?? null,
          },
        }, true)}
      /></WorkspaceSection>
      {audit.olderError && (
        <p className="xus-note xus-note--error" role="alert">{t("operations.olderAuditError")}</p>
      )}
      <WorkspaceSection name="admin-job-health"><JobHealthPanel
        state={jobs.state === "unauthorized" && jobs.reason === "mfa_required"
          ? "mfa"
          : jobs.state === "unauthorized" || jobs.state === "unset" ? "unavailable" : jobs.state}
        jobs={listedJobs}
        busyJobName={busyJobName}
        onRetry={loadJobs}
        onAcknowledge={async (command) => {
          setBusyJobName(command.jobName);
          setRemediationError(null);
          try {
            const result = await api.acknowledgeJob(scopedSession, command);
            if (!mounted.current) return;
            if (!result.ok) {
              setRemediationError(result.reason === "mfa_required" ? mfaError : saveError);
              return;
            }
            await loadJobs();
          } finally {
            if (mounted.current) setBusyJobName(null);
          }
        }}
        onRequestRetry={async (command) => {
          setBusyJobName(command.jobName);
          setRemediationError(null);
          try {
            const result = await api.requestJobRetry(scopedSession, command);
            if (!mounted.current) return;
            if (!result.ok) {
              setRemediationError(result.reason === "mfa_required" ? mfaError : retryError);
              return;
            }
            await loadJobs();
          } finally {
            if (mounted.current) setBusyJobName(null);
          }
        }}
      /></WorkspaceSection>
      {remediationError && (
        <p className="xus-note xus-note--error" role="alert">{remediationError}</p>
      )}
      {/* The release calendar (#9039, read only) mounts only for a platform
          operator; its read refuses anyone else on the server. */}
      {heldScope?.platformOperator === true && client
        ? <WorkspaceSection name="admin-job-health"><ReleaseCalendarPanel client={client} /></WorkspaceSection>
        : null}
    </div>
  );
}
