// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractKnowledgeText, extractKnowledgeTextInProcess, resolveKnowledgeConverter } from "../api/_lib/knowledgeIngest.js";

const extract = (rtf) => extractKnowledgeTextInProcess(Buffer.from(rtf, "latin1"), "policy.rtf", "application/rtf");

describe("RTF substantive character extraction", () => {
  it("preserves escaped digits, accents and Windows punctuation in policy text", async () => {
    await expect(extract(String.raw`{\rtf1\ansi\ansicpg1252 Pay \'31\'30\'30 dollars. Caf\'e9. \'93Yes\'94 \'80}`))
      .resolves.toBe('Pay 100 dollars. Café. “Yes” €');
  });

  it("preserves the policy text through the production worker boundary", async () => {
    await expect(extractKnowledgeText(Buffer.from(String.raw`{\rtf1\ansi Pay \'31\'30\'30 dollars. Caf\u233?}`), "policy.rtf", "application/rtf", {
      signal: AbortSignal.timeout(5_000),
    })).resolves.toBe("Pay 100 dollars. Café");
  });

  it("decodes raw ANSI bytes and preserves escaped delimiters", async () => {
    await expect(extract("{\\rtf1\\ansi Café \\{policy\\} \\\\ text}"))
      .resolves.toBe("Café {policy} \\ text");
  });

  it("decodes signed Unicode, hex fallbacks, surrogate pairs and group-scoped uc counts", async () => {
    await expect(extract(String.raw`{\rtf1\ansi A\u233\'e9 {\uc2\u915??} \uc0\u945 \uc1\u-10179?\u-8704? \u946? done}`))
      .resolves.toBe("Aé Γ α😀 β done");
  });

  it("counts control symbols and control words as one fallback and ends fallback at braces", async () => {
    await expect(extract(String.raw`{\rtf1\uc1\u233\~ \u945\tab {\uc2\u946?}after}`))
      .resolves.toBe("é αβafter");
  });

  it("keeps visible text and line controls while skipping metadata, starred and binary destinations", async () => {
    await expect(extract(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\info hidden}{\*\unknown private}Pay \b 100\b0\par Next\tab cell.{\pict\bin4 {}\\}End.}`))
      .resolves.toBe("Pay 100\nNext cell.End.");
  });

  it("resets the active font and preserves text controls, nonbreaking punctuation and source line wrapping", async () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset128 Unused;}}\deff0\f1\plain Pay\~100\_dollars\emdash\lquote yes\rquote\line Caf\'e9.}`;
    await expect(extract(rtf.replace("Pay", "\r\nPay"))).resolves.toBe("Pay\u00a0100‑dollars—‘yes’\nCafé.");
  });

  it("refuses an undefined Windows byte and a selected font's unsupported code page", async () => {
    await expect(extract(String.raw`{\rtf1\ansi Bad \'81}`)).rejects.toThrow("knowledge-rtf-encoding-unsupported");
    await expect(extract(String.raw`{\rtf1{\fonttbl{\f1\cpg932 Other;}}\f1 Text}`)).rejects.toThrow("knowledge-rtf-encoding-unsupported");
  });

  it.each([String.raw`{\rtf1\ansicpg932 text}`, String.raw`{\rtf1\mac text}`,
    String.raw`{\rtf1\ansi{\fonttbl{\f1\fcharset128 Japanese;}}\f1 text}`])("refuses unsupported encoding rather than corrupting text: %s", async (rtf) => {
    await expect(extract(rtf)).rejects.toThrow("knowledge-rtf-encoding-unsupported");
  });

  it.each([String.raw`{\rtf1 bad \'xx}`, String.raw`{\rtf1\uc-1 bad}`, String.raw`{\rtf1\u999999?}`,
    String.raw`{\rtf1\bin99 short}`, "{\\rtf1 unclosed", "{\\rtf1 text}}"])("refuses malformed character or group data: %s", async (rtf) => {
    await expect(extract(rtf)).rejects.toThrow("knowledge-rtf-invalid");
  });

  it("bounds nesting and retains an identifiable converter version", async () => {
    await expect(extract("{\\rtf1 " + "{".repeat(300) + "text" + "}".repeat(301)))
      .rejects.toThrow("knowledge-rtf-too-deep");
    expect(resolveKnowledgeConverter("policy.rtf", "")).toMatchObject({ converterVersion: "2", pipelineVersion: "2026.10.23" });
  });
});
