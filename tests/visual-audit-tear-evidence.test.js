// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  appAssetPath,
  assetFailureBuilds,
  collectTearEvidence,
  describeRouteModuleFailure,
  failedDynamicImportUrl,
  observeAssetFailureBuild,
  readBuildInfoResponse,
  routeModuleBuildSha,
  routeModuleFailures,
} from "../scripts/lib/visual-audit-tear-evidence.mjs";

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const EVENTS_CHUNK = "https://app.example.org/assets/EventsView-bTDcyYUz.js";
const failure = (rule, message) => ({ rule, message, route: "/m/events", viewport: { width: 1440, height: 900 } });
const importError = (url) => failure("console-error", `Console error: TypeError: Failed to fetch dynamically imported module: ${url}`.slice(0, 120));

describe("visual audit tear evidence", () => {
  it("reads a build-info probe only from a direct no-store JSON 200, like the classifier", async () => {
    const url = "https://demo.example.com/build-info.json";
    const response = ({ status = 200, at = url, headers = {} } = {}) => ({
      status: () => status,
      url: () => at,
      headers: () => ({ "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, no-store", ...headers }),
      json: async () => ({ commitSha: NEW_SHA }),
    });
    await expect(readBuildInfoResponse(response(), url)).resolves.toEqual({ commitSha: NEW_SHA });
    for (const [label, bad] of [
      ["HTTP 404", response({ status: 404 })],
      ["HTTP 308", response({ status: 308 })],
      ["redirected", response({ at: "https://unionground.net/build-info.json" })],
      ["JSON", response({ headers: { "content-type": "text/html" } })],
      ["no-store", response({ headers: { "cache-control": "public, max-age=3600" } })],
    ]) {
      await expect(readBuildInfoResponse(bad, url), label).rejects.toThrow(label);
    }
    // An observation through a rejected probe stays unknown.
    await expect(observeAssetFailureBuild({ assetPath: "/assets/EventsView-bTDcyYUz.js", fetchBuildInfo: () => readBuildInfoResponse(response({ status: 404 }), url) }))
      .resolves.toEqual({ assetPath: "/assets/EventsView-bTDcyYUz.js", buildSha: null });
  });

  it("names the failed import a console message reports", () => {
    expect(failedDynamicImportUrl(`TypeError: Failed to fetch dynamically imported module: ${EVENTS_CHUNK}`)).toBe(EVENTS_CHUNK);
    expect(failedDynamicImportUrl("Failed to load resource: the server responded with a status of 404")).toBeNull();
    expect(failedDynamicImportUrl(null)).toBeNull();
  });

  it("pairs a failed route import with the 404 the runner recorded for the same asset", () => {
    const modules = routeModuleFailures({
      failedImportUrls: [EVENTS_CHUNK],
      runtimeFailures: [
        failure("http-error", "HTTP 404 app: /assets/sparkles-D86KJ0Ut.js"),
        failure("http-error", "HTTP 404 app: /assets/EventsView-bTDcyYUz.js"),
        importError(EVENTS_CHUNK),
      ],
    });
    expect(modules).toEqual([{ assetPath: "/assets/EventsView-bTDcyYUz.js", status: 404 }]);
    expect(describeRouteModuleFailure(modules[0])).toBe("Route module failed to load: /assets/EventsView-bTDcyYUz.js (HTTP 404)");
  });

  it("lists no module for a background 404, an import without a transport failure, or an upstream asset", () => {
    expect(routeModuleFailures({
      failedImportUrls: [],
      runtimeFailures: [failure("http-error", "HTTP 404 app: /assets/sparkles-D86KJ0Ut.js")],
    })).toEqual([]);
    expect(routeModuleFailures({ failedImportUrls: [EVENTS_CHUNK], runtimeFailures: [importError(EVENTS_CHUNK)] })).toEqual([]);
    expect(routeModuleFailures({
      failedImportUrls: [EVENTS_CHUNK],
      runtimeFailures: [failure("http-error", "HTTP 404 upstream: /assets/EventsView-bTDcyYUz.js")],
    })).toEqual([]);
    expect(routeModuleFailures({
      failedImportUrls: ["not a url"],
      runtimeFailures: [failure("http-error", "HTTP 404 app: /assets/EventsView-bTDcyYUz.js")],
    })).toEqual([]);
    expect(routeModuleFailures()).toEqual([]);
  });

  it("pairs a network failure and reports each asset once", () => {
    const tasks = "https://app.example.org/assets/TasksView-BG0cXD3e.js";
    const modules = routeModuleFailures({
      failedImportUrls: [tasks, tasks],
      runtimeFailures: [failure("network-error", "Network net::ERR_CONNECTION_RESET app: /assets/TasksView-BG0cXD3e.js")],
    });
    expect(modules).toEqual([{ assetPath: "/assets/TasksView-BG0cXD3e.js", errorText: "net::ERR_CONNECTION_RESET" }]);
    expect(describeRouteModuleFailure(modules[0]))
      .toBe("Route module failed to load: /assets/TasksView-BG0cXD3e.js (network net::ERR_CONNECTION_RESET)");
  });

  it("names only same-origin app assets for a build observation", () => {
    expect(appAssetPath(EVENTS_CHUNK, "https://app.example.org")).toBe("/assets/EventsView-bTDcyYUz.js");
    expect(appAssetPath(EVENTS_CHUNK, "https://other.example.org")).toBeNull();
    expect(appAssetPath("https://app.example.org/rest/v1/member_events", "https://app.example.org")).toBeNull();
    expect(appAssetPath("https://app.example.org/assets/photo.png", "https://app.example.org")).toBeNull();
    expect(appAssetPath("not a url", "https://app.example.org")).toBeNull();
  });

  it("observes the build at the moment an asset fails and keeps one build only when every route module agrees", async () => {
    const path = "/assets/EventsView-bTDcyYUz.js";
    await expect(observeAssetFailureBuild({ assetPath: path, fetchBuildInfo: async () => ({ commitSha: NEW_SHA }) }))
      .resolves.toEqual({ assetPath: path, buildSha: NEW_SHA });
    await expect(observeAssetFailureBuild({ assetPath: path, fetchBuildInfo: async () => { throw new Error("ECONNRESET"); } }))
      .resolves.toEqual({ assetPath: path, buildSha: null });
    await expect(observeAssetFailureBuild({ assetPath: path, fetchBuildInfo: async () => ({ commitSha: "short" }) }))
      .resolves.toEqual({ assetPath: path, buildSha: null });
    const modules = [{ assetPath: path, status: 404 }];
    expect(routeModuleBuildSha(modules, [{ assetPath: path, buildSha: NEW_SHA }])).toBe(NEW_SHA);
    // No observation, an unreadable one, a different asset's, or disagreeing ones: unknown.
    expect(routeModuleBuildSha(modules, [])).toBeNull();
    expect(routeModuleBuildSha(modules, [{ assetPath: path, buildSha: null }])).toBeNull();
    expect(routeModuleBuildSha(modules, [{ assetPath: "/assets/other-x.js", buildSha: NEW_SHA }])).toBeNull();
    const two = [...modules, { assetPath: "/assets/other-x.js", status: 404 }];
    expect(routeModuleBuildSha(two, [{ assetPath: path, buildSha: NEW_SHA }, { assetPath: "/assets/other-x.js", buildSha: SHA }])).toBeNull();
    expect(routeModuleBuildSha(two, [{ assetPath: path, buildSha: NEW_SHA }, { assetPath: "/assets/other-x.js", buildSha: NEW_SHA }])).toBe(NEW_SHA);
    expect(routeModuleBuildSha([], [{ assetPath: path, buildSha: NEW_SHA }])).toBeNull();
  });

  it("keeps one observation per failed asset, unknown unless every observation of it agrees", () => {
    const sparkles = "/assets/sparkles-D86KJ0Ut.js";
    const events = "/assets/EventsView-bTDcyYUz.js";
    const tasks = "/assets/TasksView-BG0cXD3e.js";
    expect(assetFailureBuilds([
      // Newer build first, proof build second (a rollback).
      { assetPath: sparkles, buildSha: NEW_SHA },
      { assetPath: events, buildSha: NEW_SHA },
      { assetPath: events, buildSha: NEW_SHA },
      { assetPath: sparkles, buildSha: SHA },
      { assetPath: tasks, buildSha: "short" },
      { buildSha: NEW_SHA },
      null,
    ])).toEqual([
      { assetPath: sparkles, buildSha: null },
      { assetPath: events, buildSha: NEW_SHA },
      { assetPath: tasks, buildSha: null },
    ]);
    // Proof build first, newer second: unknown as well, and an unreadable
    // observation among readable ones is unknown too.
    expect(assetFailureBuilds([{ assetPath: sparkles, buildSha: SHA }, { assetPath: sparkles, buildSha: NEW_SHA }]))
      .toEqual([{ assetPath: sparkles, buildSha: null }]);
    expect(assetFailureBuilds([{ assetPath: events, buildSha: NEW_SHA }, { assetPath: events, buildSha: null }, { assetPath: events, buildSha: NEW_SHA }]))
      .toEqual([{ assetPath: events, buildSha: null }]);
    expect(assetFailureBuilds()).toEqual([]);
  });

  it("records the refused document's marker and the live build at failure, trusting neither", async () => {
    const error = Object.assign(new Error("Loaded main document is not bound to the expected build SHA"), { receivedDocumentSha: NEW_SHA });
    const fetchBuildInfo = vi.fn(async () => ({ commitSha: NEW_SHA, builtAt: "2026-10-11T12:00:00.000Z" }));
    await expect(collectTearEvidence({ error, expectedSha: SHA, fetchBuildInfo }))
      .resolves.toEqual({ receivedDocumentSha: NEW_SHA, liveBuildSha: NEW_SHA });
    expect(fetchBuildInfo).toHaveBeenCalledTimes(1);
  });

  it("records null for an unreadable build-info, a malformed marker, or a failure without a refused document", async () => {
    await expect(collectTearEvidence({
      error: new Error("locator.waitFor: Timeout 30000ms exceeded."),
      expectedSha: SHA,
      fetchBuildInfo: async () => { throw new Error("ECONNRESET"); },
    })).resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
    await expect(collectTearEvidence({
      error: Object.assign(new Error("unbound"), { receivedDocumentSha: "abc" }),
      expectedSha: SHA,
      fetchBuildInfo: async () => ({ commitSha: "not-a-sha" }),
    })).resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
    await expect(collectTearEvidence({ error: new Error("x"), expectedSha: SHA, fetchBuildInfo: async () => "garbage" }))
      .resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
    await expect(collectTearEvidence({ error: new Error("x"), expectedSha: SHA }))
      .resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
  });

  it("collects nothing in fixture mode or without an expected SHA", async () => {
    const fetchBuildInfo = vi.fn(async () => ({ commitSha: NEW_SHA }));
    const error = Object.assign(new Error("unbound"), { receivedDocumentSha: NEW_SHA });
    await expect(collectTearEvidence({ error, expectedSha: SHA, fixture: true, fetchBuildInfo }))
      .resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
    await expect(collectTearEvidence({ error, expectedSha: "", fetchBuildInfo }))
      .resolves.toEqual({ receivedDocumentSha: null, liveBuildSha: null });
    expect(fetchBuildInfo).not.toHaveBeenCalled();
  });
});
