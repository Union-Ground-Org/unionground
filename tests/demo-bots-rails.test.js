// @vitest-environment node
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, runScript } from "../demo-bots/run.mjs";
import { resolveDemoTarget } from "../demo-bots/target.mjs";

// Two loopback servers stand in for the app and for a backend the demo must
// never reach (a local Supabase stack listens on loopback too, so "it is only
// localhost" is not safe). The trap counts every connection it is offered.
let browser;
let app;
let trap;
let trapHost;
let trapConnections = 0;
let udpTrap;
let udpDatagrams = 0;

const listen = (server) => new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(server.address().port)));
const close = (server) => new Promise((closed) => { server.closeAllConnections(); server.close(closed); });

beforeAll(async () => {
  trap = createServer((_request, response) => response.end("reached the backend"));
  trap.on("connection", () => { trapConnections += 1; });
  trapHost = `127.0.0.1:${await listen(trap)}`;
  app = createServer((request, response) => {
    // 307 keeps the method and body, the way a redirected write would.
    if (request.url === "/hop") return response.writeHead(307, { location: `http://${trapHost}/rest/v1/votes` }).end();
    if (request.url === "/hop-twice") return response.writeHead(307, { location: "/hop" }).end();
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>app</title><main>app</main>");
  });
  await listen(app);
  udpTrap = createSocket("udp4");
  udpTrap.on("message", () => { udpDatagrams += 1; });
  await new Promise((bound) => udpTrap.bind(0, "127.0.0.1", bound));
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await close(app);
  await close(trap);
  udpTrap.close();
});

const drive = (run) => runScript(browser, resolveDemoTarget(`http://127.0.0.1:${app.address().port}`), { id: "T-RAILS", bot: "bot-01", covers: [], entry: "signin", run });

describe("demo bot network rails", () => {
  it("passes a page that stays on the app's origin", async () => {
    const result = await drive(async (ui) => { await ui.page.evaluate(() => fetch("/same-origin").then((response) => response.text())); });
    expect(result).toMatchObject({ ok: true });
    expect(trapConnections).toBe(0);
  });

  it.each([
    ["a direct request to another loopback port", (host) => fetch(`http://${host}/rest/v1/votes`, { method: "POST", body: "vote" }).catch(() => {})],
    ["a write the app's own origin redirects away", () => fetch("/hop", { method: "POST", body: "vote" }).catch(() => {})],
    ["a redirect that leaves on its second hop", () => fetch("/hop-twice", { method: "POST", body: "vote" }).catch(() => {})],
    ["a WebSocket to another loopback port", (host) => new Promise((settled) => {
      const socket = new WebSocket(`ws://${host}/realtime/v1/websocket`);
      socket.onopen = socket.onerror = socket.onclose = () => settled();
    })],
  ])("fails the script on %s and never lets it connect", async (_label, attempt) => {
    const result = await drive(async (ui) => { await ui.page.evaluate(attempt, trapHost); });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/off-origin/);
    expect(trapConnections).toBe(0);
  });

  // The proxy carries TCP only. A WebRTC STUN probe is UDP, so the browser's
  // launch policy has to keep it from being sent at all.
  it("keeps WebRTC from sending UDP past the proxy", async () => {
    await drive(async (ui) => {
      await ui.page.evaluate(async (port) => {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
        peer.createDataChannel("probe");
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise((settled) => {
          peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === "complete") settled(); };
          setTimeout(settled, 2000);
        });
        peer.close();
      }, udpTrap.address().port);
    });
    expect(udpDatagrams).toBe(0);
  });
});
