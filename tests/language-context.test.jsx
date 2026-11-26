import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

describe("language metadata", () => {
  it("keeps the document language synchronized with the selected UI language", async () => {
    const { rerender } = render(<LanguageProvider lang="es"><p>Contenido</p></LanguageProvider>);
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    rerender(<LanguageProvider lang="en"><p>Content</p></LanguageProvider>);
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });
});
