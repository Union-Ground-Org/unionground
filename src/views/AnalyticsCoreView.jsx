import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "../lib/loadDeadline.js";
import { AnalyticsCoreDesk } from "../features/analytics/ui/AnalyticsCoreDesk.jsx";
import { createAnalyticsCoreAdapter } from "../features/analytics/adapter.js";
import { createPreviewAnalyticsSnapshot, createPreviewAnalyticsWorkspace } from "../features/analytics/preview.js";
import { createWiredAnalyticsAdapter, useMi1AnalyticsActor } from "../lib/mi1AnalyticsWiring.js";
import { loadUsageDigests, requestUsageDigestWording } from "../features/analytics/usageDigestApi.js";
import { createPulseApi } from "../features/pulse/pulseApi.js";
import { createPreviewPulseApi } from "../features/pulse/pulsePreview.js";

// REQ-UG-AI-USAGE-DIGEST-20261001: the digest panel is for the analytics
// staff hats. A member hat, a preview and a desk without a client all render
// no panel at all.
const USAGE_DIGEST_HATS = new Set(["steward", "coordinator", "advisor", "admin", "vp"]);

const LOAD_DEADLINE_BACKSTOP_MS = 250;

export function AnalyticsCoreView({ viewer, client, preview = false, api = null, loadDeadlineMs = SHELL_LOAD_DEADLINE_MS, session = null, onOpenPulse = null }) {
  const scopedViewer = useMi1AnalyticsActor(client, viewer);
  const scopedViewerKey = JSON.stringify(scopedViewer);
  // App builds its actor from current session primitives on every render.
  // Keep an equal projection referentially stable so unrelated shell renders
  // do not restart the scope and snapshot RPCs.
  const stableScopedViewer = useMemo(() => JSON.parse(scopedViewerKey), [scopedViewerKey]);
  const adapter = useMemo(() => api || (preview
    ? createAnalyticsCoreAdapter({
      fetchSnapshot: async () => createPreviewAnalyticsSnapshot(),
      fetchWorkspace: async () => createPreviewAnalyticsWorkspace(),
    })
    : createWiredAnalyticsAdapter(client)), [api, client, preview]);
  // The chart view is the shared Pulse builder (#6696); an injected desk api
  // (tests, embeds) keeps the earlier layout studio.
  const pulseApi = useMemo(() => (api ? null : preview ? createPreviewPulseApi() : client ? createPulseApi(client) : null), [api, client, preview]);
  const [model, setModel] = useState(null);
  const [status, setStatus] = useState("loading");
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const organizationScope = stableScopedViewer.organizationId || null;

  // Deliberate cross-tenant guard: a discovered organization that differs from
  // the prop-carried one must clear the painted model before the next snapshot
  // renders. Do not copy PR #2156's keep-the-desk-mounted approach here — that
  // would show one tenant's analytics under another tenant's actor.
  useEffect(() => {
    requestSequence.current += 1;
    setModel(null);
    setStatus("loading");
  }, [organizationScope]);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setStatus("loading");
    try {
      // The adapter puts the deadline on each read; this outer one only
      // backstops an adapter that ignores it, and says the page timed out.
      const next = await withLoadDeadline(
        adapter.loadDesk({ viewer: stableScopedViewer, deadlineMs: loadDeadlineMs }),
        loadDeadlineMs + LOAD_DEADLINE_BACKSTOP_MS,
      );
      if (!mounted.current || requestId !== requestSequence.current) return;
      setModel(next);
      setStatus(next.state);
    } catch (error) {
      if (!mounted.current || requestId !== requestSequence.current) return;
      setModel({ state: "error", reason: error?.name === "TimeoutError" ? "timed_out" : "load_failed" });
      setStatus("error");
    }
  }, [adapter, stableScopedViewer, loadDeadlineMs]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [load]);

  // The digests load when a staff member opens the Usage view, not with the
  // desk snapshot, so no new read fires on a passive analytics page load.
  const digestHat = USAGE_DIGEST_HATS.has(stableScopedViewer.selectedHat) ? stableScopedViewer.selectedHat : null;
  const onLoadUsageDigests = useMemo(
    () => (preview || !client || !digestHat ? null : () => loadUsageDigests(client, digestHat)),
    [client, digestHat, preview],
  );
  const onRequestUsageDigestWording = useMemo(
    () => (preview || !digestHat || !session?.access_token
      ? null
      : async ({ digestId }) => {
        const payload = await requestUsageDigestWording(session, digestHat, digestId);
        return payload?.digest ? await loadUsageDigests(client, digestHat) : null;
      }),
    [client, digestHat, preview, session],
  );

  return (
    <div data-mi1-surface="analytics-core">
      <AnalyticsCoreDesk
        model={model}
        viewer={stableScopedViewer}
        status={status}
        onRetry={load}
        onExport={(options) => adapter.exportDesk(model, stableScopedViewer, options)}
        onSaveLayout={async (input) => {
          const result = await adapter.saveLayout(input);
          if (result.ok) await load();
          return result;
        }}
        onDeleteLayout={async (input) => {
          const result = await adapter.deleteLayout(input);
          if (result.ok) await load();
          return result;
        }}
        onLoadUsageDigests={onLoadUsageDigests}
        onRequestUsageDigestWording={onRequestUsageDigestWording}
        pulseApi={pulseApi}
        onOpenPulse={onOpenPulse}
      />
    </div>
  );
}
