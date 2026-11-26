// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "vite";

let server;
let origin;

beforeAll(async () => {
  server = await createServer({
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server?.close();
});

describe("public route metadata in the actual Vite dev server", () => {
  it("serves route-specific HTML instead of landing metadata", async () => {
    const [landing, about, verify] = await Promise.all([
      fetch(`${origin}/`).then((response) => response.text()),
      fetch(`${origin}/about`).then((response) => response.text()),
      fetch(`${origin}/verify`).then((response) => response.text()),
    ]);

    // The landing is served from the unmodified index.html shell.
    const landingTitle = "<title>Union Ground</title>";
    expect(landing).toContain(landingTitle);
    expect(about).toContain("<title>About Union Ground</title>");
    // Union Ground has no public origin, so no canonical link is emitted.
    expect(about).not.toContain('rel="canonical"');
    expect(landing).not.toContain('rel="canonical"');
    expect(about).not.toContain(landingTitle);
    expect(verify).toContain("<title>Verify a vote receipt | Union Ground</title>");
    expect(verify).toContain('name="robots" content="noindex, nofollow, noarchive, noai, noimageai"');
  });
});
