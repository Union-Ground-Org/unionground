import { vi } from "vitest";
// Component regressions opt into isolated test adapters. Product builds never
// import these retired fixture modules or expose a fixture bootstrap path.
vi.mock('../src/lib/demoVoiceParity.js', () => import('./fixtures/retired-pre-bot/src/lib/demoVoiceParity.js'));
vi.mock('../src/lib/demoCampaigns.js', () => import('./fixtures/retired-pre-bot/src/lib/demoCampaigns.js'));
vi.mock('../src/features/organizationIntelligence/preview.js', () => import('./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js'));
vi.mock('../src/features/learningContent/preview.js', () => import('./fixtures/retired-pre-bot/src/features/learningContent/preview.js'));

// The DOM half (jest-dom, Testing Library cleanup, every language, the primed
// demo data and the per-test state resets) only serves files that render, so
// node-environment files (most of the suite) skip it and its imports.
if (typeof document !== "undefined") await import("./helpers/browser-setup.js");
// jsdom 31 runs the HTML focus fixup on a rendering timer, which made focus
// checks race a slow runner. Off for every DOM test, as under jsdom 29; a test
// that proves a product keeps focus turns it on with enableFocusFixup()
// (tests/helpers/focusFixup.js). Throws if jsdom renames the hook.
if (typeof document !== "undefined") (await import("./helpers/focusFixup.js")).disableFocusFixup();

// Node 24 exposes Undici's WebSocket globally. In jsdom that implementation
// dispatches Node Event instances after jsdom has installed its own Event
// constructor, so any unit test that mounts a Supabase realtime subscriber can
// finish with an unrelated ERR_INVALID_ARG_TYPE. Browser behavior is covered by
// the realtime browser journeys; unit tests use an inert transport so they
// cannot open sockets to a configured SAMPLE backend.
class InertTestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = InertTestWebSocket.CONNECTING;
  OPEN = InertTestWebSocket.OPEN;
  CLOSING = InertTestWebSocket.CLOSING;
  CLOSED = InertTestWebSocket.CLOSED;
  readyState = InertTestWebSocket.CONNECTING;
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  binaryType = "blob";
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor(url) {
    this.url = String(url);
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
  send() {}
  close() { this.readyState = InertTestWebSocket.CLOSED; }
}

Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  writable: true,
  value: InertTestWebSocket,
});
