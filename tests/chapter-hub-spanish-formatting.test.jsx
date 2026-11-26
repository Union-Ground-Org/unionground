import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

const instant = "2026-07-27T14:00:00Z";
const thread = { id: "tamarack-thread", space_id: "tamarack-space", title: "Tamarack thread", kind: "issue", status: "open", posts: [{ id: "tamarack-post", body: "Tamarack message", created_at: instant }] };
const data = {
  member: { id: "tamarack-member", initials: "TM" }, roles: [],
  product: {
    spaces: [{ id: "tamarack-space", name: "Tamarack", visibility: "chapter", threads: [thread] }],
    documents: ["draft", "published", "archived", "tamarack-custom"].map((status, i) => ({ id: String(i), title: `Tamarack document ${i}`, document_type: "policy", version: 1, status })),
    intake: [{ id: "tamarack-intake", title: "Tamarack intake", category: "question", status: "new", created_at: instant }],
    records: [{ id: "tamarack-record", title: "Tamarack record", record_type: "decision", occurred_at: instant }],
    handshakes: [], governance: [], partnerOrgs: [],
  },
};
const show = (lang, value = data) => render(<LanguageProvider lang={lang}><ProductHubView data={value} /></LanguageProvider>);

describe("chapter hub reader-language formatting", () => {
  it.each(["en", "es"])("shows a singular thread and its Eastern post instant in %s", (lang) => {
    const { container } = show(lang);
    expect(screen.getByText(lang === "es" ? "1 hilo" : "1 thread")).toBeInTheDocument();
    expect(screen.getByText(lang === "es" ? "Problema · Abierto" : "Issue · Open")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tamarack thread/ }));
    const time = document.querySelector(".thread-message time");
    expect(time).toHaveAttribute("datetime", "2026-07-27T14:00:00.000Z");
    expect(time).toHaveTextContent(lang === "es" ? /27 jul 2026, 10:00 a\.\s*m\. ET/ : "Jul 27, 2026, 10:00 AM ET");
    expect(container.querySelector(".hub2-card__headmeta")).not.toHaveTextContent("threads");
    expect(thread.status).toBe("open");
  });

  it.each(["en", "es"])("keeps plural counts and translates resolved status in %s", (lang) => {
    show(lang, { ...data, product: { ...data.product, spaces: [{ ...data.product.spaces[0], threads: [thread, { ...thread, id: "tamarack-resolved", status: "resolved" }] }] } });
    expect(screen.getByText(lang === "es" ? "2 hilos" : "2 threads")).toBeInTheDocument();
    expect(screen.getByText(lang === "es" ? "Problema · Resuelto" : "Issue · Resolved")).toBeInTheDocument();
  });

  it("translates document statuses, keeps custom statuses, and formats intake and record times in Spanish", () => {
    show("es");
    fireEvent.click(screen.getByRole("button", { name: "Biblioteca", exact: true }));
    ["Borrador", "Publicado", "Archivado", "tamarack-custom"].forEach(label => expect(screen.getByText(`v1 · ${label}`)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Hazte escuchar", exact: true }));
    expect(document.querySelector(".hub2-thread time")).toHaveTextContent(/27 jul 2026, 10:00 a\.\s*m\. ET/);
    fireEvent.click(screen.getByRole("button", { name: "El registro", exact: true }));
    expect(document.querySelector(".hub2-tl time")).toHaveAttribute("datetime", "2026-07-27T14:00:00.000Z");
    expect(document.querySelector(".hub2-tl time")).toHaveTextContent(/27 jul 2026, 10:00 a\.\s*m\. ET/);
  });

  it("omits a malformed post instant instead of printing Invalid Date", () => {
    show("es", { ...data, product: { ...data.product, spaces: [{ ...data.product.spaces[0], threads: [{ ...thread, posts: [{ ...thread.posts[0], created_at: "invalid" }] }] }] } });
    fireEvent.click(screen.getByRole("button", { name: /Tamarack thread/ }));
    expect(document.querySelector(".thread-message time")).toBeNull();
    expect(document.body).not.toHaveTextContent("Invalid Date");
  });
});
