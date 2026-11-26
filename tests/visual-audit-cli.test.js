// @vitest-environment node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const packagePath = new URL("../package.json", import.meta.url);
const presetsPath = new URL("../scripts/visual-audit-presets.mjs", import.meta.url);
const runnerPath = new URL("../scripts/visual-audit-runner.mjs", import.meta.url);
const routeContractsPath = new URL("../scripts/visual-audit-route-contracts.mjs", import.meta.url);
const execFile = promisify(execFileCallback);
const projectDirectory = new URL("..", import.meta.url);

async function runRunner(args, env) {
  try {
    const result = await execFile(process.execPath, [runnerPath.pathname, ...args], {
      cwd: projectDirectory.pathname,
      env: { ...process.env, ...env },
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

async function startRouteServer() {
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname === "/m/numbers") {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><h1>Ready</h1><div class="home-orb"></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startRuntimeBoundaryServer({
  bootstrapFails = false,
  targetFails = false,
  delayedSelectorWithLateStewardFailure = false,
  includeStewardDeskRpcs = true,
  persistPersona = false,
  missingStewardBatchAt = 0,
  failedRpc = null,
}) {
  let surfaceVisits = 0;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname.startsWith("/rest/v1/rpc/")) {
      const failed = pathname === `/rest/v1/rpc/${failedRpc}`;
      response.writeHead(failed ? 500 : 200, { "content-type": "application/json" });
      response.end(failed ? JSON.stringify({ code: "57014", message: "protected upstream detail" }) : "[]");
      return;
    }
    if (pathname === "/runtime/bootstrap") {
      setTimeout(() => {
        response.writeHead(bootstrapFails ? 500 : 200, { "content-type": "text/plain" });
        response.end(bootstrapFails ? "bootstrap timeout" : "ready");
      }, 200);
      return;
    }
    if (pathname === "/runtime/target") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("target timeout");
      return;
    }
    if (pathname === "/runtime/late-steward") {
      setTimeout(() => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("late steward timeout");
      }, 250);
      return;
    }
    if (pathname === "/m") surfaceVisits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <style>
        body { margin: 0; min-height: 100vh; font-family: sans-serif; }
        nav { display: block; height: 56px; background: #174b3a; }
        select, button { min-width: 120px; min-height: 48px; margin: 16px; }
        main { min-height: 500px; padding: 24px; }
        .demo-welcome-layer { position: fixed; inset: 0; z-index: 2; background: white; }
      </style>
      <nav class="desktop-rail"></nav>
      ${delayedSelectorWithLateStewardFailure ? '<button class="desktop-rail__hat-option" aria-pressed="true">Steward</button>' : ""}
      <select aria-label="Hat"${delayedSelectorWithLateStewardFailure ? ' style="display: none"' : ""}>
        <option value="steward" selected>Steward</option>
        <option value="member">Member</option>
      </select>
      <section class="screen cwk-screen"><div id="desk"><div class="cwk-alert">Loading</div></div></section>
      <main class="screen screen--today home"><h1>Member Home</h1></main>
      <div class="demo-welcome-layer">
        <div class="demo-welcome__actions"><button class="dialog-primary">Continue</button></div>
      </div>
      <script>
        const selector = document.querySelector('select');
        selector.value = ${persistPersona} ? localStorage.getItem('visual-test.persona') || 'steward' : 'steward';
        if (selector.value === 'steward') Promise.all([
          fetch('/runtime/bootstrap'),
          ${includeStewardDeskRpcs && surfaceVisits !== missingStewardBatchAt ? `...${JSON.stringify([
            "list_steward_requests",
            "list_steward_conversations",
            "list_steward_broadcasts",
            "list_steward_forms",
            "get_steward_desk_kpis",
          ])}.map((rpc) => fetch('/rest/v1/rpc/' + rpc, { method: 'POST' }))` : ""}
        ]).then(([response]) => {
          document.querySelector('#desk').innerHTML = response.ok
            ? '<div class="pkpi-grid">Ready</div>'
            : '<div class="cwk-alert"><button class="cwk-btn cwk-btn--green">Try again</button></div>';
        });
        else document.querySelector('.cwk-screen').remove();
        ${delayedSelectorWithLateStewardFailure ? `
          setTimeout(() => { fetch('/runtime/late-steward?member=protected'); }, 250);
          setTimeout(() => { document.querySelector('select').style.display = 'block'; }, 400);
        ` : ""}
        document.querySelector('.dialog-primary').addEventListener('click', () => {
          document.querySelector('.demo-welcome-layer').remove();
        });
        document.querySelector('select').addEventListener('change', () => {
          if (${persistPersona}) localStorage.setItem('visual-test.persona', selector.value);
          ${targetFails ? "fetch('/runtime/target?member=protected');" : ""}
        });
        window.addEventListener('popstate', () => {
          const main = document.querySelector('main');
          main.className = location.pathname === '/m/events' ? 'screen mevents' : 'screen screen--today home';
          main.querySelector('h1').textContent = location.pathname === '/m/events' ? 'Member Events' : 'Member Home';
        });
      </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("visual audit preview CLI contract", () => {
  it("prints the actual failed RPC tuple while retaining the failure exit and excluding response bodies", async () => {
    const server = await startRuntimeBoundaryServer({ failedRpc: "get_steward_desk_kpis" });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-rpc-diagnostic-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));
      expect(result.code).toBe(1);
      expect(report.status).toBe("failed");
      expect(result.stderr).toMatch(/FAIL steward-desk-rpc \/m 768x1024 rpc=get_steward_desk_kpis http=500 sqlstate=57014 durationMs=\d+ outcome=http-failed/);
      expect(result.stderr).not.toContain("protected upstream detail");
      expect(report.surfaces.every((surface) => surface.initialStewardDeskBatch.status === "failed")).toBe(true);
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);
  it("exposes preview and controlled-fixture commands", async () => {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "test:visual": "node scripts/visual-audit-runner.mjs",
      "test:visual:fixture": "node scripts/visual-audit-runner.mjs --fixture",
    });
  });

  it("audits the complete demo route and viewport matrix with durable artifacts", async () => {
    const presets = await readFile(presetsPath, "utf8");
    const runner = await readFile(runnerPath, "utf8");
    const routeContracts = await readFile(routeContractsPath, "utf8");
    const selectHatSource = runner.slice(
      runner.indexOf("async function selectHat"),
      runner.indexOf("async function selectMemberHat"),
    );

    expect(presets).not.toContain('name: "phone"');
    expect(presets).toContain('name: "tablet", width: 768, height: 1024');
    expect(presets).toContain('name: "desktop", width: 1280, height: 900');
    expect(presets).toContain('name: "wide", width: 1440, height: 900');
    expect(runner).toContain('resolveVisualAuditViewports();');
    for (const route of ["/m", "/m/events", "/m/numbers", "/m/voice", "/m/rights", "/m/messages", "/m/cases", "/m/tasks"]) {
      expect(routeContracts).toContain(`"${route}"`);
    }
    expect(runner).toContain('url.searchParams.set("demo", "1")');
    expect(runner).toContain('page.locator("button.demo-hat-selector__trigger")');
    expect(runner).toContain('page.locator("button.demo-hat-selector__option")');
    expect(selectHatSource).toContain("await page.waitForURL");
    expect(selectHatSource).toContain("await waitForAuditShell(page)");
    expect(selectHatSource.indexOf("await waitForAuditShell(page)"))
      .toBeGreaterThan(selectHatSource.indexOf("await page.waitForURL"));
    expect(runner).not.toContain("desktop-rail__hat-menu-trigger");
    expect(runner).toContain('await selectHat(page, "coordinator", "Coordinator", "/m/coordinator", restartTargetRuntimeCapture)');
    expect(runner).toContain("window.__ugPendingDeviceParity=[['app.selectedStaffHat','steward']]");
    expect(runner).toContain("await dismissWelcome(page)");
    expect(runner).toContain("await waitForStableSurface(page, { expectWelcome: false })");
    expect(runner).toContain("await selectMemberHat(page, restartTargetRuntimeCapture)");
    expect(runner).toContain("createTargetRuntimeBoundary()");
    expect(runner).toContain('page.on("request", (request) => runtimeBoundary.trackRequest(request))');
    expect(runner).toContain("runtimeBoundary.belongsToCurrentTarget(response.request())");
    expect(runner).toContain("isGenericResourceConsoleError(message.text())");
    expect(runner).toContain('page.on("requestfailed", (request) => {');
    expect(runner).toContain("describeRuntimeNetworkFailure({");
    expect(runner).toContain("await selectMemberHat(page, restartTargetRuntimeCapture)");
    expect(runner).toContain("await selectCoordinatorHat(page, restartTargetRuntimeCapture)");
    expect(runner).toContain("beforeSelectionAttempt: restartTargetRuntimeCapture");
    expect(runner).toContain("afterSelectionAttemptFailure: restartTargetRuntimeCapture");
    expect(runner).toContain("await assertSelectedHat(page, contract.hat, contract.hatLabel)");
    expect(runner).toContain("await navigateWithinSelectedHat(page, url, route)");
    expect(runner).toContain('globalThis.history.pushState({}, "", target)');
    expect(runner).toContain('globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"))');
    expect(runner).toContain("await assertRouteContract(page, currentRoute)");
    expect(runner).toContain("page.locator('a[href^=\"/m/tasks\"]')");
    expect(runner).toContain('page.locator("button.gq-action").first().click()');
    expect(runner).not.toContain('getByRole("button", { name: "Chapter work", exact: true })');
    expect(runner).toContain("/build-info.json");
    expect(runner).toContain('headers: { "cache-control": "no-store" }');
    expect(runner).toContain("assertLoadedBuildDocument({");
    expect(runner).toContain("request.isNavigationRequest()");
    expect(runner).toContain("request.frame() !== page.mainFrame()");
    expect(runner).toContain("response.body()");
    expect(runner).toContain('response.headerValue("content-type")');
    expect(runner).toContain("documentSha: documentProof?.sha ?? null");
    expect(runner).toContain("documentProof = await navigateToAuditSurface(page, url, currentRoute, restartTargetRuntimeCapture)");
    expect(runner).toContain("finally {");
    expect(runner).toContain('"visual-audit.json"');
    expect(runner).toContain('"visual-audit.md"');
    expect(runner).toContain("FIXTURE_EXPECTED_RULES");
    expect(runner).toContain("process.exitCode = failed ? 1 : 0");
  });

  it("pins every default route to its explicit hat and unique visible landmark", async () => {
    const { DEFAULT_VISUAL_AUDIT_ROUTES, visualAuditRouteContract } = await import(routeContractsPath.href);
    const expected = {
      "/m": { hat: "member", hatLabel: "Member", landmark: ".screen.screen--today.home" },
      "/m/events": { hat: "member", hatLabel: "Member", landmark: ".screen.mevents" },
      "/m/numbers": { hat: "member", hatLabel: "Member", landmark: '.screen.screen--reports, .qsg-banner[data-quarterly-gate="locked"]' },
      "/m/voice": { hat: "member", hatLabel: "Member", landmark: ".screen.bevoice-screen" },
      "/m/rights": { hat: "member", hatLabel: "Member", landmark: ".screen.learn-screen" },
      "/m/messages": { hat: "member", hatLabel: "Member", landmark: ".screen.inbox-screen" },
      "/m/cases": { hat: "member", hatLabel: "Member", landmark: ".screen.mcases" },
      "/m/tasks": { hat: "coordinator", hatLabel: "Coordinator", landmark: ".screen.tasks-screen" },
    };

    expect(DEFAULT_VISUAL_AUDIT_ROUTES).toEqual(Object.keys(expected));
    expect(new Set(Object.values(expected).map(({ landmark }) => landmark)).size).toBe(8);
    for (const [route, contract] of Object.entries(expected)) {
      expect(visualAuditRouteContract(route)).toEqual({ route, ...contract });
    }
    expect(visualAuditRouteContract("/m/admin")).toBeNull();
  });

  it("passes fixture mode only when its known rule set is observed", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-fixture-"));
    try {
      const result = await execFile(process.execPath, [runnerPath.pathname, "--fixture"], {
        cwd: projectDirectory.pathname,
        env: { ...process.env, VISUAL_AUDIT_ARTIFACT_DIR: artifactDir },
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.stdout).toContain("VISUAL_AUDIT_STATUS=passed");
      expect(report.status).toBe("passed");
      expect(new Set(report.failures.map((item) => item.rule))).toEqual(new Set([
        "small-target", "element-collision", "clipped-interactive", "dialog-viewport", "fixed-obstruction",
      ]));
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("waits for the wrong-hat bootstrap before selecting Member", async () => {
    const server = await startRuntimeBoundaryServer({ bootstrapFails: false, targetFails: false });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-bootstrap-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(0);
      expect(report.status).toBe("passed");
      expect(report.surfaces).toHaveLength(3);
      expect(report.failures).toEqual([]);
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it.each([false, true])("BUG-UG-VISUAL-AUDIT-PERSONA-RESTORE-20260907 isolates restored personas across the route/viewport matrix and retains later-surface bootstrap failures (missing=%s)", async (missing) => {
    const server = await startRuntimeBoundaryServer({ persistPersona: true, missingStewardBatchAt: missing ? 2 : 0 });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-persistent-persona-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m,/m/events",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));
      expect(result.code).toBe(missing ? 1 : 0);
      expect(report.surfaces).toHaveLength(6);
      expect(report.failures).toHaveLength(missing ? 1 : 0);
      const viewportNames = ["tablet", "desktop", "wide"];
      for (const [index, surface] of report.surfaces.entries()) {
        const failed = missing && index === 1;
        expect(surface.route).toBe(index % 2 === 0 ? "/m" : "/m/events");
        expect(surface.viewport.name).toBe(viewportNames[Math.floor(index / 2)]);
        expect(surface.routeContract.hat).toBe("member");
        expect(surface.initialStewardDeskBatch.status).toBe(failed ? "failed" : "passed");
        expect(surface.initialStewardDeskBatch.calls).toHaveLength(5);
        for (const call of surface.initialStewardDeskBatch.calls) {
          expect(call).toMatchObject({ attempts: failed ? 0 : 1, outcome: failed ? "missing" : "passed" });
        }
      }
      if (missing) expect(report.failures[0]).toMatchObject({ route: "/m/events", rule: "steward-desk-performance" });
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 60000);

  it("fails when the Steward shell renders without any mandatory desk RPC", async () => {
    const server = await startRuntimeBoundaryServer({ includeStewardDeskRpcs: false });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-missing-steward-rpcs-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(1);
      expect(report.status).toBe("failed");
      expect(report.surfaces).toHaveLength(3);
      expect(report.failures).toHaveLength(3);
      expect(report.failures.every(({ rule }) => rule === "steward-desk-performance")).toBe(true);
      for (const surface of report.surfaces) {
        expect(surface.initialStewardDeskBatch).toMatchObject({ status: "failed", thresholdMs: 8000 });
        expect(surface.initialStewardDeskBatch.calls).toHaveLength(5);
        expect(surface.initialStewardDeskBatch.calls.every(({ attempts, outcome }) => attempts === 0 && outcome === "missing")).toBe(true);
        expect(surface.failures.filter(({ rule }) => rule === "steward-desk-performance")).toHaveLength(1);
      }
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("records the live Steward RPC proof as not applicable for an explicit credential-free loopback preview", async () => {
    const server = await startRuntimeBoundaryServer({ includeStewardDeskRpcs: false });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-credential-free-preview-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
        VISUAL_AUDIT_STEWARD_DESK_PROOF: "credential-free-preview",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(0);
      expect(report.status).toBe("passed");
      expect(report.surfaces).toHaveLength(3);
      expect(report.failures).toEqual([]);
      for (const surface of report.surfaces) {
        expect(surface.initialStewardDeskBatch).toEqual({
          status: "not-applicable",
          reason: "credential-free-preview",
        });
      }
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("does not assign a late Steward request to Member while the hat control repaints", async () => {
    const server = await startRuntimeBoundaryServer({ delayedSelectorWithLateStewardFailure: true });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-delayed-selector-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(0);
      expect(report.status).toBe("passed");
      expect(report.failures).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("member=protected");
      expect(JSON.stringify(report)).not.toContain("late steward timeout");
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("fails explicitly when the required initial Steward desk cannot load", async () => {
    const server = await startRuntimeBoundaryServer({ bootstrapFails: true, targetFails: false });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-bootstrap-failure-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(1);
      expect(report.status).toBe("failed");
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          route: "/m",
          rule: "http-error",
          message: "HTTP 500 app: /runtime/bootstrap",
        }),
      ]));
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("fails on a request started by the selected Member without leaking its query", async () => {
    const server = await startRuntimeBoundaryServer({ bootstrapFails: false, targetFails: true });
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-runtime-target-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "3000",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(1);
      expect(report.status).toBe("failed");
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: "http-error",
          message: "HTTP 500 app: /runtime/target",
        }),
      ]));
      expect(JSON.stringify(report)).not.toContain("member=protected");
      expect(JSON.stringify(report)).not.toContain("bootstrap timeout");
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("skips deployment-SHA verification in controlled fixture mode", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-fixture-sha-"));
    try {
      const result = await runRunner(["--fixture"], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_EXPECTED_SHA: "must-not-be-fetched-for-a-file-fixture",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(result.code).toBe(0);
      expect(report.status).toBe("passed");
      expect(report.failures.map((item) => item.rule)).not.toContain("runner-error");
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("continues auditing later routes and viewports after a failed route", async () => {
    const server = await startRouteServer();
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-route-recovery-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "250",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));
      const failedRoute = report.surfaces.find((surface) => surface.viewport.name === "tablet" && surface.route === "/m/numbers");

      expect(result.code).toBe(1);
      expect(report.status).toBe("failed");
      expect(failedRoute).toMatchObject({
        url: `${server.baseUrl}/m/numbers?demo=1`,
        diagnostic: { error: expect.any(String) },
      });
      expect(report.surfaces).toEqual(expect.arrayContaining([
        expect.objectContaining({ viewport: expect.objectContaining({ name: "tablet" }), route: "/m/voice" }),
        expect.objectContaining({ viewport: expect.objectContaining({ name: "wide" }), route: "/m/tasks" }),
      ]));
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/m/numbers", rule: "route-error" }),
      ]));
      expect(failedRoute.failureScreenshot).toEqual(expect.any(String));
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("audits the caller's routes when VISUAL_AUDIT_ROUTES names them", async () => {
    const server = await startRouteServer();
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-route-override-"));
    try {
      // Same short route timeout the recovery case uses: this asserts which
      // routes the runner walks, not whether a stub surface can settle, and
      // the stub's zero-size shell never satisfies the visibility wait.
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m/admin, /m/rewards",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "250",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(report.routes).toEqual([`${server.baseUrl}/m/admin?demo=1`, `${server.baseUrl}/m/rewards?demo=1`]);
      expect([...new Set(report.surfaces.map((surface) => surface.route))]).toEqual(["/m/admin", "/m/rewards"]);
      // The override replaces the default eight rather than extending them, so
      // a caller auditing the admin console never silently re-audits /m/cases.
      expect(report.surfaces.map((surface) => surface.route)).not.toContain("/m/cases");
      expect(result.code).toBe(1);
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("can audit a SAMPLE host without appending ?demo=1", async () => {
    const server = await startRouteServer();
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-sample-host-"));
    try {
      const result = await runRunner([], {
        VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
        VISUAL_AUDIT_BASE_URL: server.baseUrl,
        VISUAL_AUDIT_ROUTES: "/m/admin, /m/rewards",
        VISUAL_AUDIT_APPEND_DEMO: "0",
        VISUAL_AUDIT_ROUTE_TIMEOUT_MS: "250",
      });
      const report = JSON.parse(await readFile(join(artifactDir, "visual-audit.json"), "utf8"));

      expect(report.routes).toEqual([`${server.baseUrl}/m/admin`, `${server.baseUrl}/m/rewards`]);
      expect(result.code).toBe(1);
    } finally {
      await server.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses a VISUAL_AUDIT_ROUTES value that names no usable route", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "visual-audit-route-invalid-"));
    try {
      for (const [value, message] of [
        [" , ", "must name at least one route"],
        ["/m/admin,m/rewards", "must be same-origin absolute paths"],
        ["//example.invalid/audit", "must be same-origin absolute paths"],
        ["/\\\\example.invalid/audit", "must be same-origin absolute paths"],
      ]) {
        const result = await runRunner([], {
          VISUAL_AUDIT_ARTIFACT_DIR: artifactDir,
          VISUAL_AUDIT_ROUTES: value,
        });

        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(message);
      }
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30000);
});
