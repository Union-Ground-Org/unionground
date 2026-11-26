// The one place a demo bot learns where the app is.
//
// The earlier bot kit this is adapted from signed in to real backends, so its
// guard had to tell SAMPLE from production. Demo bots never sign in and never
// reach a backend: they open `/m?demo=1`, whose writes are stubbed in the
// browser. That makes the rule simple enough to have no exceptions — the app
// must be served from this machine. A hosted deployment, even a Union Ground
// one, is refused, because a bot that clicked "Exit demo" there would be on a
// real sign-in screen.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveDemoTarget(input) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    throw new Error("Demo bots need an absolute http://127.0.0.1:<port> base URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Demo bots refuse the ${url.protocol} scheme.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Demo bots run only against a loopback app, not ${url.hostname}.`);
  }
  if (url.username || url.password) {
    throw new Error("Demo bots refuse a base URL that carries credentials.");
  }
  // host is always host:port, so a proxy bypass rule built from it can never
  // widen to every port on the machine when the URL uses the scheme's default.
  const host = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
  return { origin: url.origin, host, demoUrl: new URL("/m?demo=1", url.origin).href };
}

// Every request a demo page makes must stay on the app's own origin. Demo mode
// has no backend, so a request anywhere else is a regression (a write that
// escaped its stub, a third-party script) and fails the run.
export function isAllowedRequest(requestUrl, origin) {
  try {
    const url = new URL(requestUrl);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    return url.origin === origin;
  } catch {
    return false;
  }
}
