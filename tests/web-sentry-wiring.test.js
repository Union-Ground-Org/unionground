import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

const sdk = vi.hoisted(() => ({ init: vi.fn(), setUser: vi.fn(), makeFetchTransport: vi.fn() }));
// posthog-js: init returns the named diagnostics instance.
const posthog = vi.hoisted(() => {
  const diagnostics = { captureException: vi.fn() };
  return { default: { init: vi.fn(() => diagnostics), _send_request: vi.fn() }, diagnostics };
});
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("@sentry/react", () => sdk);
vi.mock("posthog-js", () => ({ default: posthog.default }));
vi.mock("posthog-js/dist/exception-autocapture.js", () => ({}));

describe("web Sentry activation", () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    vi.stubEnv("VITE_POSTHOG_HOST", "");
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("VITE_SENTRY_PREVIEW_ENABLED", "0");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["", "   "])("does not initialize with an empty or whitespace DSN: %j", async (dsn) => {
    vi.stubEnv("VITE_SENTRY_DSN", dsn);
    const { initObservability } = await import("../src/lib/observability.js");
    initObservability({ hostname: "app.example.org", automated: false });
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("requires a branch-specific preview opt-in and keeps unrecognized hosts disabled", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    const { initObservability, shouldEnableSentry } = await import("../src/lib/observability.js");
    initObservability({ hostname: "branch.vercel.app", automated: false });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(shouldEnableSentry({ hostname: "evil.example", automated: false, previewEnabled: true })).toBe(false);
    vi.stubEnv("VITE_SENTRY_PREVIEW_ENABLED", "1");
    initObservability({ hostname: "branch.vercel.app", automated: false });
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ tracesSampleRate: 0, sendDefaultPii: false, maxBreadcrumbs: 0,
      transportOptions: { fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } } });
    // The private options' hooks stand: no transaction path re-opens.
    expect(sdk.init.mock.calls[0][0].beforeSendTransaction({ transaction: "member" })).toBeNull();
    expect(sdk.init.mock.calls[0][0].beforeSendTransaction({})).toBeNull();
    const allowed = ["GlobalHandlers", "BrowserApiErrors", "EventFilters", "Dedupe"];
    const defaults = [...allowed, "InboundFilters", "Replay", "HttpContext", "Console", "BrowserSession"].map((name) => ({ name }));
    expect(sdk.init.mock.calls[0][0].integrations(defaults)).toEqual(allowed.map((name) => ({ name })));
  });

  // G7-8346-01: Sentry 11 renamed the default InboundFilters to EventFilters.
  // An allowlist that names only the old one silently drops the error filter
  // ("Script error." and similar noise), so check it against the real defaults.
  it("keeps the browser error filter and the other allowlisted defaults Sentry actually ships", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    const { initObservability } = await import("../src/lib/observability.js");
    initObservability({ hostname: PORTAL_HOST, automated: false });
    expect(sdk.init).toHaveBeenCalledTimes(1);
    const actual = await vi.importActual("@sentry/react");
    const kept = sdk.init.mock.calls[0][0].integrations(actual.getDefaultIntegrations({})).map((integration) => integration.name).sort();
    expect(kept).toEqual(["BrowserApiErrors", "Dedupe", "EventFilters", "GlobalHandlers"]);
  });

  // The release comes from the document's build marker at
  // run time, never from a compile-time constant in a hashed chunk, so a build
  // of unchanged sources keeps every chunk name.
  describe("release from the document build marker", () => {
    const marker = (content) => {
      document.head.querySelectorAll('meta[name="union-ground-build-sha"]').forEach((node) => node.remove());
      if (content === null) return;
      const meta = document.createElement("meta");
      meta.setAttribute("name", "union-ground-build-sha");
      meta.setAttribute("content", content);
      document.head.append(meta);
    };
    afterEach(() => marker(null));

    it("names the Sentry release after the sha the document carries", async () => {
      marker("1234567890abcdef1234567890abcdef12345678");
      vi.stubEnv("VITE_SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
      const { initObservability } = await import("../src/lib/observability.js");
      initObservability({ hostname: PORTAL_HOST, automated: false });
      expect(sdk.init).toHaveBeenCalledTimes(1);
      expect(sdk.init.mock.calls[0][0].release).toBe("1234567890abcdef1234567890abcdef12345678");
    });

    it("falls back to development without an exact sha", async () => {
      const { documentBuildRelease } = await import("../src/lib/observability.js");
      marker(null);
      expect(documentBuildRelease()).toBe("development");
      for (const content of ["__UNION_GROUND_BUILD_SHA__", "ABCDEF7890abcdef1234567890abcdef12345678", "1234567", ""]) {
        marker(content);
        expect(documentBuildRelease()).toBe("development");
      }
      expect(documentBuildRelease(null)).toBe("development");
    });

    it("keeps the build sha out of the bundled graph", () => {
      const config = readFileSync("vite.config.mjs", "utf8");
      expect(config).not.toContain("__BUILD_SHA__");
      expect(config).toContain("release: { name: commitSha, inject: false }");
      expect(readFileSync("src/lib/observability.js", "utf8")).not.toContain("__BUILD_SHA__");
    });
  });
});

describe("web PostHog error tracking beside Sentry", () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_fixture");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.net");
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("VITE_SENTRY_PREVIEW_ENABLED", "0");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("starts the named diagnostics instance on the member product and the demo, never on automated browsers or unrecognized hosts, without a Sentry DSN", async () => {
    const { initObservability, captureViewError, diagnosticsPosthogClient } = await import("../src/lib/observability.js");
    initObservability({ hostname: "evil.example", automated: false });
    initObservability({ hostname: PORTAL_HOST, automated: true });
    expect(posthog.default.init).not.toHaveBeenCalled();
    expect(captureViewError(new Error("x"))).toBe(false);
    initObservability({ hostname: PORTAL_HOST, automated: false });
    // Diagnostics first, then the cookieless product analytics instance (#6247).
    const diagnosticsInits = () => posthog.default.init.mock.calls.filter((call) => call[2] === "diagnostics");
    expect(diagnosticsInits()).toHaveLength(1);
    const [token, options, name] = diagnosticsInits()[0];
    expect([token, name]).toEqual(["phc_fixture", "diagnostics"]);
    expect(options).toMatchObject({
      api_host: "https://e.unionground.net", autocapture: false, capture_pageview: false, capture_pageleave: false, capture_exceptions: true,
      capture_heatmaps: false, capture_performance: false, disable_session_recording: true, disable_compression: true, disable_surveys: true,
      disable_web_experiments: true, disable_external_dependency_loading: true, advanced_disable_flags: true, persistence: "memory",
      disable_persistence: true, disable_cookie: true, save_referrer: false, save_campaign_params: false, mask_all_text: true,
      opt_out_capturing_cookie_prefix: "__ph_diagnostics_opt_in_out_",
    });
    // The bundled exception runtime is imported, so autocapture needs no
    // external script that disable_external_dependency_loading would refuse.
    expect(readFileSync("src/lib/observability.js", "utf8")).toContain('import "posthog-js/dist/exception-autocapture.js";');
    expect(diagnosticsPosthogClient()).toBe(posthog.diagnostics);
    expect(sdk.init).not.toHaveBeenCalled();
    // A view error reaches PostHog even with no Sentry DSN; the scrubber
    // reduces whatever the SDK built to the allowlist.
    expect(captureViewError(new Error("Taylor Example"))).toBe(true);
    expect(posthog.diagnostics.captureException).toHaveBeenCalledTimes(1);
    const clean = options.before_send({ event: "$exception", uuid: "0192f0d6-2d0f-7a4e-9b3c-1e2d3c4b5a69", properties: { $exception_list: [{ type: "TypeError", value: "Taylor Example", stacktrace: { frames: [{ platform: "web:javascript", filename: `${PORTAL_ORIGIN}/assets/a.js`, function: "f", lineno: 1, colno: 2, in_app: true }] } }], $current_url: `${PORTAL_ORIGIN}/members/42`, $session_id: "s", $lib: "web", $lib_version: "1.439.2", token: "phc_fixture", distinct_id: "member" } });
    // The build's release sha rides along only when the bundle defines one.
    const { release, ...properties } = clean.properties;
    if (release !== undefined) expect(release).toMatch(/^[a-f0-9]{40}$/);
    expect({ ...clean, properties }).toEqual({ event: "$exception", distinct_id: "diagnostics", uuid: "0192f0d6-2d0f-7a4e-9b3c-1e2d3c4b5a69", properties: {
      $exception_list: [{ type: "TypeError", value: "Application error", stacktrace: { type: "raw", frames: [{ lineno: 1, colno: 2, in_app: true, filename: "app:///application", function: "?", platform: "web:javascript" }] } }],
      $exception_level: "error", $process_person_profile: false, $geoip_disable: true, distinct_id: "diagnostics", token: "phc_fixture", $lib: "web", $lib_version: "1.439.2", surface: "web", deployment_environment: "production",
    } });
    expect(options.before_send({ event: "$pageview", properties: { $current_url: `${PORTAL_ORIGIN}/members/42` } })).toBeNull();
    // A second init on the same page keeps the one instance.
    initObservability({ hostname: PORTAL_HOST, automated: false });
    expect(diagnosticsInits()).toHaveLength(1);
  });

  it("keeps the demo analytics instance's gating untouched and tolerates a failed diagnostics init", async () => {
    posthog.default.init.mockImplementation((_token, _options, name) => {
      if (name === "diagnostics") throw new Error("blocked");
      return posthog.default;
    });
    const { initObservability, captureViewError } = await import("../src/lib/observability.js");
    initObservability({ hostname: PORTAL_HOST, automated: false });
    expect(captureViewError(new Error("x"))).toBe(false);
  });
});
