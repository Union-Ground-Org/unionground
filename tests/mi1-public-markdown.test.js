import { describe, expect, it } from "vitest";

import { sanitizePublicMarkdown } from "../src/lib/sanitizePublicMarkdown.js";

describe("public markdown sanitizer", () => {
  it("renders allowlisted marks and https links", () => {
    const html = sanitizePublicMarkdown([
      "# Welcome",
      "Visit [the chapter](https://app.example.org/chapters/boston-dds) for **office hours**.",
      "- First",
      "- Second",
    ].join("\n"));

    expect(html).toContain("<h2>Welcome</h2>");
    expect(html).toContain('<a href="https://app.example.org/chapters/boston-dds" rel="noopener noreferrer">the chapter</a>');
    expect(html).toContain("<strong>office hours</strong>");
    expect(html).toContain("<ul><li>First</li><li>Second</li></ul>");
    expect(sanitizePublicMarkdown("[Secure](HTTPS://example.org/path)")).toContain('href="HTTPS://example.org/path"');
    expect(sanitizePublicMarkdown("[Office (map)](https://example.org/place_(north))"))
      .toContain('href="https://example.org/place_(north)"');
  });

  it("escapes raw HTML and drops script or non-https targets", () => {
    const html = sanitizePublicMarkdown([
      "<script>alert(1)</script>",
      "Click [here](javascript:alert(1)) and <img src=x onerror=alert(1)>",
    ].join("\n"));

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("drops http: link targets as plain text", () => {
    const html = sanitizePublicMarkdown("Open [HTTP link](http://example.org/x)");

    expect(html).not.toContain("<a");
    expect(html).toContain("HTTP link");
    expect(html).not.toContain('href="http:');
  });

  it("drops data: link targets as plain text", () => {
    const html = sanitizePublicMarkdown("Open [data payload](data:text/html;base64,PHNjcmlwdD4=)");

    expect(html).not.toContain("<a");
    expect(html).toContain("data payload");
    expect(html).not.toContain('href="data:');
  });

  it("drops protocol-relative link targets as plain text", () => {
    const html = sanitizePublicMarkdown("Open [protocol-relative](//example.org/x)");

    expect(html).not.toContain("<a");
    expect(html).toContain("protocol-relative");
    expect(html).not.toContain('href="//');
  });

  it("drops vbscript: link targets as plain text", () => {
    const html = sanitizePublicMarkdown("Open [VBScript](vbscript:msgbox(1))");

    expect(html).not.toContain("<a");
    expect(html).toContain("VBScript");
    expect(html).not.toContain('href="vbscript:');
  });

  it("drops mixed-case javascript: link targets as plain text", () => {
    const html = sanitizePublicMarkdown("Open [mixed script](JaVaScRiPt:alert(1))");

    expect(html).not.toContain("<a");
    expect(html).toContain("mixed script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("JaVaScRiPt:");
    expect(html).not.toContain('href="');
  });

  it("escapes a quote embedded in an allowlisted https href", () => {
    const html = sanitizePublicMarkdown('[x](https://example.org/a"onmouseover=alert(1))');

    expect(html).toContain('href="https://example.org/a&quot;onmouseover=alert(1)"');
    expect(html).not.toContain('href="https://example.org/a"');
  });

  // TEST-UG-WALL-CLOCK-ICU-AND-WAITFOR-TEST-ASSERTIONS-20260920: this
  // assertion used a fixed 1,000 ms wall-clock cap, which proves nothing about
  // the guard. The call measures ~0.001 ms here, so the cap passed a
  // thousandfold regression in the scan while still being able to fail a
  // healthy runner that stalled for a second. The bound is measured instead:
  // the same sanitizer, in the same process, on a BENIGN document of
  // comparable size. A scan that backtracks over the malformed target costs orders of
  // magnitude more than that baseline (a naive alternation measures ~5 ms
  // against a ~0.002 ms baseline); the guard's unambiguous grammar rejects the
  // target outright and costs LESS than the baseline, because it renders
  // nothing. A stalled runner slows both measurements, so it cannot fail this.
  it("handles a long unterminated link target without pathological backtracking", () => {
    const tail = "(".repeat(25_000);
    const malformed = `[label](https://example.org/${tail}`;
    const benign = `[label](https://example.org/one) ${"word ".repeat(5_000)}`;

    // The fastest of several batched runs: a batch lifts one measurement above
    // the timer's resolution and the minimum drops scheduler noise.
    const fastest = (input) => {
      let best = Infinity;
      for (let trial = 0; trial < 5; trial += 1) {
        const started = performance.now();
        for (let run = 0; run < 20; run += 1) sanitizePublicMarkdown(input);
        best = Math.min(best, (performance.now() - started) / 20);
      }
      return best;
    };

    expect(sanitizePublicMarkdown(malformed)).toContain("[label]");
    const baseline = fastest(benign);
    expect(fastest(malformed)).toBeLessThan(baseline * 20);
  });
});
